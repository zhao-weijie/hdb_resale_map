import type { PaginationOptions } from "convex/server";
import { ConvexError, convexToJson, type Infer, type Value } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { comparisonContext, reference, type ContactData, type LocationInput, type SourceFacts } from "./trackerTypes";

export class TrackerError extends ConvexError<{ field: string; code: string; message: string }> {
  constructor(field: string, code: string, message: string, readonly conflict = false) { super({ field, code, message }); }
}

export function invalid(field: string, message: string): never {
  throw new TrackerError(field, "invalid_value", message);
}

export function conflict(field: string, code: string, message: string): never {
  throw new TrackerError(field, code, message, true);
}

export function checkRevision(expected: number | undefined, current: number, field = "revision") {
  if (expected !== current) conflict(field, "stale_revision", "This record changed since it was opened. Review the current value and try again.");
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/i;
export function newPublicId() {
  // Convex seeds Math.random independently for each mutation and preserves the seed during retries.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
    const nibble = Math.floor(Math.random() * 16);
    return (char === "x" ? nibble : (nibble & 3) | 8).toString(16);
  });
}

export function requireUuid(value: string, field: string) {
  if (!UUID.test(value)) invalid(field, "Use a valid record identifier.");
  return value;
}

export function text(value: string | undefined | null, field: string, max: number) {
  if (value == null || !value.trim()) return undefined;
  if (value.length > max || /\u0000/.test(value)) invalid(field, `Use up to ${max.toLocaleString("en-US")} characters without NUL characters.`);
  return value.trim();
}

export function requiredText(value: string, field: string, max: number) {
  return text(value, field, max) ?? invalid(field, "Enter a value.");
}

export function integer(value: number, field: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field, `Enter a whole number from ${min} to ${max}.`);
  return value;
}

export function finite(value: number, field: string, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) invalid(field, "Enter a finite number in the accepted range.");
  return value;
}

export function timestamp(value: number | undefined | null, field: string) {
  return value == null ? undefined : integer(value, field, 0, 8_640_000_000_000_000);
}

export function calendarDate(value: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) invalid("customValues", "Use YYYY-MM-DD for the date.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid("customValues", "Enter a valid calendar date.");
  return value;
}

export function timezone(value: string) {
  if (value.length > 80) invalid("viewingTimezone", "Enter a valid IANA time zone.");
  try { new Intl.DateTimeFormat("en-SG", { timeZone: value }); }
  catch { invalid("viewingTimezone", "Enter a valid IANA time zone."); }
  return value;
}

const trackedParameters = /^(utm_(source|medium|campaign|id|term|content|source_platform|creative_format|marketing_tactic)|fbclid|gclid|dclid|msclkid|igshid)$/i;
const secretParameters = /^(access_token|auth_token|token|signature|sig|key-pair-id|x-amz-.*|x-goog-.*|awsaccesskeyid)$/i;
export function parseLink(raw: string, field = "url", externalReference = false) {
  const value = requiredText(raw, field, 2048);
  let url: URL;
  try { url = new URL(value); }
  catch { return invalid(field, "Enter a complete HTTP or HTTPS URL."); }
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value) || !url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    invalid(field, "Enter a complete HTTP or HTTPS URL without credentials.");
  }
  if (externalReference && Array.from(url.searchParams.keys()).some(key => secretParameters.test(key))) {
    invalid(field, "Use a reference URL without an access token or signature.");
  }
  return { value, url };
}

export function canonicalizeUrl(raw: string) {
  const { value, url } = parseLink(raw);
  for (const key of Array.from(url.searchParams.keys())) if (trackedParameters.test(key)) url.searchParams.delete(key);
  // Query order, repeated keys and fragments may carry an identifier on an unfamiliar portal.
  const portal = ["propertyguru.com.sg", "99.co", "srx.com.sg", "edgeprop.sg", "carousell.sg", "carousell.com", "homes.hdb.gov.sg"].find(domain =>
    url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
  const portalKeys: Record<string, string> = { "propertyguru.com.sg": "propertyguru", "99.co": "99co", "srx.com.sg": "srx", "edgeprop.sg": "edgeprop", "carousell.sg": "carousell", "carousell.com": "carousell", "homes.hdb.gov.sg": "hdb" };
  return { url: value, canonicalUrl: url.toString(), recognizedPortal: portal && portalKeys[portal] };
}

export function normalizedFacts(facts: SourceFacts = {}): SourceFacts {
  const result = { ...facts };
  for (const field of ["flatModel", "flatTypeRaw", "rawAddress", "postalCode", "unitNumber", "block", "street"] as const) {
    if (result[field] != null) result[field] = text(result[field], field, field === "rawAddress" ? 500 : 120) ?? null;
  }
  if (result.postalCode && !/^\d{6}$/.test(result.postalCode)) invalid("postalCode", "Use a six-digit postal code, including leading zeroes.");
  if (result.askingPriceCents != null) integer(result.askingPriceCents, "askingPriceCents", 1);
  for (const field of ["completionYear", "leaseCommencementYear"] as const) {
    if (result[field] != null) integer(result[field], field, 1800, 2200);
  }
  if (result.area) {
    const { sqm, originalValue, originalUnit } = result.area;
    finite(originalValue, "area", Number.MIN_VALUE);
    finite(sqm, "area", Number.MIN_VALUE);
    const normalized = originalUnit === "sqft" ? originalValue / 10.7639104167 : originalValue;
    if (Math.abs(normalized - sqm) > Math.max(0.05, normalized * 0.0001)) invalid("area", "The normalized area does not match its supplied value and unit.");
    result.area = { ...result.area, sqm: normalized };
  }
  if (result.floor) {
    const value = result.floor;
    const originalText = text(value.originalText, "floor", 120);
    if (value.kind === "exact") integer(value.value, "floor", 0, 250);
    else integer(value.max, "floor", integer(value.min, "floor", 0, 250), 250);
    result.floor = { ...value, originalText };
  }
  return result;
}

export function normalizedLocation(input: LocationInput, previous?: Doc<"candidates">["location"]): Doc<"candidates">["location"] {
  const { status } = input;
  const rawAddress = input.rawAddress === undefined ? previous?.rawAddress : text(input.rawAddress, "rawAddress", 500);
  const postalCode = input.postalCode === undefined ? previous?.postalCode : text(input.postalCode, "postalCode", 6);
  const unitNumber = input.unitNumber === undefined ? previous?.unitNumber : text(input.unitNumber, "unitNumber", 120);
  if (postalCode && !/^\d{6}$/.test(postalCode)) invalid("postalCode", "Use a six-digit postal code, including leading zeroes.");
  const mapped = status === "matched" || status === "confirmed";
  const unchangedPostalCode = previous?.postalCode === postalCode;
  const matchMethod = input.matchMethod ?? (unchangedPostalCode ? previous?.matchMethod : undefined);
  const geocodeVersion = text(input.geocodeVersion ?? (unchangedPostalCode ? previous?.geocodeVersion : undefined), "geocodeVersion", 160);
  if (mapped && (!postalCode || !matchMethod || !geocodeVersion)) invalid("location", "A saved block match needs its postal code, match method and lookup version.");
  const unchangedAddress = previous?.postalCode === postalCode && previous?.rawAddress === rawAddress && previous?.unitNumber === unitNumber;
  return {
    status, rawAddress, postalCode, unitNumber, matchMethod: mapped ? matchMethod : undefined,
    geocodeVersion: mapped ? geocodeVersion : undefined,
    confirmedAt: status === "confirmed" ? (unchangedAddress ? previous?.confirmedAt : undefined) ?? Date.now() : undefined,
    sourceListingId: unchangedAddress ? previous?.sourceListingId : undefined,
    observationId: unchangedAddress ? previous?.observationId : undefined,
  };
}

export function contactValues(input: ContactData): ContactData {
  const phoneRaw = text(input.phoneRaw, "phoneRaw", 80);
  const digits = phoneRaw?.replace(/[().\s-]/g, "");
  const fromRaw = digits && /^(?:[3689]\d{7})$/.test(digits) ? `+65${digits}` : digits;
  const normalized = (number: string | undefined) => number && /^\+[1-9]\d{7,14}$/.test(number) ? number : undefined;
  const phoneE164 = text(input.phoneE164, "phoneE164", 16) ?? normalized(fromRaw);
  const whatsappE164 = text(input.whatsappE164, "whatsappE164", 16);
  if (phoneE164 && !normalized(phoneE164)) invalid("phoneE164", "Use an international number beginning with +.");
  if (whatsappE164 && !normalized(whatsappE164)) invalid("whatsappE164", "Use an international number beginning with +.");
  const authority = text(input.registration?.authority, "registration.authority", 120);
  const registrationNumber = text(input.registration?.registrationNumber, "registration.registrationNumber", 120);
  return {
    name: text(input.name, "name", 120), agency: text(input.agency, "agency", 120), phoneRaw, phoneE164, whatsappE164,
    registration: authority || registrationNumber ? { authority, registrationNumber } : undefined,
  };
}

export async function validateReferences(ctx: Pick<QueryCtx, "db">, references: Infer<typeof reference>[], collectionId: Id<"collections"> | undefined, candidateId: Id<"candidates"> | undefined) {
  if (references.length > 20) invalid("references", "Use at most 20 references.");
  const ids = new Set<string>();
  for (const entry of references) {
    requireUuid(entry.id, "references.id");
    if (ids.has(entry.id)) invalid("references.id", "Each reference needs its own identifier.");
    ids.add(entry.id);
    parseLink(entry.url, "references.url", true);
    text(entry.label, "references.label", 120);
    text(entry.mediaType, "references.mediaType", 120);
    timestamp(entry.observedAt, "references.observedAt");
    if (entry.sourceListingId) {
      const source = await ctx.db.get(entry.sourceListingId);
      if (!source || !candidateId || source.collectionId !== collectionId || source.candidateId !== candidateId) invalid("references.sourceListingId", "Choose a source belonging to this saved home.");
    }
  }
}

export async function validateComparison(ctx: Pick<QueryCtx, "db">, value: Infer<typeof comparisonContext>, candidate: Doc<"candidates">) {
  const { geometry, blockCenter, rules, sampleCount, comparables, dataset } = value;
  const coordinates = (lng: number, lat: number) => { finite(lng, "longitude", -180, 180); finite(lat, "latitude", -90, 90); };
  if (geometry.kind === "rectangle") {
    coordinates(geometry.minLng, geometry.minLat);
    coordinates(geometry.maxLng, geometry.maxLat);
    if (geometry.minLng > geometry.maxLng || geometry.minLat > geometry.maxLat) invalid("geometry", "Use ordered rectangle bounds.");
  } else {
    coordinates(geometry.lng, geometry.lat);
    if (geometry.kind === "circle") finite(geometry.radiusMeters, "radiusMeters", 1);
  }
  for (const center of [blockCenter, geometry.kind === "block" ? geometry : undefined]) {
    if (!center) continue;
    coordinates(center.lng, center.lat);
    if (!/^\d{6}$/.test(center.postalCode)) invalid("postalCode", "Use a six-digit postal code.");
    requiredText(center.geocodeVersion, "geocodeVersion", 160);
  }
  const month = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!month.test(rules.startMonth) || !month.test(rules.endMonth) || rules.startMonth > rules.endMonth) invalid("rules", "Use a valid start and end month in order.");
  if (rules.flatTypes.length > 15 || rules.exclusions.length > 30) invalid("rules", "The comparison contains too many filter values.");
  rules.flatTypes.forEach(item => requiredText(item, "flatTypes", 120));
  rules.exclusions.forEach(item => requiredText(item, "exclusions", 300));
  for (const [min, max] of [[rules.floorMin, rules.floorMax], [rules.leaseMonthsMin, rules.leaseMonthsMax], [rules.areaSqmMin, rules.areaSqmMax]]) {
    if (min !== undefined) finite(min, "rules.minimum", 0);
    if (max !== undefined) finite(max, "rules.maximum", min ?? 0);
  }
  if (comparables.length > 100 || sampleCount < comparables.length || (sampleCount > 100 && !value.truncatedDetails)) invalid("comparables", "Save at most 100 comparable rows and mark larger samples as truncated.");
  integer(sampleCount, "sampleCount");
  timestamp(value.preparedAt, "preparedAt");
  integer(value.candidateRevision, "candidateRevision", 1, candidate.revision);
  normalizedFacts(value.candidateFacts);
  Object.entries(value.stats).forEach(([field, amount]) => finite(amount, field, 0));
  if (!SHA256.test(dataset.fingerprint) || dataset.partitions.length > 500) invalid("dataset", "Use a valid dataset fingerprint and partition list.");
  integer(dataset.manifestVersion, "manifestVersion", 1);
  requiredText(dataset.transformVersion, "transformVersion", 120);
  const hashes = new Set<string>();
  for (const partition of dataset.partitions) {
    const url = requiredText(partition.url, "partition.url", 2048);
    if (!/^\/?data\/[a-zA-Z0-9_./-]+$/.test(url) || url.includes("..")) parseLink(url, "partition.url", true);
    if (!SHA256.test(partition.sha256)) invalid("partition.sha256", "Use a valid partition hash.");
    hashes.add(partition.sha256);
  }
  for (const row of comparables) {
    if (!hashes.has(row.partitionHash) || !SHA256.test(row.rowFingerprint) || !month.test(row.month)) invalid("comparables", "Each comparable must identify a row and partition in this snapshot.");
    integer(row.occurrence, "occurrence");
    for (const field of ["block", "streetName", "flatType", "storeyRange"] as const) requiredText(row[field], field, 120);
    finite(row.floorAreaSqm, "floorAreaSqm", Number.MIN_VALUE);
    finite(row.resalePrice, "resalePrice", Number.MIN_VALUE);
  }
  if (value.asking) {
    const { sourceListingId, observationId, priceCents, observedAt } = value.asking;
    if (priceCents !== undefined) integer(priceCents, "asking.priceCents", 1);
    timestamp(observedAt, "asking.observedAt");
    if (sourceListingId) {
      const source = await ctx.db.get(sourceListingId);
      if (!source || source.collectionId !== candidate.collectionId || source.candidateId !== candidate._id) invalid("asking.sourceListingId", "Choose a source belonging to this saved home.");
    }
    if (observationId) {
      const observation = await ctx.db.get(observationId);
      if (!observation || observation.collectionId !== candidate.collectionId || observation.sourceListingId !== sourceListingId || observation.facts.askingPriceCents !== priceCents || observation.observedAt !== observedAt) {
        invalid("asking.observationId", "The asking price and date must match the attached observation.");
      }
    }
  }
}

export function boundedPagination(options: PaginationOptions, max: number): PaginationOptions {
  return { numItems: integer(options.numItems, "numItems", 1, max), cursor: options.cursor };
}

export function canonical(value: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object" && !(value instanceof ArrayBuffer)) {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sort(item)]));
    }
    return value;
  };
  return value === undefined ? "undefined" : JSON.stringify(sort(convexToJson(value as Value)));
}

export function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }

export async function hash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
