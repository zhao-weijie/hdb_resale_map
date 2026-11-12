import type { ConvexClient } from 'convex/browser';
import { getDocumentSize } from 'convex/values';
import { convexTest } from 'convex-test';
import { expect, test, vi } from 'vitest';
import { applyBackup, backupFileHash, discardBackup, exportBackup, exportCsv, inspectBackup } from '../src/listings/backupFiles';
import { readTrackerFile } from '../src/listings/imports';
import { api, internal } from './_generated/api';
import { restoreIdleMs } from './backupSchema';
import schema from './schema';
import { defaultTrackerView, limits } from './trackerModel';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const id = () => crypto.randomUUID();

function restoreFixture() {
    const app = convexTest(schema, modules);
    const owner = app.withIdentity({ subject: 'buyer|session', issuer: 'https://tracker.test' });
    const other = app.withIdentity({ subject: 'other|session', issuer: 'https://tracker.test' });
    const now = Date.now();
    const request = {
        restoreKey: id(), fileHash: 'a'.repeat(64), expectedCount: 2,
        header: { name: 'Backup', trackerView: defaultTrackerView, collectionPublicId: id(), contentRevision: 0, createdAt: now, exportedAt: now },
    };
    return { app, owner, other, request };
}

test('restore staging rejects oversized declarations and non-JSON values and counts new bytes exactly once', async () => {
    const { app, owner, request } = restoreFixture();
    await expect(owner.mutation(api.backups.beginRestore, { ...request, expectedCount: 50_001 })).rejects.toThrow(/50,000-record/);
    const { collectionId } = await owner.mutation(api.backups.beginRestore, request);
    const first = { table: 'candidates' as const, payload: { publicId: id(), customValues: [] } };
    const second = { table: 'candidates' as const, payload: { publicId: id(), customValues: [] } };
    await expect(owner.mutation(api.backups.uploadPage, {
        collectionId, offset: 0, rows: [{ ...first, payload: { ...first.payload, bytes: new ArrayBuffer(32) } }],
    })).rejects.toThrow(/only JSON values/);
    await expect(owner.mutation(api.backups.uploadPage, {
        collectionId, offset: 0, rows: [{ ...first, payload: { ...first.payload, oversized: 'x'.repeat(1024 * 1024) } }],
    })).rejects.toThrow(/One backup record exceeds/);

    const upload = { collectionId, offset: 0, rows: [first] };
    expect((await owner.mutation(api.backups.uploadPage, upload)).receivedCount).toBe(1);
    const nearLimit = 64 * 1024 * 1024 - 1;
    await app.run(async ctx => {
        const session = await ctx.db.query('backupRestores').withIndex('by_collectionId', q => q.eq('collectionId', collectionId)).unique();
        const row = await ctx.db.query('backupRestoreItems').withIndex('by_collectionId_and_ordinal', q => q.eq('collectionId', collectionId)).first();
        expect(session?.receivedBytes).toBe(getDocumentSize(row!));
        await ctx.db.patch(session!._id, { receivedBytes: nearLimit });
    });
    expect((await owner.mutation(api.backups.uploadPage, upload)).receivedCount).toBe(1);
    await expect(owner.mutation(api.backups.uploadPage, { ...upload, rows: [first, second] })).rejects.toThrow(/64 MiB restore limit/);
    await app.run(async ctx => {
        const session = await ctx.db.query('backupRestores').withIndex('by_collectionId', q => q.eq('collectionId', collectionId)).unique();
        expect(session).toMatchObject({ receivedCount: 1, receivedBytes: nearLimit });
        expect(await ctx.db.query('backupRestoreItems').withIndex('by_collectionId_and_ordinal', q => q.eq('collectionId', collectionId).eq('ordinal', 1)).first()).toBeNull();
        await ctx.db.patch(session!._id, { receivedBytes: undefined });
    });
    expect((await owner.mutation(api.backups.uploadPage, { ...upload, rows: [first, second] })).receivedCount).toBe(2);
    await app.run(async ctx => {
        const session = await ctx.db.query('backupRestores').withIndex('by_collectionId', q => q.eq('collectionId', collectionId)).unique();
        const staged = await ctx.db.query('backupRestoreItems').withIndex('by_collectionId_and_ordinal', q => q.eq('collectionId', collectionId)).take(2);
        expect(session?.receivedBytes).toBe(staged.reduce((sum, row) => sum + getDocumentSize(row), 0));
    });
});

test('abandoned restores expire without allowing upload replay or early replacement during cleanup', async () => {
    vi.useFakeTimers();
    try {
        const { app, owner, other, request } = restoreFixture();
        const expired = await owner.mutation(api.backups.beginRestore, { ...request, expectedCount: 20 });
        const rows = Array.from({ length: 16 }, () => ({ table: 'candidates' as const, payload: { publicId: id(), customValues: [] } }));
        const upload = { collectionId: expired.collectionId, offset: 0, rows };
        await owner.mutation(api.backups.uploadPage, upload);
        vi.setSystemTime(Date.now() + restoreIdleMs - 1);
        await owner.mutation(api.backups.uploadPage, upload);
        const recent = await other.mutation(api.backups.beginRestore, request);
        vi.setSystemTime(Date.now() + 1);
        await expect(owner.mutation(api.backups.uploadPage, upload)).rejects.toThrow(/restore expired/);
        await app.mutation(internal.lifecycle.expireRestores, {});
        expect(await owner.query(api.backups.pendingRestore, {})).toBeNull();
        await expect(owner.mutation(api.backups.beginRestore, { ...request, restoreKey: id() })).rejects.toThrow(/cleanup to finish/);
        await app.finishAllScheduledFunctions(() => vi.runAllTimers());
        await app.run(async ctx => {
            expect(await ctx.db.get(expired.collectionId)).toBeNull();
            expect(await ctx.db.query('backupRestoreItems').withIndex('by_collectionId_and_ordinal', q => q.eq('collectionId', expired.collectionId)).first()).toBeNull();
        });
        expect(await other.query(api.backups.pendingRestore, {})).toMatchObject({ collectionId: recent.collectionId });
        expect(await owner.mutation(api.backups.beginRestore, request)).toMatchObject({ state: 'uploading' });
    } finally {
        vi.useRealTimers();
    }
});

test('restoring and deleting collections hold account slots until activation or cleanup', async () => {
    vi.useFakeTimers();
    try {
        const { app, owner, request } = restoreFixture();
        const activeId = await owner.mutation(api.tracker.createCollection, {});
        await app.run(async ctx => {
            const { _id, _creationTime, ...collection } = (await ctx.db.get(activeId))!;
            for (let index = 0; index < limits.collections - 2; index++) {
                await ctx.db.insert('collections', { ...collection, publicId: id() });
            }
        });
        const { collectionId } = await owner.mutation(api.backups.beginRestore, { ...request, expectedCount: 0 });
        await expect(owner.mutation(api.tracker.createCollection, {})).rejects.toThrow(/collection limit/);
        await owner.mutation(api.lifecycle.deleteCollection, { collectionId: activeId, confirmation: 'delete', expectedRevision: 1 });
        await expect(owner.mutation(api.tracker.createCollection, {})).rejects.toThrow(/collection limit/);
        await app.finishAllScheduledFunctions(() => vi.runAllTimers());
        await owner.mutation(api.tracker.createCollection, {});
        let result;
        for (let step = 0; step < 30 && result?.state !== 'complete'; step++) {
            result = await owner.mutation(api.backups.advanceRestore, { collectionId });
        }
        expect(result?.state).toBe('complete');
        expect(await owner.query(api.tracker.listCollections, {})).toHaveLength(limits.collections);
    } finally {
        vi.useRealTimers();
    }
});

test('portable backup restores private data and more than 1,000 history records into a new owned collection', async () => {
    const app = convexTest(schema, modules);
    const originalOwner = app.withIdentity({ subject: 'original|session', issuer: 'https://tracker.test' });
    const restoreOwner = app.withIdentity({ subject: 'restore|session', issuer: 'https://tracker.test' });
    const source = await originalOwner.mutation(api.tracker.saveHome, {
        operationId: id(), title: 'North facing', location: { status: 'unresolved', rawAddress: '52 Test Road', unitNumber: '#08-0123' },
        sources: [{
            url: 'https://example.test/listing/52',
            facts: { askingPriceCents: 680_000_00, area: { sqm: 92, originalValue: 92, originalUnit: 'sqm' } },
            contact: { name: 'Example agent', phoneRaw: '90000000' },
        }],
    });
    const field = await originalOwner.mutation(api.tracker.saveCustomField, {
        collectionId: source.collectionId, operationId: id(), label: 'Noise', type: 'number',
    });
    const candidate = await originalOwner.mutation(api.tracker.editCandidate, {
        collectionId: source.collectionId, candidateId: source.candidateId, expectedRevision: source.revision, operationId: id(),
        patch: { shortlisted: true, progress: 'offer_submitted', customValues: [{ fieldId: field.publicId, type: 'number', value: 2 }] },
    });
    await originalOwner.mutation(api.tracker.saveNote, {
        collectionId: source.collectionId, candidateId: source.candidateId, operationId: id(),
        kind: 'viewing', body: 'Private visit notes',
    });
    await originalOwner.run(async ctx => {
        const original = await ctx.db.get(source.collectionId);
        const home = await ctx.db.get(source.candidateId);
        if (!original || !home) throw new Error('Missing test records');
        for (let index = 0; index < 1_005; index++) {
            await ctx.db.insert('changeEvents', {
                publicId: id(), collectionId: source.collectionId, candidateId: source.candidateId,
                entity: { table: 'candidates', publicId: home.publicId }, eventVersion: 1, operationId: id(), commandHash: 'history',
                actor: { kind: 'buyer', userId: original.ownerId }, kind: 'buyer_edited', changedFields: [],
                recordedAt: index, afterRevision: candidate.revision,
            });
        }
    });
    const importRow = {
        rowKey: id(), logicalRowKey: id(), rowNumber: 1,
        source: { url: 'https://example.test/listing/52', observedAt: 1234, facts: { askingPriceCents: 675_000_00 } },
    };
    const [preview] = await originalOwner.query(api.imports.preview, { collectionId: source.collectionId, rows: [importRow] });
    const run = await originalOwner.mutation(api.imports.startRun, {
        collectionId: source.collectionId, idempotencyKey: id(), fileHash: 'b'.repeat(64), format: 'csv', totalRows: 1,
    });
    const [receipt] = await originalOwner.mutation(api.imports.commitRows, {
        ...run, rows: [{ ...importRow, expectedSourceRevision: preview.expectedSourceRevision, expectedCandidateRevision: preview.expectedCandidateRevision }],
    });
    expect(receipt.outcome).toBe('accepted');
    expect(receipt.observationId).toBeTruthy();
    const reader = originalOwner as unknown as ConvexClient;
    const writer = restoreOwner as unknown as ConvexClient;
    const csv = await (await exportCsv(reader, source.collectionId, new Set(['url', 'ask']))).text();
    expect(csv).toContain('675000');
    expect(csv).not.toMatch(/08-0123|Example agent|Private visit notes|Shortlisted|offer_submitted/);
    const privateCsv = await (await exportCsv(reader, source.collectionId, new Set(['progress', 'shortlisted']))).text();
    expect(readTrackerFile(privateCsv, 'csv').rows[0].cells).toMatchObject({ Progress: 'offer_submitted', Shortlisted: 'Yes' });
    const blob = await exportBackup(reader, source.collectionId, () => {});
    const file = new File([blob], 'tracker.json');
    expect(await file.text()).not.toContain(source.candidateId);
    expect(await file.text()).toContain('collection_owner');
    const manifest = await inspectBackup(file);
    expect(manifest.total).toBeGreaterThan(1000);
    const restoreKey = id();
    const checksum = await backupFileHash(file);
    const restoredId = await applyBackup(writer, file, manifest, restoreKey, checksum, () => {});
    expect(restoredId).not.toBe(source.collectionId);
    expect(await applyBackup(writer, file, manifest, restoreKey, checksum, () => {})).toBe(restoredId);
    await expect(originalOwner.query(api.backups.exportHeader, { collectionId: restoredId })).rejects.toThrow(/unavailable/i);
    const restored = JSON.parse(await (await exportBackup(writer, restoredId, () => {})).text());
    const initial = JSON.parse(await file.text());
    expect(restored.records).toEqual(initial.records);
    const collections = await restoreOwner.query(api.tracker.listCollections, {});
    expect(collections).toHaveLength(1);
    expect(collections[0].candidateCount).toBe(1);

    const bad = structuredClone(initial);
    bad.records.changeEvents = [];
    bad.records.sourceListings[0].url = 'javascript:alert(1)';
    const badFile = new File([JSON.stringify(bad)], 'bad.json');
    const badManifest = await inspectBackup(badFile);
    await expect(applyBackup(writer, badFile, badManifest, id(), await backupFileHash(badFile), () => {})).rejects.toThrow(/HTTP or HTTPS URL/);
    expect(await restoreOwner.query(api.tracker.listCollections, {})).toHaveLength(1);
    const pending = await restoreOwner.query(api.backups.pendingRestore, {});
    expect(pending).toBeTruthy();
    await discardBackup(writer, pending!.collectionId);
    expect(await restoreOwner.query(api.backups.pendingRestore, {})).toBeNull();
}, 30_000);



test('invalid parent references and missing source aliases keep a restored collection hidden', async () => {
    const app = convexTest(schema, modules);
    const owner = app.withIdentity({ subject: 'buyer|session', issuer: 'https://tracker.test' });
    const client = owner as unknown as ConvexClient;
    const save = (title: string, collectionId?: import('./_generated/dataModel').Id<'collections'>) =>
        owner.mutation(api.tracker.saveHome, {
            collectionId, operationId: id(), title, sources: [{ url: 'https://www.propertyguru.com.sg/listing/' + title, externalListingId: title }],
        });
    const first = await save('first');
    await save('second', first.collectionId);
    await owner.mutation(api.tracker.saveNote, {
        collectionId: first.collectionId, candidateId: first.candidateId, operationId: id(), kind: 'viewing', body: 'A note',
    });
    const snapshot = await exportBackup(client, first.collectionId, () => {});
    const bad = JSON.parse(await snapshot.text());
    const note = bad.records.notes[0];
    const sibling = bad.records.sourceListings.find((source: { candidateId: string }) => source.candidateId !== note.candidateId);
    note.references.push({ id: id(), sourceListingId: sibling.publicId, url: 'https://example.test/report' });
    const file = new File([JSON.stringify(bad)], 'wrong-parent.json');
    await expect(applyBackup(client, file, await inspectBackup(file), id(), await backupFileHash(file), () => {}))
        .rejects.toThrow(/belonging to this saved home/);
    expect(await owner.query(api.tracker.listCollections, {})).toHaveLength(1);
    const pending = await owner.query(api.backups.pendingRestore, {});
    await discardBackup(client, pending!.collectionId);

    const missingAlias = JSON.parse(await snapshot.text());
    missingAlias.records.sourceIdentities = missingAlias.records.sourceIdentities.filter((alias: { kind: string }) => alias.kind !== 'url');
    const aliasFile = new File([JSON.stringify(missingAlias)], 'missing-url-alias.json');
    await expect(applyBackup(client, aliasFile, await inspectBackup(aliasFile), id(), await backupFileHash(aliasFile), () => {}))
        .rejects.toThrow(/identity key required for reimport/);
    expect(await owner.query(api.tracker.listCollections, {})).toHaveLength(1);
});


test('deleting a home blocks snapshots and deleting a restore blocks resume and upload', async () => {
    const app = convexTest(schema, modules);
    const owner = app.withIdentity({ subject: 'buyer|session', issuer: 'https://tracker.test' });
    const saved = await owner.mutation(api.tracker.saveHome, {
        operationId: id(), title: 'Saved home', sources: [{ url: 'https://example.test/listing' }],
    });
    const { collectionId, candidateId, revision } = saved;
    const archived = await owner.mutation(api.tracker.editCandidate, {
        collectionId, candidateId, operationId: id(), expectedRevision: revision, patch: { recordState: 'archived' },
    });
    const header = await owner.query(api.backups.exportHeader, { collectionId });
    const beginArgs = { restoreKey: id(), fileHash: 'a'.repeat(64), expectedCount: 1, header };
    const restore = await owner.mutation(api.backups.beginRestore, beginArgs);

    vi.useFakeTimers();
    try {
        await owner.mutation(api.lifecycle.deleteCandidate, { collectionId, candidateId, expectedRevision: archived.revision, confirmation: 'delete' });
        await expect(owner.query(api.backups.exportHeader, { collectionId })).rejects.toThrow(/home deletion to finish/);
        await expect(owner.query(api.backups.exportPage, {
            collectionId, contentRevision: header.contentRevision, table: 'sourceListings', cursor: null,
        })).rejects.toThrow(/home deletion to finish/);

        await owner.mutation(api.lifecycle.deleteCollection, { collectionId: restore.collectionId, expectedRevision: 1, confirmation: 'delete' });
        await expect(owner.mutation(api.backups.beginRestore, beginArgs)).rejects.toThrow(/unavailable/);
        await expect(owner.mutation(api.backups.advanceRestore, { collectionId: restore.collectionId })).rejects.toThrow(/unavailable/);
        await expect(owner.mutation(api.backups.uploadPage, {
            collectionId: restore.collectionId, offset: 0, rows: [{ table: 'candidates', payload: { publicId: id() } }],
        })).rejects.toThrow(/unavailable/);
        await app.finishAllScheduledFunctions(() => vi.runAllTimers());
        const finished = await owner.query(api.backups.exportHeader, { collectionId });
        expect(finished.contentRevision).toBeGreaterThan(header.contentRevision);
    } finally {
        vi.useRealTimers();
    }
});
