import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { requireCollection, signedInMutation, touchCollection } from "./access";
import { backupTableNames, restoreIdleMs, unfinishedRestoreStates } from "./backupSchema";
import { checkRevision, invalid } from "./trackerValidation";

const collectionArgs = { collectionId: v.id("collections") };
const candidateArgs = { ...collectionArgs, candidateId: v.id("candidates") };
const confirmArgs = { expectedRevision: v.number(), confirmation: v.literal("delete") };
const trackedJob = { tracked: v.optional(v.literal(true)) };
const batchSize = 12;

async function purgePending(ctx: MutationCtx, jobId: Id<"_scheduled_functions"> | undefined) {
  const job = jobId && await ctx.db.system.get("_scheduled_functions", jobId);
  return job?.state.kind === "pending" || job?.state.kind === "inProgress";
}

async function scheduleCandidatePurge(ctx: MutationCtx, collectionId: Id<"collections">, candidateId: Id<"candidates">): Promise<void> {
  const purgeJobId = await ctx.scheduler.runAfter(0, internal.lifecycle.purgeCandidate, { collectionId, candidateId, tracked: true });
  await ctx.db.patch(candidateId, { purgeJobId });
}

async function scheduleCollectionPurge(ctx: MutationCtx, collectionId: Id<"collections">): Promise<void> {
  const purgeJobId = await ctx.scheduler.runAfter(0, internal.lifecycle.purgeCollection, { collectionId, tracked: true });
  await ctx.db.patch(collectionId, { purgeJobId });
}

async function startCollectionPurge(ctx: MutationCtx, collection: Doc<"collections">): Promise<void> {
  if (collection.state !== "deleting") {
    await ctx.db.patch(collection._id, { state: "deleting", revision: collection.revision + 1 });
    await touchCollection(ctx, collection);
  }
  if (!await purgePending(ctx, collection.purgeJobId)) await scheduleCollectionPurge(ctx, collection._id);
}

export const deleteCandidate = signedInMutation({
  args: { ...candidateArgs, ...confirmArgs }, returns: v.null(),
  handler: async (ctx, { collectionId, candidateId, expectedRevision }) => {
    const collection = await requireCollection(ctx, collectionId);
    const candidate = await ctx.db.get(candidateId);
    if (!candidate || candidate.collectionId !== collectionId) invalid("candidateId", "This saved home is unavailable.");
    if (candidate.recordState !== "deleting") {
      checkRevision(expectedRevision, candidate.revision);
      if (candidate.recordState !== "archived") invalid("recordState", "Archive this home before permanently deleting it.");
      await ctx.db.patch(candidateId, { recordState: "deleting", revision: candidate.revision + 1, updatedAt: Date.now() });
      await touchCollection(ctx, collection);
    }
    if (!await purgePending(ctx, candidate.purgeJobId)) await scheduleCandidatePurge(ctx, collectionId, candidateId);
    return null;
  },
});

export const deleteCollection = signedInMutation({
  args: { ...collectionArgs, ...confirmArgs }, returns: v.null(),
  handler: async (ctx, { collectionId, expectedRevision }) => {
    const collection = await requireCollection(ctx, collectionId, ["active", "archived", "restoring", "deleting"]);
    if (collection.state !== "deleting") checkRevision(expectedRevision, collection.revision);
    await startCollectionPurge(ctx, collection);
    return null;
  },
});

async function removeBatch(ctx: MutationCtx, rows: readonly { _id: Parameters<MutationCtx["db"]["delete"]>[0] }[]) {
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length > 0;
}

async function purgeCandidateBatch(ctx: MutationCtx, collectionId: Id<"collections">, candidateId: Id<"candidates">) {
  const receipts = await ctx.db.query("importItems").withIndex("by_collectionId_and_candidateId", q =>
    q.eq("collectionId", collectionId).eq("candidateId", candidateId)).take(batchSize);
  if (receipts.length) {
    for (const item of receipts) {
      await ctx.db.patch(item._id, { candidateId: undefined, sourceListingId: undefined, observationId: undefined });
    }
    return true;
  }
  const events = await ctx.db.query("changeEvents").withIndex("by_collectionId_and_candidateId_and_recordedAt", q =>
    q.eq("collectionId", collectionId).eq("candidateId", candidateId)).take(batchSize);
  if (await removeBatch(ctx, events)) return true;
  const notes = await ctx.db.query("notes").withIndex("by_collectionId_and_candidateId_and_createdAt", q =>
    q.eq("collectionId", collectionId).eq("candidateId", candidateId)).take(batchSize);
  if (await removeBatch(ctx, notes)) return true;
  const contacts = await ctx.db.query("contacts").withIndex("by_collectionId_and_candidateId", q =>
    q.eq("collectionId", collectionId).eq("candidateId", candidateId)).take(batchSize);
  if (await removeBatch(ctx, contacts)) return true;
  const source = await ctx.db.query("sourceListings").withIndex("by_collectionId_and_candidateId", q =>
    q.eq("collectionId", collectionId).eq("candidateId", candidateId)).first();
  if (!source) return false;
  const observations = await ctx.db.query("sourceObservations").withIndex("by_collectionId_and_sourceListingId_and_recordedAt", q =>
    q.eq("collectionId", collectionId).eq("sourceListingId", source._id)).take(batchSize);
  if (await removeBatch(ctx, observations)) return true;
  const aliases = await ctx.db.query("sourceIdentities").withIndex("by_collectionId_and_sourceListingId", q =>
    q.eq("collectionId", collectionId).eq("sourceListingId", source._id)).take(batchSize);
  await removeBatch(ctx, aliases);
  if (aliases.length < batchSize) await ctx.db.delete(source._id);
  return true;
}

export const purgeCandidate = internalMutation({
  args: { ...candidateArgs, ...trackedJob }, returns: v.null(),
  handler: async (ctx, { collectionId, candidateId, tracked }): Promise<null> => {
    const collection = await ctx.db.get(collectionId);
    const candidate = await ctx.db.get(candidateId);
    if (!collection || (collection.state !== "active" && collection.state !== "archived") || candidate?.collectionId !== collectionId || candidate.recordState !== "deleting") return null;
    // A queued job from before tracking was introduced may run only until the chain has a tracked successor.
    if (!tracked && candidate.purgeJobId) return null;
    if (await purgeCandidateBatch(ctx, collectionId, candidateId)) {
      await scheduleCandidatePurge(ctx, collectionId, candidateId);
    } else {
      await ctx.db.delete(candidateId);
      await ctx.db.patch(collectionId, { candidateCount: collection.candidateCount - 1 });
      await touchCollection(ctx, collection);
    }
    return null;
  },
});

const collectionTables = [...backupTableNames].reverse();

async function purgeCollectionBatch(ctx: MutationCtx, collectionId: Id<"collections">) {
  const staged = await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_ordinal", q =>
    q.eq("collectionId", collectionId)).take(batchSize);
  if (await removeBatch(ctx, staged)) return true;
  for (const table of collectionTables) {
    const rows = await ctx.db.query(table).withIndex("by_collectionId_and_publicId", q =>
      q.eq("collectionId", collectionId)).take(batchSize);
    if (await removeBatch(ctx, rows)) return true;
  }
  const restores = await ctx.db.query("backupRestores").withIndex("by_collectionId", q =>
    q.eq("collectionId", collectionId)).take(batchSize);
  return removeBatch(ctx, restores);
}

export const purgeCollection = internalMutation({
  args: { ...collectionArgs, ...trackedJob }, returns: v.null(),
  handler: async (ctx, { collectionId, tracked }): Promise<null> => {
    const collection = await ctx.db.get(collectionId);
    if (collection?.state !== "deleting") return null;
    if (!tracked && collection.purgeJobId) return null;
    if (await purgeCollectionBatch(ctx, collectionId)) {
      await scheduleCollectionPurge(ctx, collectionId);
    } else await ctx.db.delete(collectionId);
    return null;
  },
});

export const expireRestores = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const cutoff = Date.now() - restoreIdleMs;
    for (const state of unfinishedRestoreStates) {
      const stale = await ctx.db.query("backupRestores").withIndex("by_state_and_updatedAt", q =>
        q.eq("state", state).lte("updatedAt", cutoff)).take(8);
      for (const restore of stale) {
        const collection = await ctx.db.get(restore.collectionId);
        if (collection?.ownerId === restore.ownerId && (collection.state === "restoring" || collection.state === "deleting")) {
          await startCollectionPurge(ctx, collection);
        }
      }
    }
    return null;
  },
});
