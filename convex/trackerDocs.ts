import { v, type GenericValidator } from "convex/values";
import schema from "./schema";

export const collectionDoc = v.object({ ...schema.tables.collections.validator.fields, _id: v.id("collections"), _creationTime: v.number() });
export const candidateDoc = v.object({ ...schema.tables.candidates.validator.fields, _id: v.id("candidates"), _creationTime: v.number() });
export const sourceDoc = v.object({ ...schema.tables.sourceListings.validator.fields, _id: v.id("sourceListings"), _creationTime: v.number() });
export const contactDoc = v.object({ ...schema.tables.contacts.validator.fields, _id: v.id("contacts"), _creationTime: v.number() });
export const noteDoc = v.object({ ...schema.tables.notes.validator.fields, _id: v.id("notes"), _creationTime: v.number() });
export const observationDoc = v.object({ ...schema.tables.sourceObservations.validator.fields, _id: v.id("sourceObservations"), _creationTime: v.number() });
export const customFieldDoc = v.object({ ...schema.tables.customFields.validator.fields, _id: v.id("customFields"), _creationTime: v.number() });
export const changeEventDoc = v.object({ ...schema.tables.changeEvents.validator.fields, _id: v.id("changeEvents"), _creationTime: v.number() });
export const importRunDoc = v.object({ ...schema.tables.importRuns.validator.fields, _id: v.id("importRuns"), _creationTime: v.number() });
export const importItemDoc = v.object({ ...schema.tables.importItems.validator.fields, _id: v.id("importItems"), _creationTime: v.number() });

export function pageFields<T extends GenericValidator>(item: T) {
  return {
    page: v.array(item), continueCursor: v.string(), isDone: v.boolean(),
    splitCursor: v.optional(v.union(v.null(), v.string())),
    pageStatus: v.optional(v.union(v.null(), v.literal("SplitRecommended"), v.literal("SplitRequired"))),
  };
}
