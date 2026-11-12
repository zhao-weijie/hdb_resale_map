import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { comparisonContext, noteKind, reference } from "./trackerTypes";
import { diffs, writeEvent, type Operation } from "./trackerModel";
import { canonical, checkRevision, invalid, newPublicId, timestamp, validateComparison, validateReferences } from "./trackerValidation";

type NoteInput = {
  noteId?: Id<"notes">; expectedRevision?: number; kind: Infer<typeof noteKind>; body: string; occurredAt?: number | null;
  references?: Infer<typeof reference>[]; comparisonContext?: Infer<typeof comparisonContext> | null; deleted?: boolean;
};

export async function planNote(ctx: Pick<QueryCtx, "db">, candidate: Pick<Doc<"candidates">, "_id" | "collectionId" | "revision"> | null, input: NoteInput) {
  const previous = input.noteId ? await ctx.db.get(input.noteId) : null;
  if (input.noteId) {
    if (!candidate || !previous || previous.collectionId !== candidate.collectionId || previous.candidateId !== candidate._id || previous.state === "deleted") {
      invalid("noteId", "This note is unavailable.");
    }
    checkRevision(input.expectedRevision, previous.revision, "noteRevision");
  }
  if (input.deleted && !previous) invalid("noteId", "Choose an existing note to delete.");
  if (input.body.length > 10000 || /\u0000/.test(input.body)) invalid("body", "Use up to 10,000 characters without NUL characters.");
  const body = input.deleted ? previous!.body : input.body;
  if (!body.trim() && !input.comparisonContext && !previous?.comparisonContext) invalid("body", "Enter a note or attach a comparison.");
  const references = input.references ?? previous?.references ?? [];
  if (input.references) await validateReferences(ctx, input.references, candidate?.collectionId, candidate?._id);
  if (input.comparisonContext) {
    if (!candidate) invalid("comparisonContext", "Save the home before attaching a comparison.");
    if (new TextEncoder().encode(canonical(input.comparisonContext)).length > 100_000) invalid("comparisonContext", "This comparison snapshot is too large.");
    await validateComparison(ctx, input.comparisonContext, candidate as Doc<"candidates">);
  }
  const next = {
    body, kind: input.deleted ? previous!.kind : input.kind,
    occurredAt: input.occurredAt === undefined ? previous?.occurredAt : timestamp(input.occurredAt, "occurredAt"),
    references, comparisonContext: input.comparisonContext === undefined ? previous?.comparisonContext : input.comparisonContext ?? undefined,
    state: input.deleted ? "deleted" as const : "active" as const,
  };
  return { previous, next, changes: diffs(previous ?? {}, next) };
}

export async function applyNote(
  ctx: MutationCtx, candidateId: Id<"candidates">, operation: Operation, plan: Awaited<ReturnType<typeof planNote>>,
  receipt: { importItemId?: Id<"importItems">; candidateRevision?: number } = {},
) {
  const { previous, next, changes } = plan;
  if (previous && !changes.length) return { noteId: previous._id, revision: previous.revision, changed: false };
  const now = Date.now();
  const publicId = previous?.publicId ?? newPublicId();
  const revision = (previous?.revision ?? 0) + 1;
  const noteId = previous?._id ?? await ctx.db.insert("notes", {
    ...next, publicId, collectionId: operation.collectionId, candidateId, authorUserId: operation.ownerId, createdAt: now, revision, updatedAt: now,
  });
  if (previous) await ctx.db.patch(noteId, { ...next, revision, updatedAt: now });
  await writeEvent(ctx, operation, {
    candidateId, entity: { table: "notes", publicId },
    kind: next.state === "deleted" ? "deleted" : changes.some(change => change.field === "comparisonContext") ? "comparison_attached" : "note_changed",
    beforeRevision: previous?.revision, afterRevision: revision, changedFields: changes, ...receipt,
  });
  return { noteId, revision, changed: true };
}
