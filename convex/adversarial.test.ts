import type { ConvexClient } from 'convex/browser';
import { convexTest } from 'convex-test';
import { expect, test, vi } from 'vitest';
import { applyBackup, backupFileHash, exportBackup, inspectBackup } from '../src/listings/backupFiles';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import type { ImportRow, ImportSource } from './trackerTypes';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const issuer = 'https://tracker-review.test';
const id = () => crypto.randomUUID();
const page = { cursor: null, numItems: 25 };

function fixture() {
    const app = convexTest(schema, modules);
    return {
        app,
        buyer: app.withIdentity({ issuer, subject: 'buyer|first-session' }),
        other: app.withIdentity({ issuer, subject: 'other|session' }),
    };
}

test('tracker write limits are shared across sessions but isolated between owners', async () => {
    const { app, buyer, other } = fixture();
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
        const operation = { operationId: id() };
        const collectionId = await buyer.mutation(api.tracker.createCollection, operation);
        for (let count = 1; count < 120; count++) {
            await buyer.mutation(api.tracker.createCollection, operation);
        }
        const otherSession = app.withIdentity({ issuer, subject: 'buyer|second-session' });
        await expect(otherSession.mutation(api.tracker.createCollection, operation)).rejects.toThrow('Too many tracker changes');
        await expect(other.mutation(api.tracker.createCollection, operation)).resolves.not.toBe(collectionId);

        time.mockReturnValue(Date.now() + 1_000);
        await expect(otherSession.mutation(api.tracker.createCollection, operation)).resolves.toBe(collectionId);
    } finally {
        time.mockRestore();
    }
});

function row(rowNumber: number, source: ImportSource): ImportRow {
    return { rowNumber, rowKey: id(), logicalRowKey: id(), source };
}

async function importReport(
    buyer: ReturnType<typeof fixture>['buyer'], input: ImportRow, collectionId?: Id<'collections'>, mode?: 'explicit_tracker_update',
) {
    const [preview] = await buyer.query(api.imports.preview, { collectionId, rows: [input] });
    expect(preview.status).not.toBe('needs_attention');
    const run = await buyer.mutation(api.imports.startRun, {
        collectionId, idempotencyKey: id(), format: 'csv', fileHash: 'a'.repeat(64), totalRows: 1, mode,
    });
    const command = { ...run, rows: [{ ...input, expectedCandidateRevision: preview.expectedCandidateRevision, expectedSourceRevision: preview.expectedSourceRevision }] };
    const [receipt] = await buyer.mutation(api.imports.commitRows, command);
    return { run, receipt, command };
}

test('an older contact stays in source history and does not become an active contact', async () => {
    const { buyer } = fixture();
    const url = 'https://example.test/listing/7';
    const first = await importReport(buyer, row(2, {
        url, observedAt: 1_700_000_000_000, contacts: [{ name: 'New agent', phoneRaw: '90000001' }],
        facts: { askingPriceCents: 688_000_00 },
    }));
    expect(first.receipt.outcome).toBe('accepted');
    const target = { collectionId: first.run.collectionId, candidateId: first.receipt.candidateId! };
    const older = await importReport(buyer, row(2, {
        url, observedAt: 1_690_000_000_000, contacts: [{ name: 'Old agent', phoneRaw: '90000002' }],
        facts: { askingPriceCents: 700_000_00 },
    }), target.collectionId);
    expect(older.receipt.outcome).toBe('accepted');
    const detail = await buyer.query(api.tracker.candidateDetail, target);
    expect(detail.candidate.summary.askingPriceCents).toBe(688_000_00);
    const observations = await buyer.query(api.tracker.sourceHistory, { ...target, sourceListingId: detail.sources[0]._id, paginationOpts: page });
    expect(observations.page.flatMap(item => item.contactClaims.map(contact => contact.name))).toContain('Old agent');
    expect(detail.contacts.map(contact => contact.name)).toEqual(['New agent']);
    const timeline = await buyer.query(api.tracker.history, { ...target, paginationOpts: page });
    expect(timeline.page.find(event => event.observationId === older.receipt.observationId)?.affectsCurrentFacts).toBe(false);
});

test('source import isolation, stale previews, stable URL omission, retries, and private work preservation', async () => {
    const { app, buyer, other } = fixture();
    const url = 'https://example.test/listing/9';
    const first = await importReport(buyer, row(2, {
        url, trackerRowKey: 'personal/9', observedAt: 1_690_000_000_000,
        facts: { askingPriceCents: 700_000_00, flatModel: 'Model A', availability: 'active_as_observed' },
    }));
    const target = { collectionId: first.run.collectionId, candidateId: first.receipt.candidateId! };
    const detail = await buyer.query(api.tracker.candidateDetail, target);
    const update = row(2, { trackerRowKey: 'personal/9', observedAt: 1_700_000_000_000, facts: { askingPriceCents: 688_000_00 } });
    const [preview] = await buyer.query(api.imports.preview, { collectionId: target.collectionId, rows: [update] });
    expect(preview.status).toBe('update');
    const command = { ...first.run, rows: [{ ...update, expectedCandidateRevision: preview.expectedCandidateRevision, expectedSourceRevision: preview.expectedSourceRevision }] };
    await expect(other.query(api.imports.preview, { collectionId: target.collectionId, rows: [update] })).rejects.toThrow();
    await expect(other.mutation(api.imports.commitRows, first.command)).rejects.toThrow();
    await expect(app.query(api.imports.runStatus, { ...first.run, paginationOpts: page })).rejects.toThrow();
    const staleRun = await buyer.mutation(api.imports.startRun, {
        collectionId: target.collectionId, idempotencyKey: id(), format: 'csv', fileHash: 'b'.repeat(64), totalRows: 1,
    });
    await buyer.mutation(api.tracker.saveNote, {
        ...target, operationId: id(), kind: 'viewing', body: 'Private viewing observation',
        candidatePatch: { expectedRevision: detail.candidate.revision, progress: 'lost', shortlisted: true },
    });
    const [conflict] = await buyer.mutation(api.imports.commitRows, { ...command, ...staleRun });
    expect(conflict).toMatchObject({ outcome: 'conflict', problems: [{ field: 'candidateRevision', code: 'stale_revision' }] });
    const second = await importReport(buyer, { ...update, rowKey: id(), logicalRowKey: id() }, target.collectionId);
    expect(second.receipt.outcome).toBe('accepted');
    expect(await buyer.mutation(api.imports.commitRows, second.command)).toEqual([second.receipt]);
    const after = await buyer.query(api.tracker.candidateDetail, target);
    expect(after.candidate).toMatchObject({ progress: 'lost', shortlisted: true, summary: { askingPriceCents: 688_000_00, sourceCount: 1 } });
    expect(after.sources[0]).toMatchObject({ url, current: { flatModel: { value: 'Model A' } }, availability: { value: 'active_as_observed' } });
    expect((await buyer.query(api.tracker.listNotes, { ...target, paginationOpts: page })).page.map(note => note.body)).toEqual(['Private viewing observation']);
    const history = await buyer.query(api.tracker.history, { ...target, paginationOpts: page });
    expect(history.page.filter(event => event.kind === 'source_observed')).toHaveLength(1);
});

test('only an explicit private import can clear a shortlist flag', async () => {
    const { buyer } = fixture();
    const source = { url: 'https://example.test/listing/shortlist' };
    const created = await importReport(buyer, {
        ...row(2, source), buyerPatch: { progress: 'offer_submitted', shortlisted: true },
    }, undefined, 'explicit_tracker_update');
    expect(created.receipt.outcome).toBe('accepted');
    const target = { collectionId: created.run.collectionId, candidateId: created.receipt.candidateId! };
    expect((await buyer.query(api.tracker.candidateDetail, target)).candidate).toMatchObject({
        progress: 'offer_submitted', shortlisted: true,
    });

    const unstar = { ...row(2, source), buyerPatch: { shortlisted: false } };
    const rejected = await importReport(buyer, unstar, target.collectionId);
    expect(rejected.receipt.outcome).toBe('rejected');
    expect((await buyer.query(api.tracker.candidateDetail, target)).candidate.shortlisted).toBe(true);

    const accepted = await importReport(buyer, unstar, target.collectionId, 'explicit_tracker_update');
    expect(accepted.receipt.outcome).toBe('accepted');
    expect(await buyer.mutation(api.imports.commitRows, accepted.command)).toEqual([accepted.receipt]);
    expect((await buyer.query(api.tracker.candidateDetail, target)).candidate).toMatchObject({
        progress: 'offer_submitted', shortlisted: false,
    });
});

test('a note retry returns the original candidate revision after later buyer edits', async () => {
    const { buyer } = fixture();
    const home = await buyer.mutation(api.tracker.saveHome, {
        operationId: id(), title: 'Home A', sources: [{ url: 'https://example.test/listing/a' }],
    });
    const target = { collectionId: home.collectionId, candidateId: home.candidateId };
    const note = { ...target, operationId: id(), kind: 'viewing' as const, body: 'First visit' };
    const saved = await buyer.mutation(api.tracker.saveNote, note);
    await buyer.mutation(api.tracker.editCandidate, {
        ...target, operationId: id(), expectedRevision: saved.candidateRevision, patch: { title: 'Updated by another device' },
    });
    expect(await buyer.mutation(api.tracker.saveNote, note)).toEqual(saved);
});

test('a restore rejects nested note references to a different home in the same backup', async () => {
    const { buyer, other } = fixture();
    const home = await buyer.mutation(api.tracker.saveHome, {
        operationId: id(), title: 'Home A', sources: [{ url: 'https://example.test/listing/a' }],
    });
    const target = { collectionId: home.collectionId, candidateId: home.candidateId };
    const neighbor = await buyer.mutation(api.tracker.saveHome, {
        collectionId: home.collectionId, operationId: id(), title: 'Home B', sources: [{ url: 'https://example.test/listing/b' }],
    });
    const detail = await buyer.query(api.tracker.candidateDetail, target);
    const neighborDetail = await buyer.query(api.tracker.candidateDetail, { ...target, candidateId: neighbor.candidateId });
    const reference = { id: id(), url: 'https://example.test/image', sourceListingId: detail.sources[0]._id };
    const note = { ...target, operationId: id(), kind: 'viewing' as const, body: 'Visit', references: [reference] };
    await expect(buyer.mutation(api.tracker.saveNote, {
        ...note, references: [{ ...reference, sourceListingId: neighborDetail.sources[0]._id }],
    })).rejects.toThrow(/belonging to this saved home/i);
    await buyer.mutation(api.tracker.saveNote, note);
    const blob = await exportBackup(buyer as unknown as ConvexClient, home.collectionId, () => {});
    const portable = JSON.parse(await blob.text());
    portable.records.notes[0].references[0].sourceListingId = neighborDetail.sources[0].publicId;
    const file = new File([JSON.stringify(portable)], 'bad-reference.json');
    await expect(applyBackup(other as unknown as ConvexClient, file, await inspectBackup(file), id(), await backupFileHash(file), () => {})).rejects.toThrow(/belonging to this saved home/i);
    expect(await other.query(api.tracker.listCollections, {})).toEqual([]);
});

test('a restore rejects a canonical URL whose saved alias points to a different URL', async () => {
    const { buyer, other } = fixture();
    const home = await buyer.mutation(api.tracker.saveHome, {
        operationId: id(), title: 'Home', sources: [{ url: 'https://example.test/listing/a' }],
    });
    const blob = await exportBackup(buyer as unknown as ConvexClient, home.collectionId, () => {});
    const portable = JSON.parse(await blob.text());
    portable.records.sourceIdentities[0].key = 'url:https://example.test/listing/different';
    portable.records.sourceListings[0].primaryIdentityKey = portable.records.sourceIdentities[0].key;
    const file = new File([JSON.stringify(portable)], 'missing-url-alias.json');
    await expect(applyBackup(other as unknown as ConvexClient, file, await inspectBackup(file), id(), await backupFileHash(file), () => {})).rejects.toThrow(/identity|alias/i);
    expect(await other.query(api.tracker.listCollections, {})).toEqual([]);
});
