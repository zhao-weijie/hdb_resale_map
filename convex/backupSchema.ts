import { defineTable } from "convex/server";
import { v } from "convex/values";
import { trackerView, uuid } from "./trackerTypes";

export const backupTableNames = [
  "customFields", "candidates", "sourceListings", "sourceIdentities", "importRuns",
  "sourceObservations", "contacts", "notes", "importItems", "changeEvents",
] as const;
export type BackupTable = typeof backupTableNames[number];
export const backupTable = v.union(...backupTableNames.map(table => v.literal(table)));
export const restoreIdleMs = 48 * 60 * 60 * 1000;
export const unfinishedRestoreStates = ["uploading", "inserting", "linking", "summarizing", "discarding"] as const;
export const restoreHeader = v.object({
  name: v.string(), trackerView, createdAt: v.number(), collectionPublicId: uuid,
  contentRevision: v.number(), exportedAt: v.number(),
});

export const backupTables = {
  backupRestores: defineTable({
    ownerId: v.id("trackerUsers"), collectionId: v.id("collections"),
    restoreKey: uuid, fileHash: v.string(), header: restoreHeader,
    expectedCount: v.number(), receivedCount: v.number(), processedCount: v.number(), receivedBytes: v.optional(v.number()),
    state: v.union(v.literal("uploading"), v.literal("inserting"), v.literal("linking"), v.literal("summarizing"), v.literal("complete"), v.literal("discarding")),
    tableIndex: v.number(), cursor: v.union(v.string(), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_ownerId_and_restoreKey", ["ownerId", "restoreKey"])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_collectionId", ["collectionId"])
    .index("by_state_and_updatedAt", ["state", "updatedAt"]),
  backupRestoreItems: defineTable({
    collectionId: v.id("collections"), table: backupTable,
    publicId: uuid, ordinal: v.number(), payload: v.record(v.string(), v.any()),
  }).index("by_collectionId_and_ordinal", ["collectionId", "ordinal"])
    .index("by_collectionId_and_table_and_publicId", ["collectionId", "table", "publicId"]),
};
