import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ensureTrackerUser, getVisibleCandidate, requireCollection, signedInMutation, signedInQuery, touchCollection } from "./access";
import { applyNote, planNote } from "./noteModel";
import { applySource, planSource, resolveSource } from "./sourceModel";
import { importItemDoc, importRunDoc, pageFields } from "./trackerDocs";
import { candidateSources, checkCandidateCapacity, createCandidate, customValueChanges, defaultCollection, diffs, limits, ownedCollections, planCandidatePatch, recordCandidateChange, refreshCandidate, writeEvent, type Operation } from "./trackerModel";
import { importRow, previewRow, uuid, type ChangedField, type ImportRow } from "./trackerTypes";
import { boundedPagination, canonical, checkRevision, conflict, hash, integer, invalid, newPublicId, normalizedLocation, requireUuid, SHA256, text, TrackerError } from "./trackerValidation";

const batchLimit = 25;
const rowLimit = 1000;
const runAddress = { collectionId: v.id("collections"), runId: v.id("importRuns") };
const mode = v.union(v.literal("merge_sources"), v.literal("explicit_tracker_update"));
const format = v.union(v.literal("csv"), v.literal("json_tracker"));
type Receipt = Doc<"importItems">;
type Run = Doc<"importRuns">;
type Collection = Doc<"collections">;
type PreviewRow = Infer<typeof previewRow>;

async function redactDeletedHome(ctx: Pick<QueryCtx, "db">, receipt: Receipt) {
  if (!receipt.candidateId || await getVisibleCandidate(ctx, receipt.collectionId, receipt.candidateId)) return receipt;
  const { candidateId: _candidateId, sourceListingId: _sourceListingId, observationId: _observationId, ...redacted } = receipt;
  return redacted;
}

function validateBatch(rows: ImportRow[]) {
  if (rows.length > batchLimit) invalid("rows", "Use up to 25 rows per batch.");
  if (new TextEncoder().encode(canonical(rows)).length > 256 * 1024) invalid("rows", "This batch exceeds 256 KiB. Retry with fewer rows.");
}

async function findRun(ctx: Pick<QueryCtx, "db">, collectionId: Id<"collections">, key: string) {
  return ctx.db.query("importRuns").withIndex("by_collectionId_and_idempotencyKey", q => q.eq("collectionId", collectionId).eq("idempotencyKey", key)).unique();
}

async function requireRun(ctx: Pick<QueryCtx, "db">, collectionId: Id<"collections">, runId: Id<"importRuns">) {
  const run = await ctx.db.get(runId);
  if (!run || run.collectionId !== collectionId || run.format === "json_backup" || run.state === "cancelled") invalid("runId", "This listing import run is unavailable.");
  return run;
}

async function planRow(ctx: Pick<QueryCtx, "db">, collection: Collection | null, row: ImportRow, commit: boolean, runMode?: Run["mode"]) {
  if (!row.source) invalid("url", "Supply a source listing URL or a stable identity.");
  if (commit && runMode !== "explicit_tracker_update" && (row.buyerPatch || row.note)) invalid("buyerPatch", "Explicitly select tracker updates before writing private fields or notes.");
  const collectionId = collection?._id;
  const identity = await resolveSource(ctx, collectionId, row.source);
  if (row.linkCandidateId && identity.source && identity.source.candidateId !== row.linkCandidateId) conflict("linkCandidateId", "link_conflict", "This advertisement already belongs to a different saved home.");
  const candidateId = identity.source?.candidateId ?? row.linkCandidateId;
  const candidate = candidateId ? await ctx.db.get(candidateId) : null;
  if (candidateId && (!candidate || !collectionId || candidate.collectionId !== collectionId || candidate.recordState === "deleting")) invalid("linkCandidateId", "Choose a saved home from this collection.");
  if (commit) {
    if (identity.source) checkRevision(row.expectedSourceRevision, identity.source.revision, "sourceRevision");
    else if (row.expectedSourceRevision !== undefined) conflict("sourceRevision", "stale_revision", "The advertisement no longer matches this row. Review the import again.");
    if (candidate) checkRevision(row.expectedCandidateRevision, candidate.revision, "candidateRevision");
    else if (row.expectedCandidateRevision !== undefined) conflict("candidateRevision", "stale_revision", "The saved home no longer matches this row. Review the import again.");
  }
  if (!candidate && collectionId) await checkCandidateCapacity(ctx, collectionId);
  if (candidate && !identity.source && (await candidateSources(ctx, candidate)).length >= limits.sources) invalid("sources", "This saved home already has ten source listings.");
  const plan = await planSource(ctx, collectionId, identity, row.source, candidate);
  const location = row.location ? normalizedLocation(row.location) : normalizedLocation({
    status: "unresolved", rawAddress: plan.facts.rawAddress ?? undefined, postalCode: plan.facts.postalCode ?? undefined, unitNumber: plan.facts.unitNumber ?? undefined,
  });
  const title = text(row.title, "title", 120);
  const values = candidate && row.buyerPatch ? await planCandidatePatch(ctx, candidate, row.buyerPatch) : { patch: {}, changes: [] };
  const initialValues = !candidate && row.buyerPatch?.customValues ? await customValueChanges(ctx, collectionId, [], row.buyerPatch.customValues) : [];
  const note = row.note ? await planNote(ctx, candidate, { ...row.note, kind: "general" }) : null;
  const changes: ChangedField[] = [
    ...!identity.source ? [{ field: "url", before: null, after: plan.identity.url }] : [], ...plan.changes,
    ...values.changes, ...note?.changes.map(change => ({ ...change, field: `privateNote.${change.field}` })) ?? [],
  ];
  if (!candidate) {
    changes.push(...diffs({}, { title, location, progress: row.buyerPatch?.progress, shortlisted: row.buyerPatch?.shortlisted, customValues: initialValues.length ? initialValues : undefined }));
  }
  if (plan.retain && !plan.affectsCurrentFacts && identity.source) changes.push({ field: "historicalSourceReport", before: null, after: { observedAt: plan.observedAt ?? null } });
  if (plan.identityChanged && identity.source) changes.push({ field: "sourceAliases", before: null, after: plan.aliases.map(alias => alias.key) });
  return { candidate, plan, location, title, values, initialValues, note, changes };
}

async function findSimilar(ctx: Pick<QueryCtx, "db">, collectionId: Id<"collections">, location: Doc<"candidates">["location"]) {
  const postal = location.postalCode;
  const address = location.rawAddress;
  const matches = postal
    ? await ctx.db.query("candidates").withIndex("by_collectionId_and_postalCode", q => q.eq("collectionId", collectionId).eq("location.postalCode", postal)).take(10)
    : address ? await ctx.db.query("candidates").withIndex("by_collectionId_and_rawAddress", q => q.eq("collectionId", collectionId).eq("location.rawAddress", address)).take(10) : [];
  return matches.filter(candidate => candidate.recordState === "active").map(candidate => ({ candidateId: candidate._id, publicId: candidate.publicId, title: candidate.title, location: candidate.location, summary: candidate.summary }));
}

export const preview = signedInQuery({
  args: { collectionId: v.optional(v.id("collections")), rows: v.array(importRow) }, returns: v.array(previewRow),
  handler: async (ctx, args) => {
    const collection = args.collectionId ? await requireCollection(ctx, args.collectionId, ["active"]) : null;
    validateBatch(args.rows);
    const seen = new Map<string, { fingerprint: string; rowNumber: number }>();
    const results: PreviewRow[] = [];
    for (const row of args.rows) {
      try {
        integer(row.rowNumber, "rowNumber", 1, rowLimit + 1);
        if (row.skip) { results.push({ rowNumber: row.rowNumber, status: "unchanged", changes: [], problems: [] }); continue; }
        const { candidate, plan, location, changes } = await planRow(ctx, collection, row, false);
        const identities = [plan.identity.primaryIdentityKey, ...plan.aliases.map(alias => alias.key), ...(plan.source ? [plan.source._id] : [])];
        const { rowKey: _rowKey, logicalRowKey: _logicalRowKey, rowNumber: _rowNumber, supersedesItemId: _supersedesItemId, ...content } = row;
        const fingerprint = canonical(content);
        for (const key of identities) {
          const earlier = seen.get(key);
          if (earlier && earlier.fingerprint !== fingerprint) conflict("source", "batch_identity_conflict", `Review this advertisement's conflicting instructions on rows ${earlier.rowNumber} and ${row.rowNumber}.`);
        }
        identities.forEach(key => seen.set(key, { fingerprint, rowNumber: row.rowNumber }));
        const similarCandidates = !candidate && collection && !plan.source ? await findSimilar(ctx, collection._id, location) : undefined;
        results.push({
          rowNumber: row.rowNumber, status: !plan.source ? "new" : changes.length ? "update" : "unchanged",
          candidateId: candidate?._id, sourceListingId: plan.source?._id, expectedCandidateRevision: candidate?.revision, expectedSourceRevision: plan.source?.revision,
          changes, problems: [], similarCandidates,
        });
      } catch (error) {
        if (!(error instanceof TrackerError)) throw error;
        results.push({ rowNumber: row.rowNumber, status: "needs_attention", changes: [], problems: [error.data] });
      }
    }
    return results;
  },
});

export const startRun = signedInMutation({
  args: {
    collectionId: v.optional(v.id("collections")), idempotencyKey: uuid, format, fileName: v.optional(v.string()), fileHash: v.string(),
    totalRows: v.number(), mapping: v.optional(v.record(v.string(), v.string())), mode: v.optional(mode),
  }, returns: v.object({ collectionId: v.id("collections"), runId: v.id("importRuns") }),
  handler: async (ctx, args) => {
    const owner = await ensureTrackerUser(ctx);
    requireUuid(args.idempotencyKey, "idempotencyKey");
    const { collectionId: requested, ...command } = args;
    const commandHash = await hash({ ...command, mapping: args.mapping ?? {}, mode: args.mode ?? "merge_sources" });
    const owned = requested ? [await requireCollection(ctx, requested)] : [...await ownedCollections(ctx, owner._id, "active"), ...await ownedCollections(ctx, owner._id, "archived")];
    for (const collection of owned) {
      const prior = await findRun(ctx, collection._id, args.idempotencyKey);
      if (prior) {
        if (prior.commandHash !== commandHash) conflict("idempotencyKey", "operation_conflict", "This import identifier was already used with different settings.");
        return { collectionId: collection._id, runId: prior._id };
      }
    }
    if (!SHA256.test(args.fileHash)) invalid("fileHash", "Supply a valid SHA-256 file checksum.");
    const total = integer(args.totalRows, "totalRows", 1, rowLimit);
    const fileName = text(args.fileName, "fileName", 255);
    const mapping = args.mapping ?? {};
    if (Object.keys(mapping).length > 100) invalid("mapping", "Map at most 100 import columns.");
    for (const [key, value] of Object.entries(mapping)) {
      if (!key.trim() || key.length > 250 || !value.trim() || value.length > 250) invalid("mapping", "Use mapping keys and values up to 250 characters.");
    }
    const collection = await defaultCollection(ctx, owner._id, requested);
    const now = Date.now();
    const runId = await ctx.db.insert("importRuns", {
      collectionId: collection._id, publicId: newPublicId(), submittedByUserId: owner._id, createdAt: now, updatedAt: now, revision: 1,
      idempotencyKey: args.idempotencyKey, commandHash, format: args.format, fileName, fileHash: args.fileHash.toLowerCase(),
      mapping, normalizationVersion: 1, mode: args.mode ?? "merge_sources", state: "ready", counts: { total, accepted: 0, unchanged: 0, rejected: 0, conflict: 0, skipped: 0 },
    });
    await touchCollection(ctx, collection);
    return { collectionId: collection._id, runId };
  },
});

function operationForRow(collection: Collection, inputHash: string, operationHash: string): Operation {
  const operationId = `${operationHash.slice(0, 8)}-${operationHash.slice(8, 12)}-4${operationHash.slice(13, 16)}-8${operationHash.slice(17, 20)}-${operationHash.slice(20, 32)}`;
  return { collectionId: collection._id, ownerId: collection.ownerId, operationId, commandHash: inputHash };
}

async function applyRow(ctx: MutationCtx, row: ImportRow, plan: Awaited<ReturnType<typeof planRow>>, operation: Operation, importItemId: Id<"importItems">) {
  const fresh = !plan.candidate;
  const candidate = plan.candidate ?? await createCandidate(ctx, operation.collectionId, {
    location: plan.location, title: plan.title, progress: row.buyerPatch?.progress, shortlisted: row.buyerPatch?.shortlisted, customValues: plan.initialValues,
  });
  const applied = await applySource(ctx, candidate, operation, plan.plan, importItemId);
  const note = plan.note ? await applyNote(ctx, candidate._id, operation, plan.note, { importItemId }) : null;
  const meaningful = fresh || applied.meaningful || plan.values.changes.length > 0 || note?.changed === true;
  const patch = { ...plan.values.patch, ...(fresh ? { preferredSourceListingId: applied.sourceListingId } : {}) };
  if (fresh && !row.location && applied.observationId && (plan.location.rawAddress || plan.location.postalCode || plan.location.unitNumber)) {
    Object.assign(patch, { location: { ...plan.location, sourceListingId: applied.sourceListingId, observationId: applied.observationId } });
  }
  const revision = await refreshCandidate(ctx, candidate, patch, meaningful, fresh);
  if (fresh) {
    await writeEvent(ctx, operation, {
      candidateId: candidate._id, entity: { table: "candidates", publicId: candidate.publicId }, kind: "created", afterRevision: revision,
      changedFields: diffs({}, { title: candidate.title, location: candidate.location, progress: candidate.progress, shortlisted: candidate.shortlisted, customValues: candidate.customValues }), importItemId,
    });
  } else {
    await recordCandidateChange(ctx, operation, candidate, revision, plan.values.changes, importItemId);
  }
  return { candidateId: candidate._id, sourceListingId: applied.sourceListingId, observationId: applied.observationId, outcome: meaningful ? "accepted" as const : "unchanged" as const };
}

async function writeReceipt(ctx: MutationCtx, run: Run, row: ImportRow, inputHash: string, outcome: Receipt["outcome"], problems: Receipt["problems"]) {
  return ctx.db.insert("importItems", {
    collectionId: run.collectionId, importRunId: run._id, publicId: newPublicId(), rowKey: row.rowKey, logicalRowKey: row.logicalRowKey,
    rowNumber: row.rowNumber, inputHash, outcome, problems, supersedesItemId: row.supersedesItemId, recordedAt: Date.now(),
  });
}

export const commitRows = signedInMutation({
  args: { ...runAddress, rows: v.array(importRow) }, returns: v.array(importItemDoc),
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId);
    const run = await requireRun(ctx, args.collectionId, args.runId);
    validateBatch(args.rows);
    const counts = { ...run.counts };
    const results: Receipt[] = [];
    const acceptedByContent = new Map<string, Receipt>();
    let modified = false;
    for (const row of args.rows) {
      requireUuid(row.rowKey, "rowKey");
      requireUuid(row.logicalRowKey, "logicalRowKey");
      integer(row.rowNumber, "rowNumber", 1, rowLimit + 1);
      const inputHash = await hash(row);
      const prior = await ctx.db.query("importItems").withIndex("by_collectionId_and_importRunId_and_rowKey", q => q.eq("collectionId", args.collectionId).eq("importRunId", args.runId).eq("rowKey", row.rowKey)).unique();
      if (prior) {
        if (prior.inputHash !== inputHash) conflict("rowKey", "row_key_conflict", "This row identifier was already used for different input.");
        results.push(await redactDeletedHome(ctx, prior));
        continue;
      }
      if (collection.state !== "active") conflict("collection", "collection_unavailable", "Restore this archived collection before importing.");
      const latest = await ctx.db.query("importItems").withIndex("by_collectionId_and_importRunId_and_logicalRowKey", q => q.eq("collectionId", args.collectionId).eq("importRunId", args.runId).eq("logicalRowKey", row.logicalRowKey)).order("desc").first();
      const sameNumber = await ctx.db.query("importItems").withIndex("by_collectionId_and_importRunId_and_rowNumber", q => q.eq("collectionId", args.collectionId).eq("importRunId", args.runId).eq("rowNumber", row.rowNumber)).order("desc").first();
      if ((sameNumber && sameNumber.logicalRowKey !== row.logicalRowKey) || (latest && latest.rowNumber !== row.rowNumber)) {
        conflict("rowNumber", "logical_row_conflict", "Reuse this row's original logical identifier and row number when correcting it.");
      }
      if (latest) {
        if (latest._id !== row.supersedesItemId || (latest.outcome !== "rejected" && latest.outcome !== "conflict")) {
          conflict("supersedesItemId", "row_attempt_conflict", "Only the most recent unfinished attempt may be corrected.");
        }
      } else if (row.supersedesItemId) {
        invalid("supersedesItemId", "This row has no previous attempt in the current import.");
      } else if (counts.accepted + counts.unchanged + counts.rejected + counts.conflict + counts.skipped >= counts.total) {
        invalid("rowNumber", "This import already contains all its declared rows.");
      }
      let outcome: Receipt["outcome"] = row.skip ? "skipped" : "accepted";
      let problems: Receipt["problems"] = [];
      let plan: Awaited<ReturnType<typeof planRow>> | undefined;
      const { rowKey: _rowKey, logicalRowKey: _logicalRowKey, rowNumber: _rowNumber, supersedesItemId: _supersedesItemId, ...content } = row;
      const fingerprint = canonical(content);
      const equivalent = acceptedByContent.get(fingerprint);
      if (!row.skip && !equivalent) {
        try { plan = await planRow(ctx, collection, row, true, run.mode); }
        catch (error) {
          if (!(error instanceof TrackerError)) throw error;
          outcome = error.conflict ? "conflict" : "rejected";
          problems = [error.data];
        }
      }
      const itemId = await writeReceipt(ctx, run, row, inputHash, outcome, problems);
      if (equivalent) {
        outcome = "unchanged";
        await ctx.db.patch(itemId, { outcome, candidateId: equivalent.candidateId, sourceListingId: equivalent.sourceListingId, observationId: equivalent.observationId });
      } else if (plan) {
        const operationHash = await hash([run.publicId, row.rowKey]);
        const applied = await applyRow(ctx, row, plan, operationForRow(collection, inputHash, operationHash), itemId);
        outcome = applied.outcome;
        await ctx.db.patch(itemId, applied);
      }
      const receipt = (await ctx.db.get(itemId))!;
      if (plan) acceptedByContent.set(fingerprint, receipt);
      if (latest) counts[latest.outcome]--;
      counts[outcome]++;
      results.push(receipt);
      modified = true;
    }
    if (modified) {
      const done = counts.accepted + counts.unchanged + counts.rejected + counts.conflict + counts.skipped === counts.total;
      const now = Date.now();
      await ctx.db.patch(run._id, { counts, updatedAt: now, revision: run.revision + 1, state: done ? counts.rejected || counts.conflict ? "completed_with_errors" : "completed" : "applying", finishedAt: done ? now : undefined });
      await touchCollection(ctx, collection);
    }
    return results;
  },
});

export const runStatus = signedInQuery({
  args: { ...runAddress, paginationOpts: paginationOptsValidator },
  returns: v.object({ run: importRunDoc, items: v.object(pageFields(importItemDoc)) }),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collectionId);
    const run = await requireRun(ctx, args.collectionId, args.runId);
    const items = await ctx.db.query("importItems").withIndex("by_collectionId_and_importRunId_and_rowNumber", q => q.eq("collectionId", args.collectionId).eq("importRunId", args.runId)).paginate(boundedPagination(args.paginationOpts, 25));
    return { run, items: { ...items, page: await Promise.all(items.page.map(item => redactDeletedHome(ctx, item))) } };
  },
});
