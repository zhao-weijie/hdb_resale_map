import { generateKeyPairSync } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import { ensureTrackerUser } from './access';
import schema from './schema';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

test('email OTP is single-use and repeat sign-ins retain the same tracker owner', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    vi.stubEnv('JWT_PRIVATE_KEY', privateKey);
    vi.stubEnv('CONVEX_SITE_URL', 'https://tracker-test.convex.site');
    vi.stubEnv('SITE_URL', 'https://tracker-test.example/hdb_resale_map/');
    vi.stubEnv('AUTH_RESEND_KEY', 'test-only');
    vi.stubEnv('AUTH_RESEND_FROM', 'Tracker <sender@example.test>');

    const delivered: Array<{ to: string[]; text: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://api.resend.com/emails');
        delivered.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
    });

    const tracker = convexTest(schema, modules);
    const provider = 'resend-otp';
    const email = 'buyer@example.test';
    await expect(tracker.action(api.auth.signIn, { provider, params: { email } }))
        .resolves.toMatchObject({ started: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toEqual([email]);
    const code = delivered[0].text.match(/\b\d{8}\b/)?.[0];
    expect(code).toBeDefined();

    await expect(tracker.action(api.auth.signIn, {
        provider,
        params: { email: 'different@example.test', code },
    })).rejects.toThrow();

    const signIn = await tracker.action(api.auth.signIn, { provider, params: { email, code } });
    expect(signIn.tokens?.token.split('.')).toHaveLength(3);
    expect(signIn.tokens?.refreshToken).toBeTruthy();
    await expect(tracker.action(api.auth.signIn, { provider, params: { email, code } })).rejects.toThrow();

    const refreshed = await tracker.action(api.auth.signIn, { refreshToken: signIn.tokens!.refreshToken });
    expect(refreshed.tokens?.refreshToken).toBeTruthy();
    expect(refreshed.tokens?.refreshToken).not.toBe(signIn.tokens?.refreshToken);

    await tracker.action(api.auth.signIn, { provider, params: { email } });
    const nextCode = delivered[1].text.match(/\b\d{8}\b/)?.[0];
    const second = await tracker.action(api.auth.signIn, { provider, params: { email, code: nextCode } });
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
});
