import { ConvexError, getConvexSize, getDocumentSize, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { backupTable, backupTableNames, restoreHeader, restoreIdleMs, unfinishedRestoreStates, type BackupTable } from "./backupSchema";
import { ensureTrackerUser, getTrackerUser, requireCollection } from "./access";
import { checkCollectionCapacity, limits, rebuildCandidateSummary } from "./trackerModel";
import { UUID, calendarDate, canonical, canonicalizeUrl, normalizedFacts, normalizedLocation, parseLink, validateComparison, validateReferences } from "./trackerValidation";

const pageSize = 10;
const pageBytes = 2 * 1024 * 1024;
const uploadBytes = 4 * 1024 * 1024;
const chunkRows = 25;
const maxRestoreRows = 50_000;
const maxRestoreBytes = 64 * 1024 * 1024;
const maxRecordBytes = 1024 * 1024;
const maxLegacyRowsToMeasure = 4_000;
const ownerRole = "collection_owner";
const emptySummary = {
  facts: {}, sourceCount: 0, availability: { reported: false, value: "unknown" }, availabilityConflict: false,
} as const;

const valueRecord = v.record(v.string(), v.any());
type Payload = Record<string, unknown>;
type BackupId = Id<BackupTable>;
type BackupDoc = Doc<BackupTable>;
type ExportContext = Pick<QueryCtx, "db">;
type LinkContext = ExportContext | MutationCtx;
const referenceTables = {
  candidateId: "candidates", preferredSourceListingId: "sourceListings", sourceListingId: "sourceListings",
  askingSourceListingId: "sourceListings", observationId: "sourceObservations",
  latestObservationId: "sourceObservations", askingObservationId: "sourceObservations", noteId: "notes",
  importItemId: "importItems", supersedesItemId: "importItems", importRunId: "importRuns",
  contactId: "contacts", collectionId: "collections", userId: "trackerUsers",
  submittedByUserId: "trackerUsers", authorUserId: "trackerUsers",
} as const;
type ReferenceTable = typeof referenceTables[keyof typeof referenceTables];
type MapId = (table: ReferenceTable, value: string) => Promise<string>;
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
const objectValue = (value: unknown): value is Payload => value !== null && typeof value === "object" && !Array.isArray(value);

function fail(message: string): never {
  throw new ConvexError(message);
}
function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail("The backup contains an invalid portable ID.");
}
function count(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("The backup contains an invalid count or revision.");
}
function boundedText(value: unknown, length: number): void {
  if (value !== undefined && (typeof value !== "string" || value.length > length)) fail("The backup contains a text field that exceeds the tracker limit.");
}
function limit(value: unknown, max: number): void {
  if (!Array.isArray(value) || value.length > max) fail("The backup contains a list that exceeds the tracker limit.");
}

function checkPortableValue(value: unknown, depth = 0): void {
  if (depth > 24) fail("The backup contains a deeply nested record.");
  if (value instanceof ArrayBuffer || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) {
    fail("Backup records must contain only JSON values.");
  }
  if (Array.isArray(value) || objectValue(value)) {
    for (const child of Object.values(value)) checkPortableValue(child, depth + 1);
  }
}

async function remapReferences(value: unknown, mapId: MapId, key = "", depth = 0): Promise<unknown> {
  if (depth > 24) fail("The backup contains a deeply nested record.");
  if (Array.isArray(value)) {
    const mapped: unknown[] = [];
    for (const child of value) mapped.push(await remapReferences(child, mapId, key, depth + 1));
    return mapped;
  }
  if (objectValue(value)) {
    const mapped: Payload = {};
    for (const [field, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(field)) fail("The backup contains a reserved key.");
      // Spreadsheet mapping keys are user-provided column names, never references.
      if (field === "mapping") mapped[field] = child;
      else if ((field === "before" || field === "after") && typeof value.field === "string") {
        mapped[field] = await remapReferences(child, mapId, value.field, depth + 1);
      } else {
        mapped[field] = await remapReferences(child, mapId, field, depth + 1);
      }
    }
    return mapped;
  }
  if (typeof value === "number" && !Number.isFinite(value)) fail("The backup contains a non-finite number.");
  if (typeof value === "string" && own(referenceTables, key)) return mapId(referenceTables[key as keyof typeof referenceTables], value);
  return value;
}

function exportMapper(ctx: ExportContext, collection: Doc<"collections">): MapId {
  const ids = new Map<string, string>();
  return async (table, value) => {
    if (table === "trackerUsers") {
      if (value !== collection.ownerId) fail("The collection has an invalid author reference.");
      return ownerRole;
    }
    if (table === "collections") {
      if (value !== collection._id) fail("The collection has an invalid collection reference.");
      return collection.publicId;
    }
    const key = table + "/" + value;
    const known = ids.get(key);
    if (known) return known;
    const id = ctx.db.normalizeId(table, value);
    const doc = id && await ctx.db.get(id);
    if (!doc || doc.collectionId !== collection._id) fail("The collection has a missing " + table + " reference.");
    ids.set(key, doc.publicId);
    return doc.publicId;
  };
}

async function portableRecord(doc: BackupDoc, mapId: MapId): Promise<Payload> {
  const { _id, _creationTime, collectionId, ...rest } = doc;
  const payload: Payload = rest;
  if ("summary" in payload) delete payload.summary;
  if ("purgeJobId" in payload) delete payload.purgeJobId;
  return await remapReferences(payload, mapId) as Payload;
}

async function requireExportableCollection(ctx: QueryCtx, collectionId: Id<"collections">) {
  const collection = await requireCollection(ctx, collectionId);
  const deletingHome = await ctx.db.query("candidates").withIndex("by_collectionId_and_recordState",
    q => q.eq("collectionId", collectionId).eq("recordState", "deleting")).first();
  if (deletingHome) fail("Wait for home deletion to finish, then download a fresh copy.");
  return collection;
}

export const exportHeader = query({
  args: { collectionId: v.id("collections") },
  returns: restoreHeader,
  handler: async (ctx, { collectionId }) => {
    const { name, trackerView, publicId, contentRevision, createdAt } = await requireExportableCollection(ctx, collectionId);
    return { name, trackerView, collectionPublicId: publicId, contentRevision, exportedAt: Date.now(), createdAt };
  },
});

export const exportPage = query({
  args: {
    collectionId: v.id("collections"), contentRevision: v.number(),
    table: backupTable, cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ rows: v.array(valueRecord), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { collectionId, contentRevision, table, cursor }) => {
    const collection = await requireExportableCollection(ctx, collectionId);
    if (collection.contentRevision !== contentRevision) fail("The collection changed during export. Download a fresh copy.");
    const page = await ctx.db.query(table).withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId))
      .paginate({ cursor, numItems: pageSize, maximumBytesRead: pageBytes });
    const mapId = exportMapper(ctx, collection);
    const rows: Payload[] = [];
    for (const doc of page.page) rows.push(await portableRecord(doc, mapId));
    return { rows, cursor: page.continueCursor, done: page.isDone };
  },
});

const stateValidator = v.object({
  collectionId: v.id("collections"), state: v.union(
    v.literal("uploading"), v.literal("inserting"), v.literal("linking"),
    v.literal("summarizing"), v.literal("complete"), v.literal("discarding"),
  ),
  expectedCount: v.number(), receivedCount: v.number(), processedCount: v.number(),
});
function status(restore: Doc<"backupRestores">) {
  const { collectionId, state, expectedCount, receivedCount, processedCount } = restore;
  return { collectionId, state, expectedCount, receivedCount, processedCount };
}

function checkRestoreProgress(restore: Doc<"backupRestores">) {
  if (restore.state === "complete") return;
  if (restore.state === "discarding") fail("This restore is being discarded.");
  if (restore.updatedAt <= Date.now() - restoreIdleMs) fail("This restore expired after 48 hours of inactivity. Discard it and start again.");
}

function checkRestoreRowCount(expectedCount: number) {
  if (expectedCount > maxRestoreRows) fail("The backup exceeds the 50,000-record restore limit.");
}

async function restoreReceivedBytes(ctx: MutationCtx, restore: Doc<"backupRestores">): Promise<number> {
  if (restore.receivedBytes !== undefined) return restore.receivedBytes;
  if (!restore.receivedCount) return 0;
  // A pre-limit upload can resume if its accounting can be rebuilt in one bounded read.
  if (restore.receivedCount > maxLegacyRowsToMeasure) fail("Discard this older restore and start again to apply the new restore size limit.");
  const result = await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_ordinal", q =>
    q.eq("collectionId", restore.collectionId)).paginate({
    cursor: null, numItems: maxLegacyRowsToMeasure + 1, maximumBytesRead: uploadBytes,
  });
  if (!result.isDone || result.page.length !== restore.receivedCount) fail("Discard this older restore and start again to apply the new restore size limit.");
  return result.page.reduce((total, row) => total + getDocumentSize(row), 0);
}

async function getRestore(ctx: MutationCtx, collectionId: Id<"collections">) {
  const collection = await requireCollection(ctx, collectionId, ["restoring", "active", "archived"]);
  const restore = await ctx.db.query("backupRestores").withIndex("by_collectionId", q => q.eq("collectionId", collectionId)).unique();
  if (!restore || restore.ownerId !== collection.ownerId) fail("Restore session unavailable.");
  const validStates = restore.state === "complete" ? ["active", "archived"] : ["restoring"];
  if (!validStates.includes(collection.state)) fail("Restore session unavailable.");
  return { restore, collection };
}

const restorePointer = v.object({ collectionId: v.id("collections"), key: v.string(), hash: v.string() });
export const pendingRestore = query({
  args: {}, returns: v.union(v.null(), restorePointer),
  handler: async ctx => {
    const owner = await getTrackerUser(ctx);
    if (!owner) return null;
    const collection = await ctx.db.query("collections").withIndex("by_ownerId_and_state",
      q => q.eq("ownerId", owner._id).eq("state", "restoring")).first();
    if (!collection) return null;
    const restore = await ctx.db.query("backupRestores").withIndex("by_collectionId", q => q.eq("collectionId", collection._id)).unique();
    if (!restore || restore.ownerId !== owner._id) return null;
    return { collectionId: restore.collectionId, key: restore.restoreKey, hash: restore.fileHash };
  },
});

export const beginRestore = mutation({
  args: { restoreKey: v.string(), fileHash: v.string(), expectedCount: v.number(), header: restoreHeader },
  returns: stateValidator,
  handler: async (ctx, { restoreKey, fileHash, expectedCount, header }) => {
    const owner = await ensureTrackerUser(ctx);
    assertUuid(restoreKey);
    assertUuid(header.collectionPublicId);
    count(expectedCount);
    count(header.contentRevision);
    count(header.createdAt);
    count(header.exportedAt);
    boundedText(header.name, 120);
    if (!header.name.trim()) fail("The backup collection needs a name.");
    if (!/^[a-f0-9]{64}$/.test(fileHash)) fail("The backup checksum is invalid.");
    limit(header.trackerView.columnOrder, 150);
    limit(header.trackerView.hiddenColumns, 150);
    if (getConvexSize(header) > 32 * 1024) fail("The backup header exceeds the restore size limit.");
    const existing = await ctx.db.query("backupRestores")
      .withIndex("by_ownerId_and_restoreKey", q => q.eq("ownerId", owner._id).eq("restoreKey", restoreKey)).unique();
    if (existing) {
      if (existing.fileHash !== fileHash || existing.expectedCount !== expectedCount) fail("Choose the original file to resume this restore.");
      const { restore } = await getRestore(ctx, existing.collectionId);
      checkRestoreProgress(restore);
      return status(restore);
    }
    checkRestoreRowCount(expectedCount);
    await checkCollectionCapacity(ctx, owner._id);
    const unfinished = await Promise.all(unfinishedRestoreStates.map(state => ctx.db.query("backupRestores")
      .withIndex("by_ownerId_and_state", q => q.eq("ownerId", owner._id).eq("state", state)).first()));
    if (unfinished.some(Boolean)) fail("Resume or discard the interrupted backup restore before starting another. Wait for any restore cleanup to finish.");
    // Each restore creates an independently owned collection, preserving its portable lineage.
    const now = Date.now();
    const collectionId = await ctx.db.insert("collections", {
      publicId: header.collectionPublicId, ownerId: owner._id, name: header.name, state: "restoring",
      trackerView: header.trackerView, revision: 1, contentRevision: header.contentRevision, candidateCount: 0,
      schemaVersion: 1, createdAt: header.createdAt, updatedAt: now,
    });
    const restore = {
      collectionId, ownerId: owner._id, restoreKey, fileHash, header, expectedCount,
      receivedCount: 0, processedCount: 0, receivedBytes: 0, state: "uploading" as const, tableIndex: 0,
      cursor: null, createdAt: now, updatedAt: now,
    };
    await ctx.db.insert("backupRestores", restore);
    return status(restore as Doc<"backupRestores">);
  },
});

export const uploadPage = mutation({
  args: { collectionId: v.id("collections"), offset: v.number(), rows: v.array(v.object({ table: backupTable, payload: valueRecord })) },
  returns: stateValidator,
  handler: async (ctx, { collectionId, offset, rows }) => {
    const { restore } = await getRestore(ctx, collectionId);
    checkRestoreProgress(restore);
    if (restore.state !== "uploading") return status(restore);
    checkRestoreRowCount(restore.expectedCount);
    count(offset);
    if (!rows.length || rows.length > chunkRows || getConvexSize(rows) > uploadBytes) fail("Reduce the restore batch size.");
    if (offset > restore.receivedCount || offset + rows.length > restore.expectedCount) fail("The restore upload is out of order.");
    let receivedBytes = restore.receivedBytes;
    for (const [index, { table, payload }] of rows.entries()) {
      const ordinal = offset + index;
      if (ordinal < restore.receivedCount) {
        const saved = await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_ordinal",
          q => q.eq("collectionId", collectionId).eq("ordinal", ordinal)).unique();
        if (!saved || saved.table !== table || canonical(saved.payload) !== canonical(payload)) fail("A retried upload differs from the original backup.");
        continue;
      }
      const publicId = payload.publicId;
      assertUuid(publicId);
      if (own(payload, "_id") || own(payload, "_creationTime") || own(payload, "collectionId")) fail("The backup contains an internal record field.");
      checkPortableValue(payload);
      verifyRecord(table, payload);
      const existing = await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_table_and_publicId",
        q => q.eq("collectionId", collectionId).eq("table", table).eq("publicId", publicId)).unique();
      if (existing) fail("A " + table + " record appears twice in the backup.");
      const staged = { collectionId, table, publicId, payload, ordinal };
      const bytes = getDocumentSize(staged);
      if (bytes > maxRecordBytes) fail("One backup record exceeds the restore size limit.");
      receivedBytes = (receivedBytes ?? await restoreReceivedBytes(ctx, restore)) + bytes;
      if (receivedBytes > maxRestoreBytes) fail("The backup exceeds the 64 MiB restore limit.");
      await ctx.db.insert("backupRestoreItems", staged);
    }
    const receivedCount = Math.max(restore.receivedCount, offset + rows.length);
    if (receivedCount === restore.receivedCount) return status(restore);
    await ctx.db.patch(restore._id, { receivedCount, receivedBytes, updatedAt: Date.now() });
    return status({ ...restore, receivedCount });
  },
});

async function byPublicId(ctx: LinkContext, table: BackupTable, collectionId: Id<"collections">, publicId: string): Promise<BackupDoc | null> {
  return await ctx.db.query(table).withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId).eq("publicId", publicId)).unique();
}
function restoreMapper(ctx: LinkContext, collection: Doc<"collections">): MapId {
  const ids = new Map<string, string>();
  return async (table, value) => {
    if (table === "trackerUsers") {
      if (value !== ownerRole) fail("A backup author must be the collection owner.");
      return collection.ownerId;
    }
    assertUuid(value);
    if (table === "collections") {
      if (value !== collection.publicId) fail("The backup contains an invalid collection reference.");
      return collection._id;
    }
    const key = table + "/" + value;
    const known = ids.get(key);
    if (known) return known;
    const doc = await byPublicId(ctx, table, collection._id, value);
    if (!doc) fail("The backup is missing a referenced " + table + " record.");
    ids.set(key, doc._id);
    return doc._id;
  };
}

function shell(table: BackupTable, value: Payload): Payload {
  const payload = { ...value };
  // Required parents are inserted first. Forward references are filled in the linking pass.
  if (table === "candidates") {
    delete payload.preferredSourceListingId;
    payload.buyerFacts = {};
    payload.location = { status: "unresolved" };
    payload.customValues = [];
    payload.summary = emptySummary;
  } else if (table === "sourceListings") {
    delete payload.latestObservationId;
    payload.current = {};
    payload.availability = emptySummary.availability;
  } else if (table === "sourceObservations") {
    delete payload.importItemId;
  } else if (table === "notes") {
    delete payload.comparisonContext;
  } else if (table === "importItems") {
    delete payload.supersedesItemId;
  } else if (table === "changeEvents") {
    payload.changedFields = [];
  }
  return payload;
}

function verifyRecord(table: BackupTable, payload: Payload): void {
  if (own(payload, "purgeJobId")) fail("The backup contains an internal record field.");
  if (own(payload, "revision")) count(payload.revision, 1);
  if (table === "sourceListings") {
    if (typeof payload.url !== "string" || typeof payload.canonicalUrl !== "string") fail("A listing URL is missing.");
    if (canonicalizeUrl(payload.url).canonicalUrl !== payload.canonicalUrl) fail("A listing URL does not match its canonical identity.");
  } else if (table === "notes") {
    boundedText(payload.body, 10_000);
    if (objectValue(payload.comparisonContext)) limit(payload.comparisonContext.comparables, 100);
  } else if (table === "sourceObservations") {
    boundedText(payload.description, 30_000);
    limit(payload.contactClaims, 20);
    normalizedFacts(payload.facts as Doc<"sourceObservations">["facts"]);
  } else if (table === "customFields") {
    boundedText(payload.label, 120);
    limit(payload.options, 50);
    const seen = new Set<string>();
    for (const option of payload.options as Payload[]) {
      if (!objectValue(option)) fail("A custom option is invalid.");
      assertUuid(option.id);
      boundedText(option.label, 120);
      if (seen.has(option.id)) fail("A custom option appears twice.");
      seen.add(option.id);
    }
  } else if (table === "candidates") {
    boundedText(payload.title, 120);
    limit(payload.customValues, limits.customFields);
    if (objectValue(payload.location)) normalizedLocation(payload.location as Doc<"candidates">["location"]);
    if (payload.recordState === "deleting") fail("Finish deleting homes before backing up this collection.");
  }
  if (own(payload, "references")) {
    limit(payload.references, 20);
    for (const reference of payload.references as Payload[]) {
      if (!objectValue(reference)) fail("An attachment reference is invalid.");
      if (typeof reference.url !== "string") fail("An attachment URL is missing.");
      parseLink(reference.url, "references", true);
    }
  }
}

async function verifyIdentity(ctx: MutationCtx, collectionId: Id<"collections">, table: BackupTable, payload: Payload): Promise<void> {
  if (table === "sourceIdentities") {
    if (typeof payload.key !== "string") fail("A source identity key is missing.");
    const duplicate = await ctx.db.query("sourceIdentities").withIndex("by_collectionId_and_key",
      q => q.eq("collectionId", collectionId).eq("key", payload.key as string)).first();
    if (duplicate) fail("Two source records have the same listing identity.");
  } else if (table === "importRuns") {
    assertUuid(payload.idempotencyKey);
    const duplicate = await ctx.db.query("importRuns").withIndex("by_collectionId_and_idempotencyKey",
      q => q.eq("collectionId", collectionId).eq("idempotencyKey", payload.idempotencyKey as string)).first();
    if (duplicate) fail("Two import runs have the same retry key.");
  } else if (table === "importItems") {
    assertUuid(payload.rowKey);
    assertUuid(payload.logicalRowKey);
    const duplicate = await ctx.db.query("importItems").withIndex("by_collectionId_and_importRunId_and_rowKey",
      q => q.eq("collectionId", collectionId).eq("importRunId", payload.importRunId as Id<"importRuns">).eq("rowKey", payload.rowKey as string)).first();
    if (duplicate) fail("Two import receipts have the same row key.");
  }
}

async function checkRelationships(ctx: MutationCtx, table: BackupTable, value: Payload): Promise<void> {
  if (table === "sourceListings") {
    const source = value as unknown as Doc<"sourceListings">;
    const evidence = [source.latestObservationId, ...Object.values(source.current).map(field => field?.observationId),
      source.availability.reported ? source.availability.observationId : undefined];
    for (const id of new Set(evidence)) {
      if (id && (await ctx.db.get(id))?.sourceListingId !== source._id) fail("A source projection refers to evidence from another listing.");
    }
    const identities = await ctx.db.query("sourceIdentities").withIndex("by_collectionId_and_sourceListingId",
      q => q.eq("collectionId", source.collectionId).eq("sourceListingId", source._id)).take(11);
    const hasAlias = (key: string, kind: Doc<"sourceIdentities">["kind"]) =>
      identities.some(identity => identity.key === key && identity.kind === kind);
    if (identities.length > limits.aliases ||
        !identities.some(identity => identity.key === source.primaryIdentityKey) ||
        !hasAlias("url:" + source.canonicalUrl, "url") ||
        (source.portal !== "other" && source.externalListingId &&
          !hasAlias("portal:" + source.portal + ":" + source.externalListingId, "portal_id"))) {
      fail("A listing is missing an identity key required for reimport.");
    }
  } else if (table === "contacts") {
    const contact = value as unknown as Doc<"contacts">;
    if (contact.sourceListingId && (await ctx.db.get(contact.sourceListingId))?.candidateId !== contact.candidateId) {
      fail("A contact is associated with another home's listing.");
    }
    for (const evidence of Object.values(contact.provenance ?? {})) {
      if (evidence && (await ctx.db.get(evidence.observationId))?.sourceListingId !== contact.sourceListingId) {
        fail("A contact refers to evidence from another listing.");
      }
    }
  } else if (table === "notes") {
    const note = value as unknown as Doc<"notes">;
    await validateReferences(ctx, note.references, note.collectionId, note.candidateId);
    const candidate = await ctx.db.get(note.candidateId);
    if (note.comparisonContext && candidate) await validateComparison(ctx, note.comparisonContext, candidate);
  } else if (table === "sourceObservations") {
    const observation = value as unknown as Doc<"sourceObservations">;
    const source = await ctx.db.get(observation.sourceListingId);
    await validateReferences(ctx, observation.references, observation.collectionId, source?.candidateId);
  } else if (table === "importItems") {
    const receipt = value as unknown as Doc<"importItems">;
    const { candidateId, sourceListingId, observationId, supersedesItemId } = receipt;
    if (candidateId || sourceListingId || observationId) {
      const source = sourceListingId && await ctx.db.get(sourceListingId);
      const observation = observationId && await ctx.db.get(observationId);
      if (!candidateId || !source || source.candidateId !== candidateId ||
          (observationId && (!observation || observation.sourceListingId !== sourceListingId))) {
        fail("An import receipt refers to an unrelated home, listing or observation.");
      }
    }
    if (supersedesItemId) {
      const prior = await ctx.db.get(supersedesItemId);
      if (!prior || prior.importRunId !== receipt.importRunId || prior.logicalRowKey !== receipt.logicalRowKey ||
          prior.rowNumber !== receipt.rowNumber || (prior.outcome !== "rejected" && prior.outcome !== "conflict")) {
        fail("An import receipt refers to an unrelated row attempt.");
      }
    }
  } else if (table === "changeEvents") {
    const event = value as unknown as Doc<"changeEvents">;
    const { entity, candidateId, collectionId, observationId, importItemId } = event;
    if (entity.table === "collections") {
      if (entity.publicId !== (await ctx.db.get(collectionId))?.publicId || candidateId) fail("A history entry belongs to another collection.");
    } else {
      const record = await byPublicId(ctx, entity.table, collectionId, entity.publicId);
      const expectedCandidate = record && (entity.table === "candidates" ? record._id :
        "candidateId" in record ? record.candidateId : undefined);
      if (!record || expectedCandidate !== candidateId) fail("A history entry belongs to another home.");
    }
    if (observationId) {
      const observation = await ctx.db.get(observationId);
      const source = observation && await ctx.db.get(observation.sourceListingId);
      if (!source || source.candidateId !== candidateId) fail("A history entry refers to another home's observation.");
    }
    if (importItemId && (await ctx.db.get(importItemId))?.candidateId !== candidateId) {
      fail("A history entry refers to another home's import receipt.");
    }
  }
}

export const advanceRestore = mutation({
  args: { collectionId: v.id("collections") },
  returns: stateValidator,
  handler: async (ctx, { collectionId }) => {
    const { restore, collection } = await getRestore(ctx, collectionId);
    if (restore.state === "complete") return status(restore);
    checkRestoreProgress(restore);
    const update = async (patch: Partial<Doc<"backupRestores">>) => {
      await ctx.db.patch(restore._id, { ...patch, updatedAt: Date.now() });
      return status({ ...restore, ...patch });
    };
    if (restore.state === "uploading") {
      if (restore.receivedCount !== restore.expectedCount) fail("Upload every backup record before restoring.");
      checkRestoreRowCount(restore.expectedCount);
      const receivedBytes = await restoreReceivedBytes(ctx, restore);
      if (receivedBytes > maxRestoreBytes) fail("The backup exceeds the 64 MiB restore limit.");
      return update({ state: "inserting", receivedBytes });
    }
    if (restore.state === "summarizing") {
      const page = await ctx.db.query("candidates").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId))
        .paginate({ cursor: restore.cursor, numItems: pageSize });
      for (const candidate of page.page) {
        const sources = await ctx.db.query("sourceListings").withIndex("by_collectionId_and_candidateId",
          q => q.eq("collectionId", collectionId).eq("candidateId", candidate._id)).take(11);
        if (!sources.length || sources.length > 10) fail("Every restored home needs between one and ten listing URLs.");
        if (candidate.preferredSourceListingId && !sources.some(source => source._id === candidate.preferredSourceListingId)) {
          fail("A home's display listing belongs to another home.");
        }
        const contacts = await ctx.db.query("contacts").withIndex("by_collectionId_and_candidateId_and_state",
          q => q.eq("collectionId", collectionId).eq("candidateId", candidate._id).eq("state", "active")).take(limits.contacts + 1);
        if (contacts.length > limits.contacts) fail("A home exceeds the current contact limit.");
        const buyerEvidence = Object.values(candidate.buyerFacts).map(field => field?.adopted);
        for (const evidence of [candidate.location, ...buyerEvidence]) {
          if (!evidence) continue;
          const { sourceListingId, observationId } = evidence;
          const observation = observationId && await ctx.db.get(observationId);
          if ((sourceListingId && !sources.some(source => source._id === sourceListingId)) ||
              (observationId && (!observation || observation.sourceListingId !== sourceListingId))) {
            fail("A home refers to evidence from another listing.");
          }
        }
        const seen = new Set<string>();
        for (const value of candidate.customValues) {
          const field = await byPublicId(ctx, "customFields", collectionId, value.fieldId) as Doc<"customFields"> | null;
          if (!field || field.type !== value.type || seen.has(value.fieldId)) fail("A home's custom value has no matching column.");
          if (value.type === "single_select" && !field.options.some(option => option.id === value.optionId)) fail("A home's custom option is missing.");
          if (value.type === "date") calendarDate(value.value);
          if (value.type === "text") boundedText(value.value, 2_000);
          seen.add(value.fieldId);
        }
        await ctx.db.patch(candidate._id, { summary: await rebuildCandidateSummary(ctx, candidate) });
      }
      const processedCount = restore.processedCount + page.page.length;
      if (processedCount > 1000) fail("The backup exceeds the collection's 1,000-home limit.");
      if (!page.isDone) return update({ cursor: page.continueCursor, processedCount });
      if ((await ctx.db.query("customFields").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId)).take(31)).length > 30) {
        fail("The backup exceeds the collection's 30 custom columns.");
      }
      await checkCollectionCapacity(ctx, collection.ownerId, 0);
      await ctx.db.patch(collectionId, { state: "active", candidateCount: processedCount, updatedAt: Date.now() });
      return update({ state: "complete", cursor: null, processedCount: restore.expectedCount });
    }
    const table = backupTableNames[restore.tableIndex];
    if (!table) {
      return update({ state: restore.state === "inserting" ? "linking" : "summarizing", tableIndex: 0, cursor: null, processedCount: 0 });
    }
    const page = await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_table_and_publicId",
      q => q.eq("collectionId", collectionId).eq("table", table))
      .paginate({ cursor: restore.cursor, numItems: pageSize, maximumBytesRead: pageBytes });
    const mapId = restoreMapper(ctx, collection);
    for (const item of page.page) {
      const base = restore.state === "inserting" ? shell(table, item.payload) : item.payload;
      const payload: Payload = { ...await remapReferences(base, mapId) as Payload, collectionId };
      verifyRecord(table, payload);
      if (restore.state === "inserting") {
        await verifyIdentity(ctx, collectionId, table, payload);
        await ctx.db.insert(table, payload as never);
      } else {
        const existing = await byPublicId(ctx, table, collectionId, item.publicId);
        if (!existing) fail("A restore record is missing.");
        await checkRelationships(ctx, table, { ...payload, _id: existing._id });
        if (table === "candidates") payload.summary = emptySummary;
        await ctx.db.replace(existing._id as BackupId, payload as never);
        await ctx.db.delete(item._id);
      }
    }
    return update({
      cursor: page.isDone ? null : page.continueCursor,
      tableIndex: restore.tableIndex + Number(page.isDone),
      processedCount: restore.processedCount + page.page.length,
    });
  },
});

export const discardRestore = mutation({
  args: { collectionId: v.id("collections") },
  returns: v.boolean(),
  handler: async (ctx, { collectionId }) => {
    const { restore } = await getRestore(ctx, collectionId);
    if (restore.state === "complete") fail("This restore is already active.");
    const staged = await ctx.db.query("backupRestoreItems").withIndex("by_collectionId_and_ordinal", q => q.eq("collectionId", collectionId)).take(pageSize);
    for (const item of staged) await ctx.db.delete(item._id);
    if (staged.length) {
      await ctx.db.patch(restore._id, { state: "discarding" });
      return false;
    }
    for (const table of [...backupTableNames].reverse()) {
      const rows = await ctx.db.query(table).withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId)).take(pageSize);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) {
        await ctx.db.patch(restore._id, { state: "discarding" });
        return false;
      }
    }
    await ctx.db.delete(restore._id);
    await ctx.db.delete(collectionId);
    return true;
  },
});
