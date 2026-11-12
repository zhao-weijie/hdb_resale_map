import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { candidateContacts, diffs, limits, writeEvent, type Operation } from "./trackerModel";
import { sourceFields, timeBasis, type ChangedField, type ContactClaim, type ContactData, type ImportSource } from "./trackerTypes";
import { canonicalizeUrl, conflict, contactValues, hash, invalid, newPublicId, normalizedFacts, same, text, timestamp, validateReferences } from "./trackerValidation";

type ReadCtx = Pick<QueryCtx, "db">;
type Source = Doc<"sourceListings">;
type Observation = Doc<"sourceObservations">;
type IdentityKey = Pick<Doc<"sourceIdentities">, "kind" | "key">;
type TimeBasis = Infer<typeof timeBasis>;
type Evidence = { observationId: Id<"sourceObservations">; observedAt?: number; lastConfirmedAt?: number; priorDatedAt?: number; timeBasis: TimeBasis };
type Claim = Evidence & { value: unknown };
type FactField = keyof typeof sourceFields;
const factFields = Object.keys(sourceFields) as FactField[];
const contactKeys = ["name", "agency", "phoneRaw", "phoneE164", "whatsappE164", "registration"] as const;

function portalIdentity(portal: string, externalListingId: string) {
  return `portal:${portal}:${externalListingId}`;
}

function normalizePortal(input: string | undefined) {
  const name = text(input, "portal", 120);
  const key = name?.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return { key: key === "other" ? undefined : key, name };
}

export async function resolveSource(ctx: ReadCtx, collectionId: Id<"collections"> | undefined, input: ImportSource) {
  const link = input.url === undefined ? undefined : canonicalizeUrl(input.url);
  const externalListingId = text(input.externalListingId, "externalListingId", 160);
  const trackerRowKey = text(input.trackerRowKey, "trackerRowKey", 250);
  const requestedPortal = normalizePortal(input.portal);
  const keys: IdentityKey[] = [];
  if (link) keys.push({ kind: "url", key: `url:${link.canonicalUrl}` });
  if (trackerRowKey) keys.push({ kind: "tracker_row", key: `tracker:${trackerRowKey}` });
  const links: Doc<"sourceIdentities">[] = [];
  async function find(key: IdentityKey) {
    if (!collectionId) return;
    const match = await ctx.db.query("sourceIdentities").withIndex("by_collectionId_and_key", q => q.eq("collectionId", collectionId).eq("key", key.key)).unique();
    if (match) links.push(match);
  }
  await Promise.all(keys.map(find));
  const hint = links.length ? await ctx.db.get(links[0].sourceListingId) : null;
  const portal = link?.recognizedPortal ?? requestedPortal.key ?? hint?.portal ?? "other";
  const knownExternalId = externalListingId ?? hint?.externalListingId;
  if (knownExternalId && portal !== "other") {
    const key = { kind: "portal_id", key: portalIdentity(portal, knownExternalId) } as const;
    keys.unshift(key);
    await find(key);
  }
  if (new Set(links.map(match => match.sourceListingId)).size > 1) conflict("url", "identity_conflict", "The supplied URL and stable identity resolve to different advertisements.");
  const source = hint ?? (links.length ? await ctx.db.get(links[0].sourceListingId) : null);
  if (links.length && (!source || source.collectionId !== collectionId)) conflict("url", "identity_conflict", "The saved advertisement identity is unavailable.");
  if (!link && !source) invalid("url", "Enter a valid listing URL, or supply a stable identity for an existing advertisement.");
  if (!link && source) canonicalizeUrl(source.url);
  if (externalListingId && source?.externalListingId && source.externalListingId !== externalListingId) {
    conflict("externalListingId", "identity_conflict", "This advertisement already has a different portal identity. Review the source before importing.");
  }
  if (source && portal !== "other" && source.portal !== "other" && portal !== source.portal) {
    conflict("portal", "identity_conflict", "This advertisement already belongs to a different portal.");
  }
  const aliases = keys.filter(key => !links.some(found => found.key === key.key));
  if (source && aliases.length) {
    const existing = await ctx.db.query("sourceIdentities").withIndex("by_collectionId_and_sourceListingId", q => q.eq("collectionId", source.collectionId).eq("sourceListingId", source._id)).take(limits.aliases);
    if (existing.length + aliases.length > limits.aliases) invalid("url", "This advertisement has reached its identity alias limit.");
  }
  const changeUrl = !source || (link && aliases.some(alias => alias.kind === "url"));
  const resolvedPortal = source && source.portal !== "other" ? source.portal : portal;
  const primaryIdentityKey = keys.find(key => key.kind === "portal_id")?.key ?? source?.primaryIdentityKey ?? keys.find(key => key.kind === "url")!.key;
  return { source, aliases, identity: {
    url: changeUrl ? link!.url : source!.url, canonicalUrl: changeUrl ? link!.canonicalUrl : source!.canonicalUrl,
    portal: resolvedPortal, portalDisplayName: source?.portalDisplayName ?? (resolvedPortal === "other" && requestedPortal.name?.toLowerCase() !== "other" ? requestedPortal.name : undefined),
    externalListingId: externalListingId ?? source?.externalListingId, primaryIdentityKey,
  } };
}

type EvidenceChange = "current" | "fresh" | "historical" | "same";
function datedEvidence(evidence: Evidence | undefined) {
  return evidence?.lastConfirmedAt ?? evidence?.observedAt ?? evidence?.priorDatedAt;
}

function classify(previous: Evidence | undefined, sameValue: boolean, observedAt: number | undefined, basis: TimeBasis): EvidenceChange {
  if (!previous) return "current";
  const previousTime = datedEvidence(previous);
  if (observedAt !== undefined && previousTime !== undefined) {
    if (observedAt < previousTime) return "historical";
    if (observedAt === previousTime && previous.priorDatedAt !== undefined && previous.observedAt === undefined && previous.lastConfirmedAt === undefined) return "historical";
    if (observedAt === previousTime && !sameValue) conflict("observedAt", "equal_time_conflict", "This advertisement already has a conflicting claim at the same observation time.");
  }
  if (observedAt === undefined && !sameValue && previousTime !== undefined && basis !== "buyer_reported") {
    conflict("observedAt", "undated_conflict", "Supply an observation time or explicitly treat this undated update as the current buyer report.");
  }
  if (!sameValue) return "current";
  return observedAt !== undefined && (previousTime === undefined || observedAt > previousTime) ? "fresh" : "same";
}

interface ContactPlan { key: string; existing?: Doc<"contacts">; values: ContactData; actions: Partial<Record<keyof ContactData, EvidenceChange>> }

async function prepareContacts(ctx: ReadCtx, source: Source | null, candidate: Doc<"candidates"> | null, claims: ContactClaim[], observedAt: number | undefined, basis: TimeBasis) {
  if (claims.length > limits.contacts) invalid("contacts", "Use at most 20 agent contacts for a saved home.");
  const plans: ContactPlan[] = [];
  const keys = new Set<string>();
  const existingContacts = candidate ? await candidateContacts(ctx, candidate) : [];
  const related = existingContacts.filter(contact => contact.sourceListingId === source?._id && contact.managedBy === "source");
  const latestContactTime = Math.max(-Infinity, ...related.flatMap(contact =>
    Object.values(contact.provenance ?? {}).map(claim => datedEvidence(claim) ?? -Infinity),
  ));
  for (const input of claims) {
    const values = contactValues(input);
    if (!Object.values(values).some(value => value !== undefined)) continue;
    const explicitKey = text(input.key, "contacts.key", 250);
    const naturalKey = values.registration?.registrationNumber ? `registration:${values.registration.registrationNumber.toUpperCase()}` : values.phoneE164 ? `phone:${values.phoneE164}` : undefined;
    const bySameNumber = related.find(contact => values.phoneE164 && contact.phoneE164 === values.phoneE164);
    const bySameRegistration = related.find(contact => values.registration?.registrationNumber && contact.registration?.registrationNumber?.toUpperCase() === values.registration.registrationNumber.toUpperCase());
    if (bySameNumber && bySameRegistration && bySameNumber._id !== bySameRegistration._id) conflict("contacts", "contact_conflict", "The phone and registration number identify different contacts.");
    const key = explicitKey ? `mapped:${explicitKey}` : bySameNumber?.sourceContactKey ?? bySameRegistration?.sourceContactKey
      ?? (claims.length === 1 ? related.find(contact => contact.sourceContactKey === "primary")?.sourceContactKey : undefined)
      ?? (claims.length === 1 && related.length === 1 && !naturalKey ? related[0].sourceContactKey : undefined)
      ?? naturalKey ?? (claims.length === 1 ? "primary" : invalid("contacts.key", "Give each contact a stable key, phone number or registration number."));
    if (keys.has(key)) invalid("contacts", "The same contact appears twice in this report.");
    keys.add(key);
    const existing = source ? await ctx.db.query("contacts").withIndex("by_collectionId_and_sourceListingId_and_sourceContactKey", q =>
      q.eq("collectionId", source.collectionId).eq("sourceListingId", source._id).eq("sourceContactKey", key),
    ).unique() : null;
    // An older report can retain a different agent in evidence without advertising that agent as current.
    const historicalContact = !existing && observedAt !== undefined && observedAt < latestContactTime;
    const actions: ContactPlan["actions"] = {};
    for (const field of contactKeys) {
      if (values[field] !== undefined) {
        actions[field] = historicalContact ? "historical" : classify(existing?.provenance?.[field], same(existing?.[field], values[field]), observedAt, basis);
      }
    }
    plans.push({ key, existing: existing ?? undefined, values, actions });
  }
  if (existingContacts.length + plans.filter(plan => !plan.existing && Object.values(plan.actions).includes("current")).length > limits.contacts) invalid("contacts", "This saved home has reached its contact limit.");
  return plans;
}

export async function planSource(ctx: ReadCtx, collectionId: Id<"collections"> | undefined, identity: Awaited<ReturnType<typeof resolveSource>>, input: ImportSource, candidate: Doc<"candidates"> | null, manual = false) {
  const { source } = identity;
  const facts = normalizedFacts(input.facts);
  const observedAt = timestamp(input.observedAt, "observedAt");
  if (observedAt !== undefined && observedAt > Date.now() + 24 * 60 * 60 * 1000) invalid("observedAt", "Enter a source observation time that has already occurred.");
  const basis: TimeBasis = manual || input.acceptUndatedAsCurrent ? "buyer_reported" : observedAt === undefined ? "recorded_at_import" : "source_observed";
  const description = text(input.description, "description", 30000);
  const references = input.references ?? [];
  await validateReferences(ctx, references, collectionId, candidate?._id);
  const contacts = await prepareContacts(ctx, source, candidate, input.contacts ?? [], observedAt, basis);
  const contactClaims = contacts.map(plan => ({ ...plan.values, key: plan.key }));
  const contentHash = await hash({ facts, description, references, contactClaims });
  const actions: Partial<Record<FactField | "description" | "references", EvidenceChange>> = {};
  const changes = source ? diffs(source, identity.identity) : [];
  const identityChanged = identity.aliases.length > 0 || changes.length > 0;
  let latest: Observation | null = null;
  const rowsAtTime = source && observedAt !== undefined ? await ctx.db.query("sourceObservations").withIndex("by_collection_source_observed_hash", q =>
    q.eq("collectionId", source.collectionId).eq("sourceListingId", source._id).eq("observedAt", observedAt),
  ).take(65) : [];
  const duplicate = rowsAtTime.find(row => row.contentHash === contentHash);
  if (duplicate) return { ...identity, facts, observedAt, basis, description, references, contactClaims, contentHash, actions, contacts: [], changes, identityChanged, retain: false, affectsCurrentFacts: false, duplicate };
  if (rowsAtTime.length > 64) conflict("observedAt", "equal_time_limit", "Too many source reports share this timestamp. Review their dates before importing.");
  const checkSameTime = (field: string, value: unknown, getValue: (row: Observation) => unknown) => {
    if (value != null && rowsAtTime.some(row => { const previous = getValue(row); return previous != null && !same(previous, value); })) {
      conflict(field, "equal_time_conflict", "This advertisement already has a conflicting claim at the same observation time.");
    }
  };
  for (const field of factFields) {
    const next = facts[field];
    if (next === undefined) continue;
    const previous = field === "availability" ? (source?.availability.reported ? source.availability : undefined) : source?.current[field];
    if (next === null || (field === "availability" && next === "unknown" && previous?.value && previous.value !== "unknown")) {
      if (source?.latestObservationId) latest ??= await ctx.db.get(source.latestObservationId);
      if (latest?.facts[field] !== next) actions[field] = "historical";
      continue;
    }
    checkSameTime(field, next, row => row.facts[field]);
    actions[field] = classify(previous, same(previous?.value, next), observedAt, basis);
    if (actions[field] === "current") changes.push({ field, before: previous?.value ?? null, after: next });
  }
  for (const [field, value] of [["description", description], ["references", references.length ? references : undefined]] as const) {
    if (value === undefined) continue;
    checkSameTime(field, value, row => field === "references" && !row.references.length ? undefined : row[field]);
    const current = source?.current[field];
    const prior = current ? await ctx.db.get(current.observationId) : null;
    actions[field] = classify(current, same(prior?.[field], value), observedAt, basis);
    if (actions[field] === "current") changes.push({ field, before: current ? { observationId: current.observationId } : null, after: { reported: true } });
  }
  const contactActions = contacts.flatMap(plan => Object.entries(plan.actions));
  for (const plan of contacts) {
    for (const field of contactKeys) {
      if (plan.values[field] === undefined) continue;
      checkSameTime(`contact.${field}`, plan.values[field], row => row.contactClaims.find(contact => contact.key === plan.key)?.[field]);
      if (plan.actions[field] === "current") changes.push({ field: `contact.${field}`, before: plan.existing?.[field] ?? null, after: plan.values[field] });
    }
  }
  const all = [...Object.values(actions), ...contactActions.map(([, action]) => action)];
  const affectsCurrentFacts = all.includes("current");
  const retain = affectsCurrentFacts || all.includes("historical") || !source;
  return { ...identity, facts, observedAt, basis, description, references, contactClaims, contentHash, actions, contacts, changes, identityChanged, retain, affectsCurrentFacts, duplicate };
}

type SourcePlan = Awaited<ReturnType<typeof planSource>>;
function projectedClaim(previous: Evidence | undefined, action: EvidenceChange | undefined, evidence: Evidence | undefined, observedAt: number | undefined) {
  if (action === "current" && evidence) return { ...evidence, priorDatedAt: observedAt === undefined ? datedEvidence(previous) : undefined };
  if (action === "fresh") return { ...previous!, lastConfirmedAt: observedAt };
  return null;
}

export async function applySource(ctx: MutationCtx, candidate: Doc<"candidates">, operation: Operation, plan: SourcePlan, importItemId?: Id<"importItems">) {
  const now = Date.now();
  const sourcePublicId = plan.source?.publicId ?? newPublicId();
  const sourceListingId = plan.source?._id ?? await ctx.db.insert("sourceListings", {
    ...plan.identity, publicId: sourcePublicId, collectionId: candidate.collectionId, candidateId: candidate._id,
    current: {}, availability: { reported: false, value: "unknown" }, lastRecordedAt: now, createdAt: now, revision: 1, updatedAt: now,
  });
  for (const alias of plan.aliases) {
    await ctx.db.insert("sourceIdentities", { ...alias, publicId: newPublicId(), collectionId: candidate.collectionId, sourceListingId, recordedAt: now });
  }
  const observationId = plan.retain ? await ctx.db.insert("sourceObservations", {
    publicId: newPublicId(), collectionId: candidate.collectionId, sourceListingId,
    observedAt: plan.observedAt, timeBasis: plan.basis, recordedAt: now, payloadVersion: 1, facts: plan.facts,
    description: plan.description, contactClaims: plan.contactClaims, references: plan.references, contentHash: plan.contentHash,
    submittedByUserId: operation.ownerId, importItemId,
  }) : undefined;
  const evidence = observationId ? { observationId, observedAt: plan.observedAt, timeBasis: plan.basis } : undefined;
  const current = { ...plan.source?.current };
  let availability: Source["availability"] = plan.source?.availability ?? { reported: false, value: "unknown" };
  for (const [key, action] of Object.entries(plan.actions)) {
    const field = key as keyof Source["current"] | "availability";
    const value = field === "description" || field === "references" ? true : plan.facts[field];
    if (field === "availability") {
      const next = projectedClaim(availability.reported ? availability : undefined, action, evidence, plan.observedAt);
      if (next) availability = { ...next, reported: true, value: (action === "fresh" ? availability.value : value) as Infer<typeof import("./trackerTypes").availability> };
    } else {
      const previous: Claim | undefined = current[field];
      const next = projectedClaim(previous, action, evidence, plan.observedAt);
      if (next) Object.assign(current, { [field]: { ...next, value: action === "fresh" ? previous!.value : value } });
    }
  }
  for (const contact of plan.contacts) {
    const values = { ...contact.existing?.provenance };
    const patch: Partial<Doc<"contacts">> = {};
    for (const field of contactKeys) {
      const action = contact.actions[field];
      const next = projectedClaim(values[field], action, evidence, plan.observedAt);
      if (!next) continue;
      values[field] = next;
      if (action === "current") Object.assign(patch, { [field]: contact.values[field] });
    }
    if (contact.existing) {
      if (!same(values, contact.existing.provenance)) {
        await ctx.db.patch(contact.existing._id, { ...patch, provenance: values, revision: contact.existing.revision + 1, updatedAt: now });
      }
    } else if (Object.keys(patch).length) {
      await ctx.db.insert("contacts", {
        ...contact.values, publicId: newPublicId(), collectionId: candidate.collectionId, candidateId: candidate._id, sourceListingId,
        sourceContactKey: contact.key, managedBy: "source", state: "active", provenance: values, revision: 1, updatedAt: now,
      });
    }
  }
  const lastObservedAt = plan.observedAt === undefined ? plan.source?.lastObservedAt : Math.max(plan.observedAt, plan.source?.lastObservedAt ?? plan.observedAt);
  const priorLatest = observationId && plan.source?.latestObservationId ? await ctx.db.get(plan.source.latestObservationId) : null;
  const isLatestReport = !priorLatest || (plan.observedAt !== undefined
    ? plan.observedAt >= (priorLatest.observedAt ?? priorLatest.recordedAt)
    : plan.basis === "buyer_reported" && plan.affectsCurrentFacts);
  const latestObservationId = observationId && isLatestReport
    ? observationId : plan.source?.latestObservationId;
  const revision = (plan.source?.revision ?? 0) + 1;
  await ctx.db.patch(sourceListingId, { ...plan.identity, current, availability, lastObservedAt, lastRecordedAt: now, latestObservationId, revision, updatedAt: now });
  const meaningful = plan.retain || plan.identityChanged;
  if (meaningful) {
    const changes: ChangedField[] = plan.changes.map(change => change.field === "description" || change.field === "references"
      ? { ...change, after: { observationId } } : change);
    if (!plan.source) changes.unshift({ field: "url", before: null, after: plan.identity.url });
    if (plan.identityChanged && plan.source) changes.push({ field: "sourceAliases", before: null, after: plan.aliases.map(alias => alias.key) });
    await writeEvent(ctx, operation, {
      candidateId: candidate._id, entity: { table: "sourceListings", publicId: sourcePublicId }, kind: plan.source ? "source_observed" : "source_linked",
      beforeRevision: plan.source?.revision, afterRevision: revision, changedFields: changes,
      observationId, importItemId, affectsCurrentFacts: plan.affectsCurrentFacts,
    });
  }
  return { sourceListingId, observationId: observationId ?? plan.duplicate?._id, meaningful, revision };
}
