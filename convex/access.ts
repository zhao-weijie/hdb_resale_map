import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { mutation, query } from "./_generated/server";

type ReadCtx = Pick<QueryCtx, "auth" | "db">;

export async function requireIdentity(ctx: Pick<QueryCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "signed_out", message: "Sign in to access saved homes." });
  return identity;
}

export async function getTrackerUser(ctx: ReadCtx) {
  const { tokenIdentifier } = await stableIdentity(ctx);
  return ctx.db.query("trackerUsers").withIndex("by_tokenIdentifier", q => q.eq("tokenIdentifier", tokenIdentifier)).unique();
}

export async function ensureTrackerUser(ctx: MutationCtx) {
  const { identity, tokenIdentifier } = await stableIdentity(ctx);
  const existing = await ctx.db.query("trackerUsers").withIndex("by_tokenIdentifier", q => q.eq("tokenIdentifier", tokenIdentifier)).unique();
  if (existing) return existing;
  const displayName = identity.name?.trim().slice(0, 120) || undefined;
  const now = Date.now();
  const id = await ctx.db.insert("trackerUsers", { tokenIdentifier, displayName, createdAt: now, updatedAt: now });
  return (await ctx.db.get(id))!;
}

async function stableIdentity(ctx: ReadCtx) {
  const identity = await requireIdentity(ctx);
  // The verified JWT subject contains both the stable Auth user ID and the session ID.
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "signed_out", message: "Sign in to access saved homes." });
  return { identity, tokenIdentifier: `${identity.issuer}|${userId}` };
}

export async function requireCollection(
  ctx: ReadCtx, collectionId: Id<"collections">,
  allowedStates: readonly Doc<"collections">["state"][] = ["active", "archived"],
) {
  const user = await getTrackerUser(ctx);
  const collection = await ctx.db.get(collectionId);
  if (!user || !collection || collection.ownerId !== user._id || !allowedStates.includes(collection.state)) {
    throw new ConvexError({ code: "collection_unavailable", message: "This collection is unavailable." });
  }
  return collection;
}

export async function touchCollection(ctx: MutationCtx, collection: Doc<"collections">) {
  await ctx.db.patch(collection._id, { contentRevision: collection.contentRevision + 1, updatedAt: Date.now() });
}

export async function requireCandidate(ctx: ReadCtx, collectionId: Id<"collections">, candidateId: Id<"candidates">) {
  await requireCollection(ctx, collectionId);
  const candidate = await getVisibleCandidate(ctx, collectionId, candidateId);
  if (!candidate) throw new ConvexError({ code: "home_unavailable", message: "This saved home is unavailable." });
  return candidate;
}

export async function getVisibleCandidate(ctx: Pick<QueryCtx, "db">, collectionId: Id<"collections">, candidateId: Id<"candidates">) {
  const candidate = await ctx.db.get(candidateId);
  return candidate && candidate.collectionId === collectionId && candidate.recordState !== "deleting" ? candidate : null;
}

export const signedInQuery = customQuery(query, {
  args: {},
  input: async ctx => ({ ctx: { identity: await requireIdentity(ctx) }, args: {} }),
});

export const signedInMutation = customMutation(mutation, {
  args: {},
  input: async ctx => ({ ctx: { identity: await requireIdentity(ctx) }, args: {} }),
});
