import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { backupTableNames } from "./backupSchema";
import schema from "./schema";
import type { ImportSource } from "./trackerTypes";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const issuer = "https://tracker-lifecycle.test";
const paginationOpts = { cursor: null, numItems: 25 };

function fixture() {
  const app = convexTest(schema, modules);
  return {
    app,
    buyer: app.withIdentity({ issuer, subject: "buyer|session" }),
    other: app.withIdentity({ issuer, subject: "other|session" }),
  };
}

test("candidate deletion hides private data immediately and purges multiple batches while retaining anonymous import outcomes", async () => {
  const { app, buyer, other } = fixture();
  const run = await buyer.mutation(api.imports.startRun, {
    idempotencyKey: crypto.randomUUID(), fileHash: "a".repeat(64), format: "csv", totalRows: 1,
  });
  const rows = [{
    rowKey: crypto.randomUUID(), logicalRowKey: crypto.randomUUID(), rowNumber: 2,
    source: { url: "https://example.test/listing/delete-home", facts: { rawAddress: "12 Example Road", unitNumber: "#08-0123" }, contacts: [{ name: "Private contact" }] },
  }];
  const command = { ...run, rows };
  const [receipt] = await buyer.mutation(api.imports.commitRows, command);
  const target = { collectionId: run.collectionId, candidateId: receipt.candidateId! };
  const detail = await buyer.query(api.tracker.candidateDetail, target);
  const saved = await buyer.mutation(api.tracker.saveNote, { ...target, operationId: crypto.randomUUID(), kind: "general", body: "Private note" });
  const remaining = await buyer.mutation(api.tracker.saveHome, { collectionId: target.collectionId, operationId: crypto.randomUUID(), title: "Keep this home", sources: [{ url: "https://example.test/listing/keep-home" }] });
  await app.run(async ctx => {
    const { _id, _creationTime, ...evidence } = (await ctx.db.get(receipt.observationId!))!;
    for (let index = 0; index < 28; index++) {
      await ctx.db.insert("sourceObservations", { ...evidence, publicId: crypto.randomUUID(), recordedAt: evidence.recordedAt + index + 1 });
    }
  });

  vi.useFakeTimers();
  try {
    const activeDeletion = { ...target, confirmation: "delete" as const, expectedRevision: saved.candidateRevision };
    await expect(buyer.mutation(api.lifecycle.deleteCandidate, activeDeletion)).rejects.toThrow(/Archive this home/);
    const archived = await buyer.mutation(api.tracker.editCandidate, {
      ...target, operationId: crypto.randomUUID(), expectedRevision: saved.candidateRevision, patch: { recordState: "archived" },
    });
    const archivedHomes = await buyer.query(api.tracker.listCandidates, {
      collectionId: target.collectionId, recordState: "archived", paginationOpts,
    });
    expect(archivedHomes.page.map(home => home._id)).toContain(target.candidateId);
    const restored = await buyer.mutation(api.tracker.editCandidate, {
      ...target, operationId: crypto.randomUUID(), expectedRevision: archived.revision, patch: { recordState: "active" },
    });
    const activeHomes = await buyer.query(api.tracker.listCandidates, { collectionId: target.collectionId, paginationOpts });
    expect(activeHomes.page.map(home => home._id)).toContain(target.candidateId);
    await expect(buyer.mutation(api.lifecycle.deleteCandidate, { ...activeDeletion, expectedRevision: archived.revision })).rejects.toThrow();
    const rearchived = await buyer.mutation(api.tracker.editCandidate, {
      ...target, operationId: crypto.randomUUID(), expectedRevision: restored.revision, patch: { recordState: "archived" },
    });
    const deletion = { ...activeDeletion, expectedRevision: rearchived.revision };
    await expect(other.mutation(api.lifecycle.deleteCandidate, deletion)).rejects.toThrow();
    await expect(buyer.mutation(api.lifecycle.deleteCandidate, { ...deletion, expectedRevision: detail.candidate.revision })).rejects.toThrow();
    await buyer.mutation(api.lifecycle.deleteCandidate, deletion);
    const jobId = await app.run(async ctx => (await ctx.db.get(target.candidateId))?.purgeJobId);
    expect(jobId).toBeDefined();
    await buyer.mutation(api.lifecycle.deleteCandidate, deletion);
    await app.mutation(internal.lifecycle.purgeCandidate, target);
    expect(await app.run(async ctx => (await ctx.db.get(target.candidateId))?.purgeJobId)).toBe(jobId);
    await app.run(async ctx => ctx.scheduler.cancel(jobId!));
    await buyer.mutation(api.lifecycle.deleteCandidate, deletion);
    expect(await app.run(async ctx => (await ctx.db.get(target.candidateId))?.purgeJobId)).not.toBe(jobId);
    await expect(buyer.query(api.tracker.candidateDetail, target)).rejects.toThrow();
    const history = await buyer.query(api.tracker.collectionHistory, { collectionId: target.collectionId, paginationOpts });
    expect(history.page.some(event => event.candidateId === target.candidateId)).toBe(false);
    const [retry] = await buyer.mutation(api.imports.commitRows, command);
    expect(retry).toMatchObject({ _id: receipt._id, outcome: "accepted" });
    expect(retry.candidateId).toBeUndefined();
    expect(retry.sourceListingId).toBeUndefined();
    expect(retry.observationId).toBeUndefined();

    await app.finishAllScheduledFunctions(() => vi.runAllTimers());
    await app.run(async ctx => {
      const item = await ctx.db.get(receipt._id);
      expect(item).toEqual(retry);
      expect(await ctx.db.get(target.candidateId)).toBeNull();
      expect(await ctx.db.get(saved.noteId)).toBeNull();
      expect(await ctx.db.get(detail.sources[0]._id)).toBeNull();
      expect(await ctx.db.get(detail.contacts[0]._id)).toBeNull();
      expect(await ctx.db.query("sourceObservations").withIndex("by_collectionId_and_sourceListingId_and_recordedAt", q => q.eq("collectionId", target.collectionId).eq("sourceListingId", detail.sources[0]._id)).first()).toBeNull();
      expect(await ctx.db.query("sourceIdentities").withIndex("by_collectionId_and_sourceListingId", q => q.eq("collectionId", target.collectionId).eq("sourceListingId", detail.sources[0]._id)).first()).toBeNull();
      expect(await ctx.db.query("changeEvents").withIndex("by_collectionId_and_candidateId_and_recordedAt", q => q.eq("collectionId", target.collectionId).eq("candidateId", target.candidateId)).first()).toBeNull();
      expect((await ctx.db.get(target.collectionId))?.candidateCount).toBe(1);
      expect(await ctx.db.get(remaining.candidateId)).not.toBeNull();
    });
  } finally {
    vi.useRealTimers();
  }
});

test("collection deletion clears collection records and incomplete backup staging without touching another owner", async () => {
  const { app, buyer, other } = fixture();
  const home = await buyer.mutation(api.tracker.saveHome, {
    operationId: crypto.randomUUID(), title: "Delete this collection", sources: [{ url: "https://example.test/listing/1" }],
  });
  const otherHome = await other.mutation(api.tracker.saveHome, {
    operationId: crypto.randomUUID(), title: "Keep this collection", sources: [{ url: "https://example.test/listing/1" }],
  });
  const header = await buyer.query(api.backups.exportHeader, { collectionId: home.collectionId });
  const restore = await buyer.mutation(api.backups.beginRestore, { restoreKey: crypto.randomUUID(), fileHash: "b".repeat(64), expectedCount: 1, header });
  await buyer.mutation(api.backups.uploadPage, { collectionId: restore.collectionId, offset: 0, rows: [{ table: "candidates", payload: { publicId: crypto.randomUUID(), customValues: [] } }] });

  vi.useFakeTimers();
  try {
    const deletion = { collectionId: home.collectionId, confirmation: "delete" as const, expectedRevision: 1 };
    await expect(other.mutation(api.lifecycle.deleteCollection, deletion)).rejects.toThrow();
    await buyer.mutation(api.lifecycle.deleteCollection, deletion);
    const jobId = await app.run(async ctx => (await ctx.db.get(home.collectionId))?.purgeJobId);
    expect(jobId).toBeDefined();
    await buyer.mutation(api.lifecycle.deleteCollection, deletion);
    await app.mutation(internal.lifecycle.purgeCollection, { collectionId: home.collectionId });
    expect(await app.run(async ctx => (await ctx.db.get(home.collectionId))?.purgeJobId)).toBe(jobId);
    await buyer.mutation(api.lifecycle.deleteCollection, { ...deletion, collectionId: restore.collectionId });
    expect(await buyer.query(api.tracker.listCollections, {})).toEqual([]);
    expect(await buyer.query(api.backups.pendingRestore, {})).toBeNull();
    await expect(buyer.query(api.backups.exportHeader, { collectionId: home.collectionId })).rejects.toThrow();

    await app.finishAllScheduledFunctions(() => vi.runAllTimers());
    await app.run(async ctx => {
      for (const collectionId of [home.collectionId, restore.collectionId]) {
        expect(await ctx.db.get(collectionId)).toBeNull();
        for (const table of backupTableNames) {
          expect(await ctx.db.query(table).withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId)).first()).toBeNull();
        }
        expect(await ctx.db.query("backupRestores").withIndex("by_collectionId", q => q.eq("collectionId", collectionId)).first()).toBeNull();
        expect(await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_ordinal", q => q.eq("collectionId", collectionId)).first()).toBeNull();
      }
    });
    expect((await other.query(api.tracker.candidateDetail, { collectionId: otherHome.collectionId, candidateId: otherHome.candidateId })).candidate.title).toBe("Keep this collection");
  } finally {
    vi.useRealTimers();
  }
});

test("a location correction can preserve the full supplied address and explicitly clear the unit", async () => {
  const { buyer } = fixture();
  const { revision, ...target } = await buyer.mutation(api.tracker.saveHome, {
    operationId: crypto.randomUUID(),
    location: { status: "unresolved", postalCode: "001234", rawAddress: "12 Example Road #08-0123", unitNumber: "#08-0123" },
    sources: [{ url: "https://example.test/listing/location" }],
  });
  const updated = await buyer.mutation(api.tracker.editCandidate, {
    ...target, operationId: crypto.randomUUID(), expectedRevision: revision,
    patch: { location: { status: "confirmed", postalCode: "005678", matchMethod: "buyer_selected", geocodeVersion: "test-1" } },
  });
  const { candidate } = await buyer.query(api.tracker.candidateDetail, target);
  expect(candidate.location).toMatchObject({ rawAddress: "12 Example Road #08-0123", unitNumber: "#08-0123", postalCode: "005678" });
  await buyer.mutation(api.tracker.editCandidate, {
    ...target, operationId: crypto.randomUUID(), expectedRevision: updated.revision,
    patch: { location: { status: "confirmed", unitNumber: null } },
  });
  expect((await buyer.query(api.tracker.candidateDetail, target)).candidate.location).toEqual({
    rawAddress: "12 Example Road #08-0123", postalCode: "005678", status: "confirmed", matchMethod: "buyer_selected", geocodeVersion: "test-1", confirmedAt: expect.any(Number),
  });
});

test("accepting an undated buyer report preserves the previous dated ordering watermark", async () => {
  const { buyer } = fixture();
  const collectionId = await buyer.mutation(api.tracker.createCollection, {});
  const url = "https://example.test/listing/price";
  const importPrice = async (source: Omit<ImportSource, "url">) => {
    const row = { rowKey: crypto.randomUUID(), logicalRowKey: crypto.randomUUID(), rowNumber: 2, source: { url, ...source } };
    const [preview] = await buyer.query(api.imports.preview, { collectionId, rows: [row] });
    expect(preview.status).not.toBe("needs_attention");
    const run = await buyer.mutation(api.imports.startRun, { collectionId, idempotencyKey: crypto.randomUUID(), fileHash: "c".repeat(64), format: "csv", totalRows: 1 });
    const [receipt] = await buyer.mutation(api.imports.commitRows, { ...run, rows: [{ ...row, expectedCandidateRevision: preview.expectedCandidateRevision, expectedSourceRevision: preview.expectedSourceRevision }] });
    expect(receipt.outcome).toBe("accepted");
    return receipt;
  };
  const first = await importPrice({ observedAt: 1_700_000_000_000, facts: { askingPriceCents: 70_000_000 } });
  const target = { collectionId, candidateId: first.candidateId! };
  await importPrice({ acceptUndatedAsCurrent: true, facts: { askingPriceCents: 69_000_000 } });
  await importPrice({ observedAt: 1_690_000_000_000, facts: { askingPriceCents: 65_000_000 } });
  const { candidate } = await buyer.query(api.tracker.candidateDetail, target);
  expect(candidate.summary).toMatchObject({ askingPriceCents: 69_000_000, askingTimeBasis: "buyer_reported" });
  expect(candidate.summary.askingObservedAt).toBeUndefined();
  await importPrice({ observedAt: 1_710_000_000_000, facts: { askingPriceCents: 66_000_000 } });
  expect((await buyer.query(api.tracker.candidateDetail, target)).candidate.summary.askingPriceCents).toBe(66_000_000);
});
