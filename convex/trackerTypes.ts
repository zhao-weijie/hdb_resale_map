import { v, type Infer } from "convex/values";

export const uuid = v.string();
export const collectionState = v.union(v.literal("active"), v.literal("archived"), v.literal("restoring"), v.literal("deleting"));
export const recordState = v.union(v.literal("active"), v.literal("archived"), v.literal("deleting"));
export const activeState = v.union(v.literal("active"), v.literal("archived"));
export const progress = v.union(
  v.literal("new"), v.literal("contacted"), v.literal("viewing_booked"), v.literal("viewed"),
  v.literal("negotiating"), v.literal("offer_submitted"), v.literal("passed"), v.literal("lost"),
);
export const availability = v.union(v.literal("active_as_observed"), v.literal("no_longer_observed"), v.literal("confirmed_unavailable"), v.literal("unknown"));
export const timeBasis = v.union(v.literal("source_observed"), v.literal("buyer_reported"), v.literal("recorded_at_import"));
export const buyerBasis = v.union(v.literal("buyer_entered"), v.literal("adopted_source_claim"), v.literal("buyer_confirmed"));
export const noteKind = v.union(v.literal("general"), v.literal("viewing"), v.literal("contact"), v.literal("rationale"));

export const flatType = v.union(v.literal("1 ROOM"), v.literal("2 ROOM"), v.literal("3 ROOM"), v.literal("4 ROOM"), v.literal("5 ROOM"), v.literal("EXECUTIVE"), v.literal("MULTI-GENERATION"));
export const area = v.object({ sqm: v.number(), originalValue: v.number(), originalUnit: v.union(v.literal("sqm"), v.literal("sqft")) });
export const floor = v.union(
  v.object({ kind: v.literal("exact"), value: v.number(), originalText: v.optional(v.string()) }),
  v.object({ kind: v.literal("range"), min: v.number(), max: v.number(), originalText: v.optional(v.string()) }),
);
export const propertyFields = { flatType, area, floor, flatModel: v.string(), completionYear: v.number(), leaseCommencementYear: v.number() };
export const comparisonFacts = v.object({
  flatType: v.optional(flatType), area: v.optional(area), floor: v.optional(floor), flatModel: v.optional(v.string()),
  completionYear: v.optional(v.number()), leaseCommencementYear: v.optional(v.number()),
});
export const sourceFields = {
  ...propertyFields, flatTypeRaw: v.string(), rawAddress: v.string(), postalCode: v.string(), unitNumber: v.string(),
  block: v.string(), street: v.string(), askingPriceCents: v.number(), availability,
};
export const location = v.object({
  status: v.union(v.literal("unresolved"), v.literal("ambiguous"), v.literal("matched"), v.literal("confirmed")),
  rawAddress: v.optional(v.string()), postalCode: v.optional(v.string()), unitNumber: v.optional(v.string()),
  matchMethod: v.optional(v.union(v.literal("geocode_dictionary"), v.literal("address_search"), v.literal("buyer_selected"))),
  geocodeVersion: v.optional(v.string()), confirmedAt: v.optional(v.number()),
  sourceListingId: v.optional(v.id("sourceListings")), observationId: v.optional(v.id("sourceObservations")),
});
export const locationInput = v.object({
  status: location.fields.status, rawAddress: v.optional(v.union(v.string(), v.null())),
  postalCode: v.optional(v.union(v.string(), v.null())), unitNumber: v.optional(v.union(v.string(), v.null())),
  matchMethod: location.fields.matchMethod, geocodeVersion: location.fields.geocodeVersion,
});

type RequiredValidator = import("convex/values").GenericValidator;
function mapFields<Fields extends Record<string, RequiredValidator>, Result>(fields: Fields, make: (validator: Fields[keyof Fields]) => Result) {
  return Object.fromEntries(Object.entries(fields).map(([field, validator]) => [field, make(validator as Fields[keyof Fields])])) as {
    [Key in keyof Fields]: Result;
  };
}

// Use per-field validators to keep each projected value paired with its original claim.
const sourceEvidence = {
  observationId: v.id("sourceObservations"), observedAt: v.optional(v.number()), timeBasis,
  lastConfirmedAt: v.optional(v.number()), priorDatedAt: v.optional(v.number()),
};
function observed<T extends RequiredValidator>(value: T) { return v.optional(v.object({ value, ...sourceEvidence })); }
function reported<T extends RequiredValidator>(value: T) { return v.optional(v.union(value, v.null())); }
function overridden<T extends RequiredValidator>(value: T) {
  return v.optional(v.object({
    value: v.union(value, v.null()), updatedAt: v.number(), basis: buyerBasis, reason: v.optional(v.string()),
    noteId: v.optional(v.id("notes")), adopted: v.optional(v.object({
      sourceListingId: v.id("sourceListings"), observationId: v.id("sourceObservations"), adoptedAt: v.number(),
    })),
  }));
}
function resolved<T extends RequiredValidator>(value: T) {
  return v.optional(v.object({
    value: v.union(value, v.null()), sourceListingId: v.optional(v.id("sourceListings")), observationId: v.optional(v.id("sourceObservations")),
    observedAt: v.optional(v.number()), timeBasis: v.optional(timeBasis), lastConfirmedAt: v.optional(v.number()), priorDatedAt: v.optional(v.number()), basis: v.optional(buyerBasis),
  }));
}
export const sourceFacts = v.object({
  flatType: reported(flatType), flatTypeRaw: reported(v.string()), area: reported(area), floor: reported(floor),
  flatModel: reported(v.string()), completionYear: reported(v.number()), leaseCommencementYear: reported(v.number()),
  rawAddress: reported(v.string()), postalCode: reported(v.string()), unitNumber: reported(v.string()),
  block: reported(v.string()), street: reported(v.string()), askingPriceCents: reported(v.number()), availability: reported(availability),
});
export const sourceCurrent = v.object({
  flatType: observed(flatType), flatTypeRaw: observed(v.string()), area: observed(area), floor: observed(floor),
  flatModel: observed(v.string()), completionYear: observed(v.number()), leaseCommencementYear: observed(v.number()),
  rawAddress: observed(v.string()), postalCode: observed(v.string()), unitNumber: observed(v.string()),
  block: observed(v.string()), street: observed(v.string()), askingPriceCents: observed(v.number()),
  description: observed(v.literal(true)), references: observed(v.literal(true)),
});
export const sourceAvailability = v.union(
  v.object({ reported: v.literal(false), value: v.literal("unknown") }),
  v.object({ reported: v.literal(true), value: availability, ...sourceEvidence }),
);
export const buyerFacts = v.object({
  flatType: overridden(flatType), area: overridden(area), floor: overridden(floor), flatModel: overridden(v.string()),
  completionYear: overridden(v.number()), leaseCommencementYear: overridden(v.number()),
});
const buyerFactSource = v.object({ sourceListingId: v.id("sourceListings"), observationId: v.id("sourceObservations") });
function buyerFactInput<T extends RequiredValidator>(value: T) {
  return v.optional(v.union(v.null(), v.object({ value: v.union(value, v.null()), source: v.optional(buyerFactSource), reason: v.optional(v.string()) })));
}
export const buyerFactsInput = v.object({
  flatType: buyerFactInput(flatType), area: buyerFactInput(area), floor: buyerFactInput(floor), flatModel: buyerFactInput(v.string()),
  completionYear: buyerFactInput(v.number()), leaseCommencementYear: buyerFactInput(v.number()),
});
export const candidateSummary = v.object({
  facts: v.object({
    flatType: resolved(flatType), area: resolved(area), floor: resolved(floor), flatModel: resolved(v.string()),
    completionYear: resolved(v.number()), leaseCommencementYear: resolved(v.number()),
  }),
  askingSourceListingId: v.optional(v.id("sourceListings")), askingSourceName: v.optional(v.string()),
  askingObservationId: v.optional(v.id("sourceObservations")), askingObservedAt: v.optional(v.number()),
  askingTimeBasis: v.optional(timeBasis), askingPriceCents: v.optional(v.number()), askingLastConfirmedAt: v.optional(v.number()),
  sourceCount: v.number(), availability: sourceAvailability, availabilityConflict: v.boolean(), lastSourceObservedAt: v.optional(v.number()),
});

const fieldId = uuid;
export const customType = v.union(v.literal("text"), v.literal("number"), v.literal("date"), v.literal("checkbox"), v.literal("single_select"));
export const fieldOption = v.object({ id: uuid, label: v.string(), archived: v.boolean() });
export const customValue = v.union(
  v.object({ fieldId, type: v.literal("text"), value: v.string() }),
  v.object({ fieldId, type: v.literal("number"), value: v.number() }),
  v.object({ fieldId, type: v.literal("date"), value: v.string() }),
  v.object({ fieldId, type: v.literal("checkbox"), value: v.boolean() }),
  v.object({ fieldId, type: v.literal("single_select"), optionId: uuid }),
);
export const customValueEdit = v.union(customValue, v.object({ fieldId, type: v.literal("unset") }));
export const trackerView = v.object({
  columnOrder: v.array(v.string()), hiddenColumns: v.array(v.string()),
  sort: v.object({ key: v.string(), direction: v.union(v.literal("asc"), v.literal("desc")) }),
  filters: v.optional(v.object({ query: v.optional(v.string()), shortlisted: v.optional(v.boolean()), progress: v.optional(progress), unresolved: v.optional(v.boolean()) })),
});

export const contactFields = {
  name: v.string(), agency: v.string(), phoneRaw: v.string(), phoneE164: v.string(), whatsappE164: v.string(),
  registration: v.object({ authority: v.optional(v.string()), registrationNumber: v.optional(v.string()) }),
};
export const contactData = v.object({
  name: v.optional(contactFields.name), agency: v.optional(contactFields.agency), phoneRaw: v.optional(contactFields.phoneRaw),
  phoneE164: v.optional(contactFields.phoneE164), whatsappE164: v.optional(contactFields.whatsappE164), registration: v.optional(contactFields.registration),
});
export const contactClaims = v.object({ key: v.optional(v.string()), ...contactData.fields });
export const contactProvenance = v.object(mapFields(contactFields, () => v.optional(v.object(sourceEvidence))));
export const reference = v.object({
  id: uuid, url: v.string(), label: v.optional(v.string()), mediaType: v.optional(v.string()),
  sourceListingId: v.optional(v.id("sourceListings")), observedAt: v.optional(v.number()),
});
export const importSource = v.object({
  url: v.optional(v.string()), portal: v.optional(v.string()), externalListingId: v.optional(v.string()), trackerRowKey: v.optional(v.string()),
  observedAt: v.optional(v.number()), facts: v.optional(sourceFacts), description: v.optional(v.string()),
  contacts: v.optional(v.array(contactClaims)), references: v.optional(v.array(reference)),
  acceptUndatedAsCurrent: v.optional(v.boolean()),
});
export const manualSource = v.object({
  url: v.string(), portal: importSource.fields.portal, externalListingId: importSource.fields.externalListingId,
  facts: importSource.fields.facts, description: importSource.fields.description, contact: v.optional(contactData),
});

const blockCenter = v.object({ postalCode: v.string(), lng: v.number(), lat: v.number(), geocodeVersion: v.string() });
export const comparisonContext = v.object({
  kind: v.literal("completed_sales"), version: v.literal(1),
  geometry: v.union(
    v.object({ kind: v.literal("circle"), lng: v.number(), lat: v.number(), radiusMeters: v.number() }),
    v.object({ kind: v.literal("rectangle"), minLng: v.number(), minLat: v.number(), maxLng: v.number(), maxLat: v.number() }),
    v.object({ kind: v.literal("block"), ...blockCenter.fields }),
  ),
  blockCenter: v.optional(blockCenter),
  rules: v.object({
    startMonth: v.string(), endMonth: v.string(), flatTypes: v.array(v.string()), exclusions: v.array(v.string()),
    floorMin: v.optional(v.number()), floorMax: v.optional(v.number()), leaseMonthsMin: v.optional(v.number()), leaseMonthsMax: v.optional(v.number()),
    areaSqmMin: v.optional(v.number()), areaSqmMax: v.optional(v.number()),
  }),
  sampleCount: v.number(), stats: v.object({
    minPrice: v.optional(v.number()), medianPrice: v.optional(v.number()), maxPrice: v.optional(v.number()),
    meanPrice: v.optional(v.number()), medianPsf: v.optional(v.number()),
  }),
  preparedAt: v.number(), candidateRevision: v.number(), candidateFacts: v.optional(comparisonFacts),
  asking: v.optional(v.object({
    priceCents: v.optional(v.number()), sourceListingId: v.optional(v.id("sourceListings")),
    observationId: v.optional(v.id("sourceObservations")), observedAt: v.optional(v.number()),
  })),
  dataset: v.object({ fingerprint: v.string(), manifestVersion: v.number(), transformVersion: v.string(), partitions: v.array(v.object({ url: v.string(), sha256: v.string() })) }),
  comparables: v.array(v.object({
    partitionHash: v.string(), rowFingerprint: v.string(), occurrence: v.number(), month: v.string(), block: v.string(),
    streetName: v.string(), flatType: v.string(), storeyRange: v.string(), floorAreaSqm: v.number(), resalePrice: v.number(),
  })),
  truncatedDetails: v.boolean(),
});

export const eventKind = v.union(
  v.literal("created"), v.literal("source_observed"), v.literal("source_linked"), v.literal("source_unlinked"), v.literal("buyer_edited"),
  v.literal("contact_changed"), v.literal("progress_changed"), v.literal("viewing_changed"),
  v.literal("note_changed"), v.literal("comparison_attached"), v.literal("location_confirmed"), v.literal("custom_field_changed"),
  v.literal("archived"), v.literal("restored"), v.literal("deleted"),
);
export const changedField = v.object({ field: v.string(), before: v.any(), after: v.any() });
export const importFormat = v.union(v.literal("csv"), v.literal("json_tracker"), v.literal("json_backup"));
export const importMode = v.union(v.literal("merge_sources"), v.literal("explicit_tracker_update"), v.literal("restore_new_collection"));
export const importOutcome = v.union(v.literal("accepted"), v.literal("unchanged"), v.literal("rejected"), v.literal("conflict"), v.literal("skipped"));
export const problem = v.object({ field: v.string(), code: v.string(), message: v.string() });
export const importRow = v.object({
  rowKey: uuid, logicalRowKey: uuid, rowNumber: v.number(), source: v.optional(importSource), title: v.optional(v.string()), location: v.optional(locationInput),
  linkCandidateId: v.optional(v.id("candidates")), expectedSourceRevision: v.optional(v.number()), expectedCandidateRevision: v.optional(v.number()),
  buyerPatch: v.optional(v.object({ progress: v.optional(progress), shortlisted: v.optional(v.boolean()), customValues: v.optional(v.array(customValueEdit)) })),
  note: v.optional(v.object({ body: v.string(), noteId: v.optional(v.id("notes")), expectedRevision: v.optional(v.number()) })),
  skip: v.optional(v.boolean()), supersedesItemId: v.optional(v.id("importItems")),
});
export const previewRow = v.object({
  rowNumber: v.number(), status: v.union(v.literal("new"), v.literal("update"), v.literal("unchanged"), v.literal("needs_attention")),
  candidateId: v.optional(v.id("candidates")), sourceListingId: v.optional(v.id("sourceListings")),
  expectedCandidateRevision: v.optional(v.number()), expectedSourceRevision: v.optional(v.number()),
  changes: v.array(changedField), problems: v.array(problem),
  similarCandidates: v.optional(v.array(v.object({ candidateId: v.id("candidates"), publicId: uuid, title: v.optional(v.string()), location, summary: candidateSummary }))),
});

export type LocationInput = Infer<typeof locationInput>;
export type ImportRow = Infer<typeof importRow>;
export type ImportSource = Infer<typeof importSource>;
export type SourceFacts = Infer<typeof sourceFacts>;
export type ManualSource = Infer<typeof manualSource>;
export type ChangedField = Infer<typeof changedField>;
export type ContactData = Infer<typeof contactData>;
export type ContactClaim = Infer<typeof contactClaims>;
