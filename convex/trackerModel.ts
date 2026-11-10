import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireCollection } from "./access";
import { buyerFactsInput, customValueEdit, locationInput, trackerView, type ChangedField } from "./trackerTypes";
import { calendarDate, conflict, finite, invalid, newPublicId, normalizedFacts, normalizedLocation, requireUuid, same, text, timestamp, timezone } from "./trackerValidation";

type ReadCtx = Pick<QueryCtx, "db">;
type Candidate = Doc<"candidates">;
export const limits = { collections: 50, candidates: 1000, sources: 10, contacts: 20, customFields: 30, options: 50, aliases: 10 };
export const emptySummary: Candidate["summary"] = { facts: {}, sourceCount: 0, availability: { reported: false, value: "unknown" }, availabilityConflict: false };
export const defaultTrackerView: Infer<typeof trackerView> = { columnOrder: [], hiddenColumns: [], sort: { key: "createdAt", direction: "desc" } };

export async function ownedCollections(ctx: ReadCtx, ownerId: Id<"trackerUsers">, state: Doc<"collections">["state"]) {
  return ctx.db.query("collections").withIndex("by_ownerId_and_state", q => q.eq("ownerId", ownerId).eq("state", state)).take(limits.collections);
}

export async function checkCollectionCapacity(ctx: ReadCtx, ownerId: Id<"trackerUsers">, additional: 0 | 1 = 1) {
  const states = ["active", "archived", "restoring", "deleting"] as const;
  const owned = await Promise.all(states.map(state => ownedCollections(ctx, ownerId, state)));
  if (owned.reduce((count, collections) => count + collections.length, 0) + additional > limits.collections) {
    invalid("collection", "This account has reached its collection limit. Deleting collections still count until cleanup finishes.");
  }
}

export async function insertCollection(ctx: MutationCtx, ownerId: Id<"trackerUsers">, name = "My home search") {
  await checkCollectionCapacity(ctx, ownerId);
  const now = Date.now();
  const collectionId = await ctx.db.insert("collections", {
    publicId: newPublicId(), ownerId, name, state: "active", revision: 1, contentRevision: 0, candidateCount: 0,
    schemaVersion: 1, trackerView: defaultTrackerView, createdAt: now, updatedAt: now,
  });
  return (await ctx.db.get(collectionId))!;
}

export async function defaultCollection(ctx: MutationCtx, ownerId: Id<"trackerUsers">, collectionId?: Id<"collections">) {
  if (collectionId) return requireCollection(ctx, collectionId, ["active"]);
  const existing = await ctx.db.query("collections").withIndex("by_ownerId_and_state", q => q.eq("ownerId", ownerId).eq("state", "active")).first();
  return existing ?? insertCollection(ctx, ownerId);
}

export async function checkCandidateCapacity(ctx: ReadCtx, collectionId: Id<"collections">) {
  const collection = await ctx.db.get(collectionId);
  if (!collection || collection.candidateCount >= limits.candidates) invalid("collection", "This collection has reached its 1,000-home limit.");
}

export async function createCandidate(ctx: MutationCtx, collectionId: Id<"collections">, data: Pick<Candidate, "location" | "title"> & Partial<Pick<Candidate, "buyerFacts" | "progress" | "shortlisted" | "customValues">>) {
  const collection = (await ctx.db.get(collectionId))!;
  const now = Date.now();
  const candidateId = await ctx.db.insert("candidates", {
    collectionId, publicId: newPublicId(), recordState: "active",
    buyerFacts: {}, customValues: [], summary: emptySummary, ...data,
    progress: data.progress ?? "new", shortlisted: data.shortlisted ?? false,
    revision: 1, createdAt: now, updatedAt: now, lastMeaningfulChangeAt: now,
  });
  await ctx.db.patch(collectionId, { candidateCount: collection.candidateCount + 1 });
  return (await ctx.db.get(candidateId))!;
}

export async function candidateSources(ctx: ReadCtx, candidate: Pick<Candidate, "collectionId" | "_id">) {
  return ctx.db.query("sourceListings").withIndex("by_collectionId_and_candidateId", q => q.eq("collectionId", candidate.collectionId).eq("candidateId", candidate._id)).take(limits.sources);
}

export async function candidateContacts(ctx: ReadCtx, candidate: Pick<Candidate, "collectionId" | "_id">) {
  return ctx.db.query("contacts").withIndex("by_collectionId_and_candidateId_and_state", q => q.eq("collectionId", candidate.collectionId).eq("candidateId", candidate._id).eq("state", "active")).take(limits.contacts);
}

export function sourceName(source: Pick<Doc<"sourceListings">, "portal" | "portalDisplayName" | "canonicalUrl">) {
  const names: Record<string, string> = { propertyguru: "PropertyGuru", "99co": "99.co", srx: "SRX", edgeprop: "EdgeProp", carousell: "Carousell", hdb: "HDB" };
  return source.portalDisplayName ?? names[source.portal] ?? new URL(source.canonicalUrl).hostname;
}

const buyerFactFields = ["flatType", "area", "floor", "flatModel", "completionYear", "leaseCommencementYear"] as const;
export async function rebuildCandidateSummary(ctx: ReadCtx, candidate: Pick<Candidate, "collectionId" | "_id" | "preferredSourceListingId" | "buyerFacts">): Promise<Candidate["summary"]> {
  const sources = await candidateSources(ctx, candidate);
  const selected = sources.find(source => source._id === candidate.preferredSourceListingId);
  const facts: Candidate["summary"]["facts"] = {};
  for (const key of buyerFactFields) {
    const buyer = candidate.buyerFacts[key];
    const source = selected?.current[key];
    if (buyer) Object.assign(facts, { [key]: { value: buyer.value, basis: buyer.basis, ...buyer.adopted && { sourceListingId: buyer.adopted.sourceListingId, observationId: buyer.adopted.observationId } } });
    else if (source) Object.assign(facts, { [key]: { ...source, sourceListingId: selected._id } });
  }
  const ask = selected?.current.askingPriceCents;
  const statuses = new Set(sources.map(source => source.availability.value).filter(value => value !== "unknown"));
  const observed = sources.flatMap(source => source.lastObservedAt === undefined ? [] : [source.lastObservedAt]);
  return {
    facts, sourceCount: sources.length, availability: selected?.availability ?? emptySummary.availability, availabilityConflict: statuses.size > 1,
    lastSourceObservedAt: observed.length ? Math.max(...observed) : undefined,
    askingSourceListingId: selected?._id, askingSourceName: selected && sourceName(selected), askingObservationId: ask?.observationId,
    askingPriceCents: ask?.value, askingObservedAt: ask?.observedAt, askingTimeBasis: ask?.timeBasis, askingLastConfirmedAt: ask?.lastConfirmedAt,
  };
}

export async function refreshCandidate(ctx: MutationCtx, candidate: Candidate, patch: Partial<Candidate>, meaningful: boolean, initial = false) {
  const updated = { ...candidate, ...patch };
  const summary = await rebuildCandidateSummary(ctx, updated);
  const change = meaningful || Object.keys(patch).length > 0 || !same(candidate.summary, summary);
  if (!change) return candidate.revision;
  const now = Date.now();
  const revision = initial ? candidate.revision : candidate.revision + 1;
  await ctx.db.patch(candidate._id, { ...patch, summary, revision, updatedAt: now, ...(meaningful ? { lastMeaningfulChangeAt: now } : {}) });
  return revision;
}

export function diffs(previous: Record<string, unknown>, next: Record<string, unknown>): ChangedField[] {
  return Object.entries(next).flatMap(([field, after]) => same(previous[field], after) ? [] : [{ field, before: previous[field] ?? null, after: after ?? null }]);
}

export async function previousOperation(ctx: ReadCtx, collectionId: Id<"collections">, operationId: string, commandHash: string) {
  requireUuid(operationId, "operationId");
  const events = await ctx.db.query("changeEvents").withIndex("by_collectionId_and_operationId", q => q.eq("collectionId", collectionId).eq("operationId", operationId)).take(30);
  if (events.some(event => event.commandHash !== commandHash)) conflict("operationId", "operation_conflict", "This save identifier was already used for a different change.");
  return events;
}

type Event = Omit<Doc<"changeEvents">, "_id" | "_creationTime" | "publicId" | "collectionId" | "eventVersion" | "operationId" | "commandHash" | "actor" | "recordedAt">;
export interface Operation { collectionId: Id<"collections">; ownerId: Id<"trackerUsers">; operationId: string; commandHash: string }
export async function writeEvent(ctx: MutationCtx, operation: Operation, event: Event) {
  return ctx.db.insert("changeEvents", {
    ...event, collectionId: operation.collectionId, publicId: newPublicId(), eventVersion: 1, operationId: operation.operationId,
    commandHash: operation.commandHash, actor: { kind: "buyer", userId: operation.ownerId }, recordedAt: Date.now(),
  });
}

export async function customValueChanges(ctx: ReadCtx, collectionId: Id<"collections"> | undefined, previous: Candidate["customValues"], edits: Infer<typeof customValueEdit>[]) {
  if (edits.length > limits.customFields) invalid("customValues", "This operation contains too many custom fields.");
  const values = new Map(previous.map(value => [value.fieldId, value]));
  const seen = new Set<string>();
  for (const edit of edits) {
    const fieldId = requireUuid(edit.fieldId, "customValues.fieldId");
    if (seen.has(fieldId)) invalid("customValues", "Edit each custom field only once per save.");
    seen.add(fieldId);
    const field = collectionId && await ctx.db.query("customFields").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collectionId).eq("publicId", fieldId)).unique();
    if (!field || field.state !== "active") invalid("customValues", "Choose an active field in this collection.");
    if (edit.type === "unset") { values.delete(fieldId); continue; }
    if (field.type !== edit.type) invalid("customValues", `“${field.label}” requires a ${field.type.replace(/_/g, " ")} value.`);
    if (edit.type === "single_select") {
      const option = field.options.find(item => item.id === edit.optionId);
      if (!option || (option.archived && !same(values.get(fieldId), edit))) invalid("customValues", `Choose an active option for “${field.label}”.`);
    }
    if (edit.type === "text") {
      if (edit.value.length > 2000 || !edit.value.trim()) invalid("customValues", "Use 1–2,000 characters for custom text, or clear the field.");
    }
    if (edit.type === "number") finite(edit.value, "customValues");
    if (edit.type === "date") calendarDate(edit.value);
    values.set(fieldId, edit);
  }
  return [...values.values()];
}

type CandidatePatch = {
  title?: string | null; location?: Infer<typeof locationInput>; progress?: Candidate["progress"]; shortlisted?: boolean;
  nextViewingAt?: number | null; viewingTimezone?: string | null; lastContactAt?: number | null;
  preferredSourceListingId?: Id<"sourceListings">; recordState?: "active" | "archived"; customValues?: Infer<typeof customValueEdit>[];
  buyerFacts?: Infer<typeof buyerFactsInput>;
};

export async function planCandidatePatch(ctx: ReadCtx, candidate: Candidate, input: CandidatePatch) {
  const patch: Partial<Candidate> = {};
  if (input.title !== undefined) patch.title = text(input.title, "title", 120);
  if (input.location) patch.location = normalizedLocation(input.location, candidate.location);
  if (input.progress) patch.progress = input.progress;
  if (input.shortlisted !== undefined) patch.shortlisted = input.shortlisted;
  if (input.recordState) patch.recordState = input.recordState;
  if (input.lastContactAt !== undefined) patch.lastContactAt = timestamp(input.lastContactAt, "lastContactAt");
  if (input.nextViewingAt !== undefined || input.viewingTimezone !== undefined) {
    patch.nextViewingAt = input.nextViewingAt === undefined ? candidate.nextViewingAt : timestamp(input.nextViewingAt, "nextViewingAt");
    patch.viewingTimezone = patch.nextViewingAt === undefined ? undefined : timezone(input.viewingTimezone ?? candidate.viewingTimezone ?? "Asia/Singapore");
  }
  if (input.preferredSourceListingId) {
    const source = await ctx.db.get(input.preferredSourceListingId);
    if (!source || source.collectionId !== candidate.collectionId || source.candidateId !== candidate._id) invalid("preferredSourceListingId", "Choose a source belonging to this saved home.");
    patch.preferredSourceListingId = source._id;
  }
  if (input.customValues) patch.customValues = await customValueChanges(ctx, candidate.collectionId, candidate.customValues, input.customValues);
  if (input.buyerFacts) {
    const overrides = { ...candidate.buyerFacts };
    for (const field of buyerFactFields) {
      const value = input.buyerFacts[field];
      if (value === undefined) continue;
      if (value === null) { delete overrides[field]; continue; }
      const normalized = normalizedFacts({ [field]: value.value })[field];
      const reason = text(value.reason, "buyerFacts.reason", 2000);
      const previous = overrides[field];
      if (value.source) {
        const [source, observation] = await Promise.all([ctx.db.get(value.source.sourceListingId), ctx.db.get(value.source.observationId)]);
        if (!source || source.collectionId !== candidate.collectionId || source.candidateId !== candidate._id || !observation || observation.collectionId !== candidate.collectionId || observation.sourceListingId !== source._id || !same(observation.facts[field], normalized)) {
          invalid(field, "Select an actual claim from one of this home's saved advertisements.");
        }
        if (previous?.adopted?.observationId === value.source.observationId && same(previous.value, normalized) && previous.reason === reason) continue;
      } else if (previous?.basis === "buyer_entered" && same(previous.value, normalized) && previous.reason === reason) continue;
      Object.assign(overrides, { [field]: { value: normalized, reason, basis: value.source ? "adopted_source_claim" : "buyer_entered", updatedAt: Date.now(), adopted: value.source && { ...value.source, adoptedAt: Date.now() } } });
    }
    patch.buyerFacts = overrides;
  }
  const changes = diffs(candidate, patch);
  return { patch: Object.fromEntries(changes.map(change => [change.field, patch[change.field as keyof Candidate]])) as Partial<Candidate>, changes };
}

export function candidateEventKind(changes: ChangedField[]): Doc<"changeEvents">["kind"] {
  const fields = new Set(changes.map(change => change.field));
  if (fields.has("recordState")) return changes.find(change => change.field === "recordState")?.after === "active" ? "restored" : "archived";
  if (fields.has("location")) return "location_confirmed";
  if (fields.has("nextViewingAt")) return "viewing_changed";
  if (fields.has("progress")) return "progress_changed";
  if (fields.has("lastContactAt")) return "contact_changed";
  if (fields.has("customValues")) return "custom_field_changed";
  return "buyer_edited";
}

export async function recordCandidateChange(ctx: MutationCtx, operation: Operation, candidate: Candidate, revision: number, changes: ChangedField[], importItemId?: Id<"importItems">) {
  if (!changes.length) return;
  await writeEvent(ctx, operation, {
    candidateId: candidate._id, entity: { table: "candidates", publicId: candidate.publicId }, kind: candidateEventKind(changes),
    beforeRevision: candidate.revision, afterRevision: revision, changedFields: changes, importItemId,
  });
}
