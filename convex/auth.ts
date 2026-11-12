import { Email } from '@convex-dev/auth/providers/Email';
import { convexAuth, type SignInAction } from '@convex-dev/auth/server';
import { defineRateLimits, isRateLimitError, rateLimit as consumeRateLimit } from 'convex-helpers/server/rateLimit';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalMutation, type ActionCtx, type MutationCtx } from './_generated/server';
import { hash } from './trackerValidation';

const emailProvider = 'resend-otp';
const codeCount = 100_000_000;
const unbiasedLimit = Math.floor(2 ** 32 / codeCount) * codeCount;
const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;
const codeLifetime = 15 * minute;
const retention = 2 * hour;
const failedAttemptsPerHour = 10;
const invalidCode = 'That sign-in code is incorrect or has expired.';
const activeCode = 'Use the most recent sign-in code, or request another after it expires.';
const sendLater = 'Too many sign-in code requests. Wait before trying again.';

const { rateLimit } = defineRateLimits({
    otpSendRecipient: { kind: 'token bucket', rate: 1, period: minute, capacity: 1 },
    otpSendBurst: { kind: 'token bucket', rate: 2, period: second, capacity: 2 },
    otpSendSource: { kind: 'fixed window', rate: 15, period: day, start: 0 },
    otpVerifyRecipient: { kind: 'token bucket', rate: failedAttemptsPerHour, period: hour },
    otpVerifyBurst: { kind: 'token bucket', rate: 60, period: minute, capacity: 20 },
    otpVerifySource: { kind: 'token bucket', rate: 30, period: minute, capacity: 15 },
});

function dailySendLimit() {
    const configured = process.env.AUTH_OTP_DAILY_SEND_LIMIT;
    if (configured === undefined) return 60;
    if (!/^[1-9]\d{0,3}$/.test(configured) || Number(configured) > 1000) {
        throw new ConvexError('Email sign-in needs a valid daily send limit.');
    }
    return Number(configured);
}

function emailIdentifier(input: string): string {
    const email = input.normalize('NFKC').trim().toLowerCase();
    const [local, domain] = email.split('@');
    const localAtom = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+$/u;
    const domainLabel = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?$/u;
    if (email.length > 254 || !domain || local.length > 64 || !domain.includes('.') ||
        !local.split('.').every(part => localAtom.test(part)) ||
        !domain.split('.').every(part => domainLabel.test(part)) ||
        email !== `${local}@${domain}`) {
        throw new ConvexError('Enter a valid email address.');
    }
    return email;
}

class DeliveryRejected extends ConvexError<string> {}
class DeliveryUnconfirmed extends Error {}

const authLibrary = convexAuth({
    signIn: { maxFailedAttempsPerHour: failedAttemptsPerHour },
    callbacks: {
        async afterUserCreatedOrUpdated(ctx, { type, profile }) {
            if (type !== 'email' || !profile.email) return;
            // The Auth write is a separate transaction from admission. Recheck there
            // in case another admitted action has since created a code.
            const { code } = await otpAccount(ctx as MutationCtx, profile.email);
            if (code && code.expirationTime > Date.now()) throw new ConvexError(activeCode);
        },
    },
    providers: [Email({
        id: emailProvider,
        maxAge: codeLifetime / second,
        async generateVerificationToken() {
            const random = new Uint32Array(1);
            do {
                crypto.getRandomValues(random);
            } while (random[0] >= unbiasedLimit);
            return String(random[0] % codeCount).padStart(8, '0');
        },
        async sendVerificationRequest({ identifier, token }) {
            const key = process.env.AUTH_RESEND_KEY;
            const from = process.env.AUTH_RESEND_FROM;
            if (!key || !from) throw new ConvexError('Email sign-in needs a configured sender.');
            let result: Response;
            try {
                result = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from,
                        to: [identifier],
                        subject: 'Your HDB Resale Map sign-in code',
                        text: `Your sign-in code is ${token}. It expires in 15 minutes.`,
                    }),
                });
            } catch {
                throw new DeliveryUnconfirmed();
            }
            if (!result.ok) {
                if (result.status >= 400 && result.status < 500 && result.status !== 408) {
                    throw new DeliveryRejected('Could not send the code. Wait a minute before trying again.');
                }
                throw new DeliveryUnconfirmed();
            }
        },
    })],
});

export const { auth, signOut, store, isAuthenticated } = authLibrary;

// The locked Convex version exposes the registered action's handler at runtime.
// Convex Auth has no public hook that guards every sign-in branch before writes.
const { _handler: runLibrarySignIn } = authLibrary.signIn as typeof authLibrary.signIn & {
    _handler: (ctx: ActionCtx, args: FunctionArgs<SignInAction>) => Promise<FunctionReturnType<SignInAction>>;
};
if (typeof runLibrarySignIn !== 'function') throw new Error('Convex Auth sign-in handler is unavailable.');

export const signIn = action({
    args: {
        refreshToken: v.optional(v.string()),
        provider: v.optional(v.literal(emailProvider)),
        params: v.optional(v.object({ email: v.string(), code: v.optional(v.string()) })),
    },
    returns: v.object({
        started: v.optional(v.boolean()),
        tokens: v.optional(v.union(v.null(), v.object({ token: v.string(), refreshToken: v.string() }))),
    }),
    handler: async (ctx, args): Promise<{ started?: boolean; tokens?: { token: string; refreshToken: string } | null }> => {
        // Keep the library action unexported so every OTP call goes through admission.
        if (args.refreshToken !== undefined) {
            if (args.params || args.provider || !args.refreshToken || args.refreshToken.length > 512) {
                throw new ConvexError('Invalid sign-in request.');
            }
            return runLibrarySignIn(ctx, { refreshToken: args.refreshToken });
        }
        if (!args.params || (!args.provider && args.params.code === undefined)) {
            throw new ConvexError('Invalid sign-in request.');
        }

        if (args.params.email.length > 1024) throw new ConvexError('Enter a valid email address.');
        const email = emailIdentifier(args.params.email);
        const code = args.params.code;
        if (code !== undefined && !/^\d{8}$/.test(code)) throw new ConvexError(invalidCode);
        const admittedAt = await ctx.runMutation(internal.auth.admitOtp, { email, verify: code !== undefined });
        if (admittedAt === null) return { started: true };
        try {
            return await runLibrarySignIn(ctx, { provider: emailProvider, params: { email, code } });
        } catch (error) {
            if (code !== undefined) throw new ConvexError(invalidCode);
            // An ambiguous response may still have delivered the code.
            if (error instanceof DeliveryUnconfirmed || (error instanceof ConvexError && error.data === activeCode)) {
                return { started: true };
            }
            if (error instanceof DeliveryRejected) {
                await ctx.runMutation(internal.auth.discardRejectedCode, { email, admittedAt });
            }
            throw error;
        }
    },
});

async function otpAccount(ctx: MutationCtx, email: string) {
    const account = await ctx.db.query('authAccounts').withIndex('providerAndAccountId', q =>
        q.eq('provider', emailProvider).eq('providerAccountId', email)).unique();
    const code = account && await ctx.db.query('authVerificationCodes').withIndex('accountId', q =>
        q.eq('accountId', account._id)).unique();
    return { account, code };
}

function recipientRate(ctx: MutationCtx, name: 'otpSendRecipient' | 'otpVerifyRecipient', email: string) {
    return ctx.db.query('rateLimits').withIndex('name', q => q.eq('name', name).eq('key', email)).unique();
}

export const admitOtp = internalMutation({
    args: { email: v.string(), verify: v.boolean() },
    returns: v.union(v.number(), v.null()),
    handler: async (ctx, { email, verify }) => {
        const now = Date.now();
        const { account, code } = await otpAccount(ctx, email);
        const hasPendingCode = code !== null && code.expirationTime > now;
        if (verify && !hasPendingCode) throw new ConvexError(invalidCode);
        if (!verify && hasPendingCode) return null;

        // Metadata propagates from the public action. A fixed key space avoids
        // storing raw addresses or growing the table with every new source.
        const { ip } = await ctx.meta.getRequestMetadata();
        const source = ip ? (await hash(ip)).slice(0, 3) : 'no-ip';
        try {
            if (verify) {
                const firstLegacyAttempt = !await recipientRate(ctx, 'otpSendRecipient', email) &&
                    !await recipientRate(ctx, 'otpVerifyRecipient', email);
                await rateLimit(ctx, { name: 'otpVerifyRecipient', key: email, throws: true });
                await rateLimit(ctx, { name: 'otpVerifyBurst', throws: true });
                await rateLimit(ctx, { name: 'otpVerifySource', key: source, throws: true });
                if (firstLegacyAttempt) await ctx.scheduler.runAfter(retention, internal.auth.expireOtpState, { email });
            } else {
                if (!process.env.AUTH_RESEND_KEY || !process.env.AUTH_RESEND_FROM) {
                    throw new ConvexError('Email sign-in needs a configured sender.');
                }
                await rateLimit(ctx, { name: 'otpSendRecipient', key: email, throws: true });
                await rateLimit(ctx, { name: 'otpSendBurst', throws: true });
                const daily = await consumeRateLimit(ctx, {
                    name: 'otpSendDaily', config: { kind: 'fixed window', rate: dailySendLimit(), period: day, start: 0 },
                });
                if (!daily.ok) throw new ConvexError('The daily sign-in code limit has been reached. Try again after 08:00 Singapore time.');
                if (!(await rateLimit(ctx, { name: 'otpSendSource', key: source })).ok) {
                    throw new ConvexError('This network has reached its daily sign-in code limit. Try again after 08:00 Singapore time.');
                }
                await ctx.scheduler.runAfter(retention, internal.auth.expireOtpState, {
                    email, removeUnverifiedCreatedAfter: account ? undefined : now,
                });
            }
        } catch (error) {
            if (isRateLimitError(error)) throw new ConvexError(verify ? invalidCode : sendLater);
            throw error;
        }
        return now;
    },
});

export const discardRejectedCode = internalMutation({
    args: { email: v.string(), admittedAt: v.number() },
    returns: v.null(),
    handler: async (ctx, { email, admittedAt }) => {
        const reservation = await recipientRate(ctx, 'otpSendRecipient', email);
        const { code } = await otpAccount(ctx, email);
        if (reservation?.ts === admittedAt && code && code._creationTime >= admittedAt) {
            await ctx.db.delete(code._id);
        }
        return null;
    },
});

export const expireOtpState = internalMutation({
    args: { email: v.string(), removeUnverifiedCreatedAfter: v.optional(v.number()) },
    returns: v.null(),
    handler: async (ctx, args) => {
        const now = Date.now();
        const { email, removeUnverifiedCreatedAfter } = args;
        const reservation = await recipientRate(ctx, 'otpSendRecipient', email);
        if (removeUnverifiedCreatedAfter !== undefined && reservation && reservation.ts > now - retention) {
            await ctx.scheduler.runAfter(reservation.ts + retention - now, internal.auth.expireOtpState, args);
            return null;
        }
        const { account, code } = await otpAccount(ctx, email);
        if (code && code.expirationTime > now) {
            // A later send can keep the original unverified account in use.
            if (removeUnverifiedCreatedAfter !== undefined) {
                await ctx.scheduler.runAfter(code.expirationTime - now + hour, internal.auth.expireOtpState, args);
            }
            return null;
        }
        if (code) await ctx.db.delete(code._id);

        if (reservation && reservation.ts <= now - retention) await ctx.db.delete(reservation._id);
        const verificationRate = await recipientRate(ctx, 'otpVerifyRecipient', email);
        if (verificationRate && verificationRate.ts <= now - hour) await ctx.db.delete(verificationRate._id);
        const failures = await ctx.db.query('authRateLimits').withIndex('identifier', q =>
            q.eq('identifier', email)).unique();
        if (failures && failures.lastAttemptTime <= now - hour) await ctx.db.delete(failures._id);

        if (removeUnverifiedCreatedAfter === undefined || !account ||
            account._creationTime < removeUnverifiedCreatedAfter || account.emailVerified || account.phoneVerified) return null;
        const user = await ctx.db.get(account.userId);
        if (!user || user._creationTime < removeUnverifiedCreatedAfter ||
            user.emailVerificationTime !== undefined || user.phoneVerificationTime !== undefined) return null;
        const accounts = await ctx.db.query('authAccounts').withIndex('userIdAndProvider', q => q.eq('userId', user._id)).take(2);
        const session = await ctx.db.query('authSessions').withIndex('userId', q => q.eq('userId', user._id)).first();
        if (accounts.length === 1 && !session) {
            await ctx.db.delete(account._id);
            await ctx.db.delete(user._id);
        }
        return null;
    },
});
