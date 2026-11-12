import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const page = { cursor: null, numItems: 25 };
const issuer = 'https://tracker-test.convex.site';

test('shortlist, progress and notes are private and retries apply once', async () => {
    const tracker = convexTest(schema, modules);
    const buyer = tracker.withIdentity({ issuer, subject: 'buyer|session-1' });
    const other = tracker.withIdentity({ issuer, subject: 'other|session-1' });
    const create = {
        operationId: crypto.randomUUID(),
        title: 'Home for viewing',
        sources: [{
            url: 'https://example.test/listing/7?utm_source=tracker',
            facts: { askingPriceCents: 68800000 },
            contact: { name: 'Test agent', phoneRaw: '91234567' },
        }],
    };
    await expect(tracker.mutation(api.tracker.saveHome, create)).rejects.toThrow();
    const home = await buyer.mutation(api.tracker.saveHome, create);
    expect(await buyer.mutation(api.tracker.saveHome, create)).toEqual(home);
    const target = { collectionId: home.collectionId, candidateId: home.candidateId };
    const { candidate, contacts, sources } = await buyer.query(api.tracker.candidateDetail, target);
    expect(candidate).toMatchObject({ progress: 'new', shortlisted: false });
    expect(contacts[0]).toMatchObject({ name: 'Test agent', sourceListingId: sources[0]._id });
    expect(sources[0].canonicalUrl).toBe('https://example.test/listing/7');

    const shortlist = { ...target, operationId: crypto.randomUUID(), expectedRevision: home.revision, patch: { shortlisted: true } };
    await expect(other.mutation(api.tracker.editCandidate, shortlist)).rejects.toThrow();
    const starred = await buyer.mutation(api.tracker.editCandidate, shortlist);
    expect(await buyer.mutation(api.tracker.editCandidate, shortlist)).toEqual(starred);

    const note = {
        ...target,
        operationId: crypto.randomUUID(),
        kind: 'rationale' as const,
        body: 'Private comparison reasoning.',
        candidatePatch: { expectedRevision: starred.revision, progress: 'offer_submitted' as const },
    };
    const saved = await buyer.mutation(api.tracker.saveNote, note);
    expect(await buyer.mutation(api.tracker.saveNote, note)).toEqual(saved);

    const otherCollection = await other.mutation(api.tracker.createCollection, { name: 'Other collection' });
    await expect(other.query(api.tracker.candidateDetail, target)).rejects.toThrow();
    await expect(other.query(api.tracker.candidateDetail, { ...target, collectionId: otherCollection })).rejects.toThrow();
    await expect(other.mutation(api.tracker.saveNote, note)).rejects.toThrow();
    await expect(other.query(api.tracker.history, { ...target, paginationOpts: page })).rejects.toThrow();

    const anotherDevice = tracker.withIdentity({ issuer, subject: 'buyer|session-2' });
    expect((await anotherDevice.query(api.tracker.candidateDetail, target)).candidate).toMatchObject({
        progress: 'offer_submitted', shortlisted: true,
    });
    const notes = await anotherDevice.query(api.tracker.listNotes, { ...target, paginationOpts: page });
    expect(notes.page.map(item => item.body)).toEqual([note.body]);
    const history = await anotherDevice.query(api.tracker.history, { ...target, paginationOpts: page });
    expect(history.page.filter(event => event.kind === 'note_changed')).toHaveLength(1);
    expect(history.page.filter(event => event.changedFields.some(change => change.field === 'shortlisted'))).toHaveLength(1);

    await buyer.mutation(api.tracker.editCandidate, {
        ...target, operationId: crypto.randomUUID(), expectedRevision: saved.candidateRevision, patch: { progress: 'passed' },
    });
    expect((await anotherDevice.query(api.tracker.candidateDetail, target)).candidate).toMatchObject({
        progress: 'passed', shortlisted: true,
    });
});

test('new homes require a valid URL and known URL aliases cannot create a duplicate', async () => {
    const tracker = convexTest(schema, modules);
    const buyer = tracker.withIdentity({ issuer, subject: 'buyer|session' });
    const base = { title: 'A home', operationId: crypto.randomUUID() };
    await expect(buyer.mutation(api.tracker.saveHome, { ...base, sources: [] })).rejects.toThrow();
    await expect(buyer.mutation(api.tracker.saveHome, {
        ...base, sources: [{ url: 'javascript:alert(1)' }],
    })).rejects.toThrow();
    expect(await buyer.query(api.tracker.listCollections, {})).toEqual([]);
    const home = await buyer.mutation(api.tracker.saveHome, {
        ...base, sources: [{ url: 'https://example.test/listing/8?unit=5&utm_campaign=source' }],
    });
    await expect(buyer.mutation(api.tracker.saveHome, {
        ...base,
        collectionId: home.collectionId,
        operationId: crypto.randomUUID(),
        sources: [{ url: 'https://example.test/listing/8?unit=5' }],
    })).rejects.toThrow();
    const saved = await buyer.query(api.tracker.listCandidates, {
        collectionId: home.collectionId,
        paginationOpts: page,
    });
    expect(saved.page).toHaveLength(1);
});
