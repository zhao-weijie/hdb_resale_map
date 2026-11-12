import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { backupTables } from "./backupSchema";
import {
  activeState, buyerFacts, candidateSummary, changedField, collectionState, comparisonContext,
  contactClaims, contactData, contactProvenance, customType, customValue,
  eventKind, fieldOption, importFormat, importMode, importOutcome, location, noteKind, problem, progress,
  recordState, reference, sourceAvailability, sourceCurrent, sourceFacts, timeBasis, trackerView, uuid,
} from "./trackerTypes";

const publicId = { publicId: uuid };
const child = { ...publicId, collectionId: v.id("collections") };
const mutable = { revision: v.number(), updatedAt: v.number() };

export default defineSchema({
  ...authTables,
  ...backupTables,
  trackerUsers: defineTable({
    tokenIdentifier: v.string(), displayName: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_tokenIdentifier", ["tokenIdentifier"]),
  collections: defineTable({
    ...publicId, ...mutable, ownerId: v.id("trackerUsers"), name: v.string(), state: collectionState,
    contentRevision: v.number(), candidateCount: v.number(), trackerView, schemaVersion: v.literal(1), createdAt: v.number(),
  }).index("by_ownerId_and_state", ["ownerId", "state"]),
  candidates: defineTable({
    ...child, ...mutable, title: v.optional(v.string()), recordState, progress, shortlisted: v.boolean(),
    nextViewingAt: v.optional(v.number()), viewingTimezone: v.optional(v.string()), lastContactAt: v.optional(v.number()),
    preferredSourceListingId: v.optional(v.id("sourceListings")), buyerFacts, location, customValues: v.array(customValue),
    summary: candidateSummary, lastMeaningfulChangeAt: v.number(), createdAt: v.number(),
  }).index("by_collectionId_and_recordState", ["collectionId", "recordState"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"])
    .index("by_collectionId_and_postalCode", ["collectionId", "location.postalCode"])
    .index("by_collectionId_and_rawAddress", ["collectionId", "location.rawAddress"]),
  sourceListings: defineTable({
    ...child, ...mutable, candidateId: v.id("candidates"), portal: v.string(), portalDisplayName: v.optional(v.string()),
    externalListingId: v.optional(v.string()), url: v.string(), canonicalUrl: v.string(), primaryIdentityKey: v.string(),
    current: sourceCurrent, availability: sourceAvailability, lastObservedAt: v.optional(v.number()), lastRecordedAt: v.number(),
    latestObservationId: v.optional(v.id("sourceObservations")), createdAt: v.number(),
  }).index("by_collectionId_and_candidateId", ["collectionId", "candidateId"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  sourceIdentities: defineTable({
    ...child, sourceListingId: v.id("sourceListings"), key: v.string(),
    kind: v.union(v.literal("portal_id"), v.literal("url"), v.literal("tracker_row")), recordedAt: v.number(),
  }).index("by_collectionId_and_key", ["collectionId", "key"])
    .index("by_collectionId_and_sourceListingId", ["collectionId", "sourceListingId"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  sourceObservations: defineTable({
    ...child, sourceListingId: v.id("sourceListings"), observedAt: v.optional(v.number()), timeBasis, recordedAt: v.number(),
    payloadVersion: v.literal(1), facts: sourceFacts, description: v.optional(v.string()), contactClaims: v.array(contactClaims),
    references: v.array(reference), contentHash: v.string(), submittedByUserId: v.id("trackerUsers"), importItemId: v.optional(v.id("importItems")),
  }).index("by_collectionId_and_sourceListingId_and_recordedAt", ["collectionId", "sourceListingId", "recordedAt"])
    .index("by_collection_source_observed_hash", ["collectionId", "sourceListingId", "observedAt", "contentHash"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  contacts: defineTable({
    ...child, ...mutable, ...contactData.fields, candidateId: v.id("candidates"), sourceListingId: v.optional(v.id("sourceListings")),
    managedBy: v.union(v.literal("buyer"), v.literal("source")), sourceContactKey: v.optional(v.string()),
    provenance: v.optional(contactProvenance), state: activeState,
  }).index("by_collectionId_and_candidateId", ["collectionId", "candidateId"])
    .index("by_collectionId_and_candidateId_and_state", ["collectionId", "candidateId", "state"])
    .index("by_collectionId_and_sourceListingId_and_sourceContactKey", ["collectionId", "sourceListingId", "sourceContactKey"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  customFields: defineTable({
    ...child, ...mutable, label: v.string(), type: customType, options: v.array(fieldOption), state: activeState, position: v.number(),
  }).index("by_collectionId_and_state_and_position", ["collectionId", "state", "position"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  notes: defineTable({
    ...child, ...mutable, candidateId: v.id("candidates"), kind: noteKind, body: v.string(), occurredAt: v.optional(v.number()),
    references: v.array(reference), comparisonContext: v.optional(comparisonContext), authorUserId: v.id("trackerUsers"), createdAt: v.number(),
    state: v.union(v.literal("active"), v.literal("deleted")),
  }).index("by_collectionId_and_candidateId_and_createdAt", ["collectionId", "candidateId", "createdAt"])
    .index("by_collectionId_and_candidateId_and_state_and_createdAt", ["collectionId", "candidateId", "state", "createdAt"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  importRuns: defineTable({
    ...child, ...mutable, submittedByUserId: v.id("trackerUsers"), createdAt: v.number(), idempotencyKey: uuid,
    commandHash: v.string(), format: importFormat, fileName: v.optional(v.string()), fileHash: v.string(), mapping: v.record(v.string(), v.string()),
    normalizationVersion: v.literal(1), mode: importMode,
    state: v.union(v.literal("ready"), v.literal("applying"), v.literal("completed"), v.literal("completed_with_errors"), v.literal("cancelled")),
    counts: v.object({ total: v.number(), accepted: v.number(), unchanged: v.number(), rejected: v.number(), conflict: v.number(), skipped: v.number() }),
    finishedAt: v.optional(v.number()),
  }).index("by_collectionId_and_idempotencyKey", ["collectionId", "idempotencyKey"])
    .index("by_collectionId_and_createdAt", ["collectionId", "createdAt"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  importItems: defineTable({
    ...child, importRunId: v.id("importRuns"), rowKey: uuid, logicalRowKey: uuid, rowNumber: v.number(), inputHash: v.string(),
    outcome: importOutcome, candidateId: v.optional(v.id("candidates")), sourceListingId: v.optional(v.id("sourceListings")),
    observationId: v.optional(v.id("sourceObservations")), supersedesItemId: v.optional(v.id("importItems")), problems: v.array(problem), recordedAt: v.number(),
  }).index("by_collectionId_and_importRunId_and_rowKey", ["collectionId", "importRunId", "rowKey"])
    .index("by_collectionId_and_importRunId_and_rowNumber", ["collectionId", "importRunId", "rowNumber"])
    .index("by_collectionId_and_importRunId_and_logicalRowKey", ["collectionId", "importRunId", "logicalRowKey"])
    .index("by_collectionId_and_candidateId", ["collectionId", "candidateId"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
  changeEvents: defineTable({
    ...child, candidateId: v.optional(v.id("candidates")), entity: v.object({
      table: v.union(v.literal("collections"), v.literal("candidates"), v.literal("sourceListings"), v.literal("contacts"), v.literal("notes"), v.literal("customFields")), publicId: uuid,
    }), eventVersion: v.literal(1), operationId: uuid, commandHash: v.string(), kind: eventKind,
    actor: v.object({ kind: v.literal("buyer"), userId: v.id("trackerUsers") }), beforeRevision: v.optional(v.number()),
    afterRevision: v.optional(v.number()), candidateRevision: v.optional(v.number()), changedFields: v.array(changedField), affectsCurrentFacts: v.optional(v.boolean()),
    observationId: v.optional(v.id("sourceObservations")), importItemId: v.optional(v.id("importItems")), recordedAt: v.number(),
  }).index("by_collectionId_and_recordedAt", ["collectionId", "recordedAt"])
    .index("by_collectionId_and_candidateId_and_recordedAt", ["collectionId", "candidateId", "recordedAt"])
    .index("by_collectionId_and_operationId", ["collectionId", "operationId"])
    .index("by_collectionId_and_publicId", ["collectionId", "publicId"]),
});
