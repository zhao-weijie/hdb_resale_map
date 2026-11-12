import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ensureTrackerUser, getTrackerUser, getVisibleCandidate, requireCandidate, requireCollection, signedInMutation, signedInQuery, touchCollection } from "./access";
import { applyNote, planNote } from "./noteModel";
import { applySource, planSource, resolveSource } from "./sourceModel";
import { candidateDoc, changeEventDoc, collectionDoc, contactDoc, customFieldDoc, noteDoc, observationDoc, pageFields, sourceDoc } from "./trackerDocs";
import { candidateContacts, candidateSources, checkCandidateCapacity, createCandidate, defaultCollection, diffs, insertCollection, limits, ownedCollections, planCandidatePatch, previousOperation, recordCandidateChange, refreshCandidate, sourceName, writeEvent, type Operation } from "./trackerModel";
import { activeState, buyerFactsInput, comparisonContext, contactData, customType, customValueEdit, fieldOption, locationInput, manualSource, noteKind, progress, reference, timeBasis, trackerView, uuid, type ContactData, type ManualSource } from "./trackerTypes";
import { boundedPagination, checkRevision, conflict, contactValues, hash, invalid, newPublicId, normalizedLocation, requireUuid, requiredText, text } from "./trackerValidation";

const home = { collectionId: v.id("collections"), candidateId: v.id("candidates") };
const paginatedHome = { ...home, paginationOpts: paginationOptsValidator };
const candidateCommand = { ...home, operationId: uuid, expectedRevision: v.number() };
const optionalTime = v.optional(v.union(v.number(), v.null()));
const optionalText = v.optional(v.union(v.string(), v.null()));
const buyerStatePatch = {
  progress: v.optional(progress), shortlisted: v.optional(v.boolean()), nextViewingAt: optionalTime,
  viewingTimezone: optionalText, lastContactAt: optionalTime,
};
const revisionResult = v.object({ revision: v.number() });
const homeResult = v.object({ collectionId: v.id("collections"), candidateId: v.id("candidates"), revision: v.number() });

function operation(collection: Doc<"collections">, operationId: string, commandHash: string): Operation {
  return { collectionId: collection._id, ownerId: collection.ownerId, operationId, commandHash };
}

async function existingCommand(ctx: QueryCtx, collection: Doc<"collections">, operationId: string, commandHash: string) {
  return previousOperation(ctx, collection._id, operationId, commandHash);
}

export const listCollections = signedInQuery({
  args: {}, returns: v.array(collectionDoc),
  handler: async ctx => {
    const user = await getTrackerUser(ctx);
    if (!user) return [];
    const [active, archived] = await Promise.all([ownedCollections(ctx, user._id, "active"), ownedCollections(ctx, user._id, "archived")]);
    return [...active, ...archived];
  },
});

export const createCollection = signedInMutation({
  args: { name: v.optional(v.string()), operationId: v.optional(uuid) }, returns: v.id("collections"),
  handler: async (ctx, args) => {
    const user = await ensureTrackerUser(ctx);
    const operationId = args.operationId ?? newPublicId();
    const commandHash = await hash({ type: "createCollection", args });
    if (args.operationId) {
      const owned = [...await ownedCollections(ctx, user._id, "active"), ...await ownedCollections(ctx, user._id, "archived")];
      for (const collection of owned) {
        if ((await existingCommand(ctx, collection, operationId, commandHash)).length) return collection._id;
      }
    }
    const collection = await insertCollection(ctx, user._id, args.name === undefined ? undefined : requiredText(args.name, "name", 120));
    await writeEvent(ctx, operation(collection, operationId, commandHash), {
      entity: { table: "collections", publicId: collection.publicId }, kind: "created", afterRevision: collection.revision,
      changedFields: [{ field: "name", before: null, after: collection.name }],
    });
    await touchCollection(ctx, collection);
    return collection._id;
  },
});

export const updateCollection = signedInMutation({
  args: { collectionId: v.id("collections"), operationId: uuid, expectedRevision: v.number(), name: v.optional(v.string()), state: v.optional(activeState), trackerView: v.optional(trackerView) }, returns: revisionResult,
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId);
    const commandHash = await hash({ type: "updateCollection", args });
    const [prior] = await existingCommand(ctx, collection, args.operationId, commandHash);
    if (prior) return { revision: prior.afterRevision! };
    checkRevision(args.expectedRevision, collection.revision);
    const view = args.trackerView;
    if (view) {
      for (const entries of [view.columnOrder, view.hiddenColumns]) {
        if (entries.length > 64 || new Set(entries).size !== entries.length) invalid("trackerView", "Each column can appear only once, up to 64 columns.");
        entries.forEach(key => requiredText(key, "columnKey", 120));
      }
      requiredText(view.sort.key, "sort.key", 120);
      text(view.filters?.query, "filters.query", 500);
    }
    const next = { name: args.name === undefined ? collection.name : requiredText(args.name, "name", 120), state: args.state ?? collection.state, trackerView: view ?? collection.trackerView };
    const changedFields = diffs(collection, next);
    if (!changedFields.length) return { revision: collection.revision };
    const revision = collection.revision + 1;
    await ctx.db.patch(collection._id, { ...next, revision });
    await writeEvent(ctx, operation(collection, args.operationId, commandHash), {
      entity: { table: "collections", publicId: collection.publicId }, kind: next.state === collection.state ? "buyer_edited" : next.state === "archived" ? "archived" : "restored",
      beforeRevision: collection.revision, afterRevision: revision, changedFields,
    });
    await touchCollection(ctx, collection);
    return { revision };
  },
});

export const listCandidates = signedInQuery({
  args: { collectionId: v.id("collections"), paginationOpts: paginationOptsValidator, recordState: v.optional(activeState) },
  returns: v.object({ ...pageFields(candidateDoc), contentRevision: v.number() }),
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId);
    const result = await ctx.db.query("candidates").withIndex("by_collectionId_and_recordState", q => q.eq("collectionId", args.collectionId).eq("recordState", args.recordState ?? "active")).order("desc").paginate(boundedPagination(args.paginationOpts, 50));
    return { ...result, contentRevision: collection.contentRevision };
  },
});

export const candidateDetail = signedInQuery({
  args: home, returns: v.object({ candidate: candidateDoc, sources: v.array(sourceDoc), contacts: v.array(contactDoc) }),
  handler: async (ctx, args) => {
    const candidate = await requireCandidate(ctx, args.collectionId, args.candidateId);
    const [sources, contacts] = await Promise.all([candidateSources(ctx, candidate), candidateContacts(ctx, candidate)]);
    return { candidate, sources, contacts };
  },
});

export const listNotes = signedInQuery({
  args: paginatedHome, returns: v.object(pageFields(noteDoc)),
  handler: async (ctx, args) => {
    await requireCandidate(ctx, args.collectionId, args.candidateId);
    return ctx.db.query("notes").withIndex("by_collectionId_and_candidateId_and_state_and_createdAt", q => q.eq("collectionId", args.collectionId).eq("candidateId", args.candidateId).eq("state", "active")).order("desc").paginate(boundedPagination(args.paginationOpts, 25));
  },
});

export const sourceHistory = signedInQuery({
  args: { ...paginatedHome, sourceListingId: v.id("sourceListings") }, returns: v.object(pageFields(observationDoc)),
  handler: async (ctx, args) => {
    await requireCandidate(ctx, args.collectionId, args.candidateId);
    const source = await ctx.db.get(args.sourceListingId);
    if (!source || source.collectionId !== args.collectionId || source.candidateId !== args.candidateId) invalid("sourceListingId", "This advertisement is unavailable.");
    return ctx.db.query("sourceObservations").withIndex("by_collectionId_and_sourceListingId_and_recordedAt", q => q.eq("collectionId", args.collectionId).eq("sourceListingId", args.sourceListingId)).order("desc").paginate(boundedPagination(args.paginationOpts, 25));
  },
});

const timelineDoc = v.object({ ...changeEventDoc.fields, actorName: v.optional(v.string()), sourceName: v.optional(v.string()), observedAt: v.optional(v.number()), timeBasis: v.optional(timeBasis) });
export const history = signedInQuery({
  args: paginatedHome, returns: v.object(pageFields(timelineDoc)),
  handler: async (ctx, args) => {
    await requireCandidate(ctx, args.collectionId, args.candidateId);
    const result = await ctx.db.query("changeEvents").withIndex("by_collectionId_and_candidateId_and_recordedAt", q => q.eq("collectionId", args.collectionId).eq("candidateId", args.candidateId)).order("desc").paginate(boundedPagination(args.paginationOpts, 25));
    const user = await getTrackerUser(ctx);
    const page = await Promise.all(result.page.map(async event => {
      const observation = event.observationId ? await ctx.db.get(event.observationId) : null;
      const source = observation ? await ctx.db.get(observation.sourceListingId) : null;
      return { ...event, actorName: user?.displayName, sourceName: source ? sourceName(source) : undefined, observedAt: observation?.observedAt, timeBasis: observation?.timeBasis };
    }));
    return { ...result, page };
  },
});

export const collectionHistory = signedInQuery({
  args: { collectionId: v.id("collections"), paginationOpts: paginationOptsValidator }, returns: v.object(pageFields(changeEventDoc)),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collectionId);
    const result = await ctx.db.query("changeEvents").withIndex("by_collectionId_and_recordedAt", q => q.eq("collectionId", args.collectionId)).order("desc").paginate(boundedPagination(args.paginationOpts, 25));
    const page = await Promise.all(result.page.map(async event =>
      !event.candidateId || await getVisibleCandidate(ctx, args.collectionId, event.candidateId) ? event : null,
    ));
    return { ...result, page: page.filter(event => event !== null) };
  },
});

async function prepareManualSource(ctx: QueryCtx, collectionId: Id<"collections">, input: ManualSource, candidate: Doc<"candidates"> | null) {
  const identity = await resolveSource(ctx, collectionId, input);
  if (identity.source) conflict("url", "source_exists", "This advertisement already belongs to a saved home. Open that home to edit it.");
  const contact = input.contact && contactValues(input.contact);
  const plan = await planSource(ctx, collectionId, identity, input, candidate, true);
  return { plan, contact: contact && Object.values(contact).some(value => value !== undefined) ? contact : undefined };
}

async function insertManualContact(ctx: MutationCtx, command: Operation, candidateId: Id<"candidates">, sourceListingId: Id<"sourceListings">, contact: ContactData) {
  const publicId = newPublicId();
  await ctx.db.insert("contacts", { ...contact, publicId, collectionId: command.collectionId, candidateId, sourceListingId, managedBy: "buyer", state: "active", revision: 1, updatedAt: Date.now() });
  await writeEvent(ctx, command, { candidateId, entity: { table: "contacts", publicId }, kind: "contact_changed", afterRevision: 1, changedFields: diffs({}, contact) });
}

export const saveHome = signedInMutation({
  args: { collectionId: v.optional(v.id("collections")), operationId: uuid, title: v.optional(v.string()), location: v.optional(locationInput), sources: v.array(manualSource) }, returns: homeResult,
  handler: async (ctx, args) => {
    const user = await ensureTrackerUser(ctx);
    const commandHash = await hash({ type: "saveHome", args });
    const owned = args.collectionId ? [await requireCollection(ctx, args.collectionId)] : [...await ownedCollections(ctx, user._id, "active"), ...await ownedCollections(ctx, user._id, "archived")];
    for (const collection of owned) {
      const prior = (await existingCommand(ctx, collection, args.operationId, commandHash)).find(event => event.entity.table === "candidates");
      if (prior?.candidateId) return { collectionId: collection._id, candidateId: prior.candidateId, revision: prior.afterRevision! };
    }
    requireUuid(args.operationId, "operationId");
    if (!args.sources.length || args.sources.length > limits.sources) invalid("sources", "Save between one and ten listing URLs per home.");
    const collection = await defaultCollection(ctx, user._id, args.collectionId);
    await checkCandidateCapacity(ctx, collection._id);
    const plans = await Promise.all(args.sources.map(input => prepareManualSource(ctx, collection._id, input, null)));
    const aliases = plans.flatMap(source => source.plan.aliases.map(alias => alias.key));
    if (aliases.length !== new Set(aliases).size) conflict("sources", "duplicate_source", "Each listing URL and portal identity may appear only once.");
    const { rawAddress, postalCode, unitNumber } = plans[0].plan.facts;
    const location = normalizedLocation(args.location ?? { status: "unresolved", rawAddress: rawAddress ?? undefined, postalCode: postalCode ?? undefined, unitNumber: unitNumber ?? undefined });
    const title = text(args.title, "title", 120);
    if (!title && !location.rawAddress && !location.postalCode) invalid("title", "Enter an address, postal code or label to identify this home.");
    const candidate = await createCandidate(ctx, collection._id, { title, location });
    const command = operation(collection, args.operationId, commandHash);
    let preferredSourceListingId: Id<"sourceListings"> | undefined;
    for (const { plan, contact } of plans) {
      const source = await applySource(ctx, candidate, command, plan);
      preferredSourceListingId ??= source.sourceListingId;
      if (contact) await insertManualContact(ctx, command, candidate._id, source.sourceListingId, contact);
    }
    const revision = await refreshCandidate(ctx, candidate, { preferredSourceListingId }, true, true);
    await writeEvent(ctx, command, { candidateId: candidate._id, entity: { table: "candidates", publicId: candidate.publicId }, kind: "created", afterRevision: revision, changedFields: diffs({}, { title, location, preferredSourceListingId }) });
    await touchCollection(ctx, collection);
    return { collectionId: collection._id, candidateId: candidate._id, revision };
  },
});

export const editCandidate = signedInMutation({
  args: { ...candidateCommand, patch: v.object({
    ...buyerStatePatch, title: optionalText, location: v.optional(locationInput),
    preferredSourceListingId: v.optional(v.id("sourceListings")), recordState: v.optional(activeState),
    customValues: v.optional(v.array(customValueEdit)), buyerFacts: v.optional(buyerFactsInput),
  }) }, returns: revisionResult,
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId, ["active"]);
    const candidate = await requireCandidate(ctx, args.collectionId, args.candidateId);
    const commandHash = await hash({ type: "editCandidate", args });
    const [prior] = await existingCommand(ctx, collection, args.operationId, commandHash);
    if (prior) return { revision: prior.afterRevision! };
    checkRevision(args.expectedRevision, candidate.revision);
    const { patch, changes } = await planCandidatePatch(ctx, candidate, args.patch);
    if (!changes.length) return { revision: candidate.revision };
    const revision = await refreshCandidate(ctx, candidate, patch, true);
    await recordCandidateChange(ctx, operation(collection, args.operationId, commandHash), candidate, revision, changes);
    await touchCollection(ctx, collection);
    return { revision };
  },
});

export const linkSource = signedInMutation({
  args: { ...candidateCommand, source: manualSource }, returns: v.object({ sourceListingId: v.id("sourceListings"), revision: v.number() }),
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId, ["active"]);
    const candidate = await requireCandidate(ctx, args.collectionId, args.candidateId);
    const commandHash = await hash({ type: "linkSource", args });
    const events = await existingCommand(ctx, collection, args.operationId, commandHash);
    const prior = events.find(event => event.entity.table === "sourceListings");
    if (prior) {
      const source = await ctx.db.query("sourceListings").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collection._id).eq("publicId", prior.entity.publicId)).unique();
      if (!source) invalid("source", "This source is unavailable.");
      return { sourceListingId: source._id, revision: events.find(event => event.entity.table === "candidates")!.afterRevision! };
    }
    checkRevision(args.expectedRevision, candidate.revision);
    if ((await candidateSources(ctx, candidate)).length >= limits.sources) invalid("sources", "This saved home already has ten source listings.");
    const { plan, contact } = await prepareManualSource(ctx, collection._id, args.source, candidate);
    if (contact && (await candidateContacts(ctx, candidate)).length >= limits.contacts) invalid("contacts", "This saved home already has twenty active contacts.");
    const command = operation(collection, args.operationId, commandHash);
    const { sourceListingId } = await applySource(ctx, candidate, command, plan);
    if (contact) await insertManualContact(ctx, command, candidate._id, sourceListingId, contact);
    const revision = await refreshCandidate(ctx, candidate, {}, true);
    await recordCandidateChange(ctx, command, candidate, revision, [{ field: "sourceListingId", before: null, after: sourceListingId }]);
    await touchCollection(ctx, collection);
    return { sourceListingId, revision };
  },
});

export const editContact = signedInMutation({
  args: { ...home, operationId: uuid, contactId: v.optional(v.id("contacts")), expectedRevision: v.optional(v.number()), sourceListingId: v.optional(v.id("sourceListings")), contact: contactData, state: v.optional(activeState) },
  returns: v.object({ contactId: v.id("contacts"), revision: v.number() }),
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId, ["active"]);
    const candidate = await requireCandidate(ctx, args.collectionId, args.candidateId);
    const commandHash = await hash({ type: "editContact", args });
    const [prior] = await existingCommand(ctx, collection, args.operationId, commandHash);
    if (prior) {
      const saved = await ctx.db.query("contacts").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collection._id).eq("publicId", prior.entity.publicId)).unique();
      if (!saved) invalid("contactId", "This contact is unavailable.");
      return { contactId: saved._id, revision: prior.afterRevision! };
    }
    const previous = args.contactId ? await ctx.db.get(args.contactId) : null;
    if (args.contactId) {
      if (!previous || previous.collectionId !== collection._id || previous.candidateId !== candidate._id) invalid("contactId", "This contact is unavailable.");
      checkRevision(args.expectedRevision, previous.revision);
    }
    const sourceListingId = args.sourceListingId ?? previous?.sourceListingId;
    if (sourceListingId) {
      const source = await ctx.db.get(sourceListingId);
      if (!source || source.collectionId !== collection._id || source.candidateId !== candidate._id) invalid("sourceListingId", "Choose a source belonging to this saved home.");
    }
    const values = contactValues(args.contact);
    const state = args.state ?? previous?.state ?? "active";
    if (!Object.values(values).some(value => value !== undefined)) invalid("contact", "Enter at least one contact detail.");
    const convert = previous?.managedBy === "source";
    if (convert && state === "archived") invalid("contact", "Only buyer-managed contacts can be archived here.");
    if ((!previous || previous.state === "archived" || convert) && state === "active" && (await candidateContacts(ctx, candidate)).length >= limits.contacts) invalid("contacts", "This saved home already has twenty active contacts.");
    const next = { ...values, sourceListingId, state, managedBy: "buyer" as const };
    const changedFields = diffs(previous ?? {}, next);
    if (!changedFields.length && previous) return { contactId: previous._id, revision: previous.revision };
    const publicId = !convert && previous ? previous.publicId : newPublicId();
    const revision = (!convert ? previous?.revision ?? 0 : 0) + 1;
    const contactId = !convert && previous ? previous._id : await ctx.db.insert("contacts", { ...next, publicId, collectionId: collection._id, candidateId: candidate._id, revision, updatedAt: Date.now() });
    if (previous && !convert) await ctx.db.patch(previous._id, { ...next, revision, updatedAt: Date.now() });
    await writeEvent(ctx, operation(collection, args.operationId, commandHash), {
      candidateId: candidate._id, entity: { table: "contacts", publicId }, kind: "contact_changed", beforeRevision: !convert ? previous?.revision : undefined, afterRevision: revision, changedFields,
    });
    await refreshCandidate(ctx, candidate, {}, true);
    await touchCollection(ctx, collection);
    return { contactId, revision };
  },
});

export const saveNote = signedInMutation({
  args: {
    ...home, operationId: uuid, noteId: v.optional(v.id("notes")), expectedRevision: v.optional(v.number()), kind: noteKind, body: v.string(),
    occurredAt: optionalTime, references: v.optional(v.array(reference)), comparisonContext: v.optional(v.union(comparisonContext, v.null())), deleted: v.optional(v.boolean()),
    candidatePatch: v.optional(v.object({ ...buyerStatePatch, expectedRevision: v.number() })),
  }, returns: v.object({ noteId: v.id("notes"), revision: v.number(), candidateRevision: v.number() }),
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId, ["active"]);
    const candidate = await requireCandidate(ctx, args.collectionId, args.candidateId);
    const commandHash = await hash({ type: "saveNote", args });
    const events = await existingCommand(ctx, collection, args.operationId, commandHash);
    if (events.length) {
      const noteEvent = events.find(event => event.entity.table === "notes");
      const note = noteEvent ? await ctx.db.query("notes").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collection._id).eq("publicId", noteEvent.entity.publicId)).unique() : args.noteId ? await ctx.db.get(args.noteId) : null;
      if (!note) invalid("noteId", "This note is unavailable.");
      return {
        noteId: note._id,
        revision: noteEvent?.afterRevision ?? args.expectedRevision ?? note.revision,
        candidateRevision: noteEvent?.candidateRevision ?? events.find(event => event.entity.table === "candidates")?.afterRevision ?? candidate.revision,
      };
    }
    if (args.candidatePatch) checkRevision(args.candidatePatch.expectedRevision, candidate.revision);
    const state = args.candidatePatch ? await planCandidatePatch(ctx, candidate, args.candidatePatch) : { patch: {}, changes: [] };
    const note = await planNote(ctx, candidate, args);
    const command = operation(collection, args.operationId, commandHash);
    const saved = await applyNote(ctx, candidate._id, command, note, { candidateRevision: candidate.revision + 1 });
    if (!saved.changed && !state.changes.length) return { noteId: saved.noteId, revision: saved.revision, candidateRevision: candidate.revision };
    const candidateRevision = await refreshCandidate(ctx, candidate, state.patch, true);
    await recordCandidateChange(ctx, command, candidate, candidateRevision, state.changes);
    await touchCollection(ctx, collection);
    return { noteId: saved.noteId, revision: saved.revision, candidateRevision };
  },
});

export const listCustomFields = signedInQuery({
  args: { collectionId: v.id("collections") }, returns: v.array(customFieldDoc),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collectionId);
    return ctx.db.query("customFields").withIndex("by_collectionId_and_state_and_position", q => q.eq("collectionId", args.collectionId)).take(limits.customFields);
  },
});

export const saveCustomField = signedInMutation({
  args: { collectionId: v.id("collections"), operationId: uuid, fieldId: v.optional(v.id("customFields")), expectedRevision: v.optional(v.number()), label: v.string(), type: customType, options: v.optional(v.array(fieldOption)), state: v.optional(activeState) },
  returns: v.object({ fieldId: v.id("customFields"), publicId: uuid, revision: v.number() }),
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.collectionId, ["active"]);
    const commandHash = await hash({ type: "saveCustomField", args });
    const [prior] = await existingCommand(ctx, collection, args.operationId, commandHash);
    if (prior) {
      const saved = await ctx.db.query("customFields").withIndex("by_collectionId_and_publicId", q => q.eq("collectionId", collection._id).eq("publicId", prior.entity.publicId)).unique();
      if (!saved) invalid("fieldId", "This custom field is unavailable.");
      return { fieldId: saved._id, publicId: saved.publicId, revision: prior.afterRevision! };
    }
    const previous = args.fieldId ? await ctx.db.get(args.fieldId) : null;
    if (args.fieldId) {
      if (!previous || previous.collectionId !== collection._id) invalid("fieldId", "This custom field is unavailable.");
      checkRevision(args.expectedRevision, previous.revision);
      if (args.type !== previous.type) invalid("type", "Create a new column to use a different field type.");
    }
    const retained = await ctx.db.query("customFields").withIndex("by_collectionId_and_state_and_position", q => q.eq("collectionId", collection._id)).take(limits.customFields);
    if (!previous && retained.length >= limits.customFields) invalid("field", "This collection has reached its 30-column limit, including archived columns.");
    const label = requiredText(args.label, "label", 120);
    const options = (args.options ?? previous?.options ?? []).map(option => ({ ...option, id: requireUuid(option.id, "options.id"), label: requiredText(option.label, "options.label", 120) }));
    if (options.length > limits.options || new Set(options.map(option => option.id)).size !== options.length || (options.length && args.type !== "single_select")) invalid("options", "Use up to 50 uniquely identified options for a single-select column.");
    if (previous?.options.some(option => !options.some(current => current.id === option.id))) invalid("options", "Archive options to preserve existing selections.");
    const state = args.state ?? previous?.state ?? "active";
    const next = { label, options, state, type: args.type, position: previous?.position ?? Math.max(-1, ...retained.map(field => field.position)) + 1 };
    const changedFields = diffs(previous ?? {}, next);
    if (!changedFields.length && previous) return { fieldId: previous._id, publicId: previous.publicId, revision: previous.revision };
    const publicId = previous?.publicId ?? newPublicId();
    const revision = (previous?.revision ?? 0) + 1;
    const fieldId = previous?._id ?? await ctx.db.insert("customFields", { ...next, publicId, collectionId: collection._id, revision, updatedAt: Date.now() });
    if (previous) await ctx.db.patch(previous._id, { ...next, revision, updatedAt: Date.now() });
    await writeEvent(ctx, operation(collection, args.operationId, commandHash), {
      entity: { table: "customFields", publicId }, kind: "custom_field_changed", beforeRevision: previous?.revision, afterRevision: revision, changedFields,
    });
    await touchCollection(ctx, collection);
    return { fieldId, publicId, revision };
  },
});
