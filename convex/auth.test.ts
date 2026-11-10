import { generateKeyPairSync } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import { ensureTrackerUser } from './access';
import schema from './schema';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const provider = 'resend-otp';
const minute = 60_000;

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function mockDelivery(respond = () => new Response('{}', { status: 200 })) {
    vi.stubEnv('SITE_URL', 'https://tracker-test.example/hdb_resale_map/');
    vi.stubEnv('AUTH_RESEND_KEY', 'test-only');
    vi.stubEnv('AUTH_RESEND_FROM', 'Tracker <sender@example.test>');
    vi.stubEnv('AUTH_OTP_DAILY_SEND_LIMIT', undefined);
    const delivered: Array<{ to: string[]; text: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://api.resend.com/emails');
        delivered.push(JSON.parse(String(init?.body)));
        return respond();
    });
    return delivered;
}

test('email OTP is single-use and repeat sign-ins retain the same tracker owner', async () => {
    vi.useFakeTimers();
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    vi.stubEnv('JWT_PRIVATE_KEY', privateKey);
    vi.stubEnv('CONVEX_SITE_URL', 'https://tracker-test.convex.site');
    const delivered = mockDelivery();

    const tracker = convexTest(schema, modules);
    const email = 'buyer@example.test';
    await expect(tracker.action(api.auth.signIn, { provider, params: { email: '  Buyer@Example.TEST  ' } }))
        .resolves.toMatchObject({ started: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toEqual([email]);
    const code = delivered[0].text.match(/\b\d{8}\b/)?.[0];
    expect(code).toBeDefined();

    vi.advanceTimersByTime(2 * minute);
    await expect(tracker.action(api.auth.signIn, { provider, params: { email } }))
        .resolves.toMatchObject({ started: true });
    expect(delivered).toHaveLength(1);

    await expect(tracker.action(api.auth.signIn, {
        provider,
        params: { email: 'different@example.test', code },
    })).rejects.toThrow();
    expect(await tracker.run(ctx => ctx.db.query('authRateLimits').first())).toBeNull();

    const signIn = await tracker.action(api.auth.signIn, { provider, params: { email, code } });
    expect(signIn.tokens?.token.split('.')).toHaveLength(3);
    expect(signIn.tokens?.refreshToken).toBeTruthy();
    await expect(tracker.action(api.auth.signIn, { provider, params: { email, code } })).rejects.toThrow();

    const refreshed = await tracker.action(api.auth.signIn, { refreshToken: signIn.tokens!.refreshToken });
    expect(refreshed.tokens?.refreshToken).toBeTruthy();
    expect(refreshed.tokens?.refreshToken).not.toBe(signIn.tokens?.refreshToken);

    await tracker.action(api.auth.signIn, { provider, params: { email } });
    const nextCode = delivered[1].text.match(/\b\d{8}\b/)?.[0];
    const second = await tracker.action(api.auth.signIn, { params: { email, code: nextCode } });
    const claims = (token: string) => {
        const { iss, sub } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        return { issuer: String(iss), subject: String(sub) };
    };
    const firstIdentity = claims(signIn.tokens!.token);
    const secondIdentity = claims(second.tokens!.token);
    expect(secondIdentity.subject).not.toBe(firstIdentity.subject);
    const owner = await tracker.withIdentity(firstIdentity).run(ctx => ensureTrackerUser(ctx));
    const sameOwner = await tracker.withIdentity(secondIdentity).run(ctx => ensureTrackerUser(ctx));
    expect(sameOwner._id).toBe(owner._id);

    await tracker.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await tracker.run(ctx => ctx.db.query('authAccounts').first())).toMatchObject({ emailVerified: email });
});

test('malformed direct calls create no Auth records, limiter keys, or mail', async () => {
    const delivered = mockDelivery();
    const tracker = convexTest(schema, modules);
    const directSignIn = makeFunctionReference<'action'>('auth:signIn');
    for (const args of [
        { provider, params: { email: 'invalid' } },
        { provider, params: { email: 'buyer@<example.test>' } },
        { provider, params: { email: 'buyer@example.test', redirectTo: 'https://example.test/' } },
        { provider, params: { phone: 'buyer@example.test', code: '00000000' } },
        { params: { email: 'buyer@example.test' } },
        { params: { email: 'buyer@example.test', code: 'bad code' } },
        { refreshToken: 'arbitrary', params: { email: 'buyer@example.test', code: '00000000' } },
    ]) {
        await expect(tracker.action(directSignIn, args)).rejects.toThrow();
    }
    expect(delivered).toHaveLength(0);
    expect(await tracker.run(async ctx => ({
        user: await ctx.db.query('users').first(),
        failure: await ctx.db.query('authRateLimits').first(),
        limit: await ctx.db.query('rateLimits').first(),
    }))).toEqual({ user: null, failure: null, limit: null });
});

test('concurrent canonical recipients share a reservation and the deployment has send budgets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    const delivered = mockDelivery();
    vi.stubEnv('AUTH_OTP_DAILY_SEND_LIMIT', '2');
    const tracker = convexTest(schema, modules);
    const send = (email: string) => tracker.action(api.auth.signIn, { provider, params: { email } });
    await Promise.allSettled([send('First@example.test'), send(' first@EXAMPLE.test ')]);
    await expect(send('first@example.test')).resolves.toMatchObject({ started: true });
    await send('second@example.test');
    await expect(send('third@example.test')).rejects.toThrow('Too many sign-in code requests');
    vi.advanceTimersByTime(1000);
    await expect(send('third@example.test')).rejects.toThrow('daily sign-in code limit');
    expect(delivered.map(message => message.to[0])).toEqual(['first@example.test', 'second@example.test']);
    expect(await tracker.run(ctx => ctx.db.query('authAccounts').take(3))).toHaveLength(2);

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    await expect(send('third@example.test')).resolves.toMatchObject({ started: true });
});

test.each(['198.51.100.1', null])('the OTP source budget applies to request IP %s', async (ip) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    const delivered = mockDelivery();
    const tracker = convexTest(schema, modules);
    const source = tracker.withRequestMetadata({ ip });
    const send = (email: string) => source.action(api.auth.signIn, { provider, params: { email } });
    for (let index = 0; index < 15; index++) {
        await send(`buyer-${index}@example.test`);
        vi.advanceTimersByTime(1000);
    }
    const other = { provider, params: { email: 'other@example.test' } } as const;
    await expect(source.action(api.auth.signIn, other)).rejects.toThrow('This network has reached its daily');
    await expect(tracker.withRequestMetadata({ ip: '203.0.113.2' }).action(api.auth.signIn, other))
        .resolves.toMatchObject({ started: true });
    expect(delivered).toHaveLength(16);
    const sourceRows = await tracker.run(ctx =>
        ctx.db.query('rateLimits').withIndex('name', q => q.eq('name', 'otpSendSource')).take(3));
    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.every(row => row.key === 'no-ip' || /^[0-9a-f]{3}$/.test(row.key ?? ''))).toBe(true);
    expect(sourceRows.some(row => row.key === 'no-ip')).toBe(ip === null);
});

test('only live recipients can use the shared verification budget and canonical variants share a recipient limit', async () => {
    vi.useFakeTimers();
    const delivered = mockDelivery();
    const tracker = convexTest(schema, modules);
    const first = 'first@example.test';
    const second = 'second@example.test';
    const third = 'third@example.test';
    const send = (email: string) => tracker.action(api.auth.signIn, { provider, params: { email } });
    await send(first);
    await send(second);
    vi.advanceTimersByTime(500);
    await send(third);
    const sentCodes = delivered.map(message => message.text.match(/\b\d{8}\b/)![0]);
    const wrong = ['00000000', '00000001', '00000002', '00000003'].find(candidate => !sentCodes.includes(candidate))!;
    const source = tracker.withRequestMetadata({ ip: '198.51.100.1' });
    const verify = (email: string, caller: typeof source = tracker) =>
        caller.action(api.auth.signIn, { provider, params: { email, code: wrong } });
    const limiter = (name: string, key?: string) => tracker.run(ctx =>
        ctx.db.query('rateLimits').withIndex('name', q => q.eq('name', name).eq('key', key)).unique());

    const verificationFailure = 'That sign-in code is incorrect or has expired.';
    await expect(verify('unknown@example.test')).rejects.toThrow(verificationFailure);
    expect(await limiter('otpVerifyBurst')).toBeNull();
    for (let attempt = 0; attempt < 10; attempt++) {
        await expect(verify(' FIRST@example.test ', source)).rejects.toThrow(verificationFailure);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        await expect(verify(second, source)).rejects.toThrow(verificationFailure);
    }
    const secondBudget = await limiter('otpVerifyRecipient', second);
    await expect(verify(second, source)).rejects.toThrow(verificationFailure);
    expect(await limiter('otpVerifyRecipient', second)).toEqual(secondBudget);
    for (let attempt = 0; attempt < 5; attempt++) {
        await expect(verify(second)).rejects.toThrow(verificationFailure);
    }
    const firstBudget = await limiter('otpVerifyRecipient', first);
    expect(firstBudget?.value).toBe(0);
    await expect(verify(first)).rejects.toThrow();
    expect(await limiter('otpVerifyRecipient', first)).toEqual(firstBudget);
    expect((await limiter('otpVerifyBurst'))?.value).toBe(0);
    await expect(verify(third)).rejects.toThrow();
    expect(await limiter('otpVerifyRecipient', third)).toBeNull();
    vi.advanceTimersByTime(2000);
    await expect(verify(third)).rejects.toThrow();
    expect(await limiter('otpVerifyRecipient', third)).toMatchObject({ value: 9 });
});

test.each([500, 'network timeout'])('an ambiguous delivery (%s) preserves the OTP and reaches verification', async failure => {
    vi.useFakeTimers();
    const delivered = mockDelivery(() => {
        if (typeof failure === 'number') return new Response('{}', { status: failure });
        throw new Error('network timeout');
    });
    const tracker = convexTest(schema, modules);
    const email = 'buyer@example.test';
    const send = () => tracker.action(api.auth.signIn, { provider, params: { email } });
    await expect(send()).resolves.toMatchObject({ started: true });
    const originalCode = await tracker.run(ctx => ctx.db.query('authVerificationCodes').first());
    expect(originalCode).not.toBeNull();
    vi.advanceTimersByTime(2 * minute);
    await expect(send()).resolves.toMatchObject({ started: true });
    expect(delivered).toHaveLength(1);
    expect(await tracker.run(ctx => ctx.db.query('authVerificationCodes').first())).toEqual(originalCode);
});

test('rejected delivery discards the unusable code while preserving the recipient cooldown', async () => {
    vi.useFakeTimers();
    let responseStatus = 429;
    const delivered = mockDelivery(() => new Response('{}', { status: responseStatus }));
    const tracker = convexTest(schema, modules);
    const email = 'buyer@example.test';
    const send = () => tracker.action(api.auth.signIn, { provider, params: { email } });
    await expect(send()).rejects.toThrow('Could not send the code');
    expect(await tracker.run(ctx => ctx.db.query('authVerificationCodes').first())).toBeNull();
    await expect(send()).rejects.toThrow('Too many sign-in code requests');
    expect(delivered).toHaveLength(1);

    responseStatus = 200;
    vi.advanceTimersByTime(minute);
    await expect(send()).resolves.toMatchObject({ started: true });
    const actual = delivered[1].text.match(/\b\d{8}\b/)![0];
    const wrong = actual === '00000000' ? '00000001' : '00000000';
    await expect(tracker.action(api.auth.signIn, { provider, params: { email, code: wrong } })).rejects.toThrow();
    expect(await tracker.run(ctx => ctx.db.query('authRateLimits').first())).toMatchObject({ identifier: email });

    await tracker.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await tracker.run(async ctx => ({
        user: await ctx.db.query('users').first(),
        account: await ctx.db.query('authAccounts').first(),
        code: await ctx.db.query('authVerificationCodes').first(),
        failure: await ctx.db.query('authRateLimits').first(),
        recipientRates: await ctx.db.query('rateLimits').withIndex('name', q => q.eq('name', 'otpSendRecipient')).take(2),
    }))).toEqual({ user: null, account: null, code: null, failure: null, recipientRates: [] });
});
