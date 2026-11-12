/// <reference types="vite/client" />

import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';

type Session = { token: string; refreshToken: string };
const emailProvider = 'resend-otp';
const connectTimeoutMs = 15_000;

function parseSession(value: string | null): Session | null {
    try {
        const session = value ? JSON.parse(value) : null;
        return typeof session?.token === 'string' && typeof session?.refreshToken === 'string'
            ? session
            : null;
    } catch {
        return null;
    }
}

function sessionSubject(token: string): string | undefined {
    try {
        const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return typeof claims.sub === 'string' ? claims.sub : undefined;
    } catch {
        return undefined;
    }
}

function emailIdentifier(email: string): string {
    const value = email.normalize('NFKC').trim().toLowerCase();
    if (value.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value)) {
        throw new Error('Enter a valid email address.');
    }
    return value;
}

class ListingClient {
    readonly convex: ConvexClient | null;
    readonly ready: Promise<void>;

    private readonly publicHttp: ConvexHttpClient | null;
    private readonly storageKey: string;
    private session: Session | null = null;
    private authenticated = false;
    private generation = 0;
    private refreshInFlight: Promise<string | null> | null = null;
    private readonly listeners = new Set<(signedIn: boolean) => void>();

    constructor(private readonly url: string) {
        this.storageKey = `hdb-resale-map:listing-session:${url}`;
        this.convex = url ? new ConvexClient(url) : null;
        this.publicHttp = url ? this.http() : null;
        this.session = this.readStoredSession();
        this.ready = this.connectSession(this.session).then(() => undefined);
        if (url) window.addEventListener('storage', this.syncStorage);
    }

    isSignedIn(): boolean {
        return this.authenticated;
    }

    subscribeAuth(listener: (signedIn: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async sendCode(email: string): Promise<void> {
        const client = this.requireHttp();
        const identifier = emailIdentifier(email);
        try {
            await client.action(api.auth.signIn, { provider: emailProvider, params: { email: identifier } });
        } catch (error) {
            if (error instanceof ConvexError && typeof error.data === 'string') throw new Error(error.data);
            throw new Error('Could not send a code. Check your connection and try again.');
        }
    }

    async verifyCode(email: string, code: string): Promise<void> {
        const value = code.trim();
        if (!/^\d{8}$/.test(value)) throw new Error('Enter the eight-digit code from your email.');
        const client = this.requireHttp();
        const identifier = emailIdentifier(email);
        let session: Session | null | undefined;
        try {
            ({ tokens: session } = await client.action(api.auth.signIn, {
                provider: emailProvider,
                params: { email: identifier, code: value },
            }));
        } catch (error) {
            if (error instanceof TypeError || error instanceof DOMException) {
                throw new Error('Could not reach sign-in. Check your connection and try again.');
            }
            throw new Error('That sign-in code is incorrect or has expired.');
        }
        if (!session) throw new Error('That sign-in code is incorrect or has expired.');
        this.writeStoredSession(session);
        if (!await this.connectSession(session)) {
            throw new Error('Could not confirm sign-in. Check your connection and reload to resume.');
        }
    }

    async signOut(): Promise<void> {
        const previous = this.session;
        this.writeStoredSession(null);
        await this.connectSession(null);
        if (previous) await this.http(previous.token).action(api.auth.signOut, {});
    }

    private requireHttp(): ConvexHttpClient {
        if (!this.publicHttp) throw new Error('Saved homes needs a configured backend.');
        return this.publicHttp;
    }

    private http(auth?: string): ConvexHttpClient {
        return new ConvexHttpClient(this.url, {
            auth,
            logger: false,
            fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(connectTimeoutMs) }),
        });
    }

    private readStoredSession(): Session | null {
        try {
            return parseSession(localStorage.getItem(this.storageKey));
        } catch {
            return null;
        }
    }

    private writeStoredSession(session: Session | null): void {
        try {
            if (session) localStorage.setItem(this.storageKey, JSON.stringify(session));
            else localStorage.removeItem(this.storageKey);
        } catch {
            // The current tab can continue with an in-memory session.
        }
    }

    private readonly syncStorage = (event: StorageEvent): void => {
        if (event.key !== this.storageKey && event.key !== null) return;
        const next = this.readStoredSession();
        const subject = this.session && sessionSubject(this.session.token);
        if (next && subject && subject === sessionSubject(next.token)) {
            this.session = next;
        } else {
            void this.connectSession(next);
        }
    };

    private publishAuth(signedIn: boolean): void {
        if (this.authenticated === signedIn) return;
        this.authenticated = signedIn;
        for (const listener of this.listeners) listener(signedIn);
    }

    private connectSession(session: Session | null): Promise<boolean> {
        const client = this.convex;
        const generation = ++this.generation;
        this.refreshInFlight = null;
        this.session = session;
        this.publishAuth(false);
        if (!client) return Promise.resolve(false);
        if (!session) {
            client.setAuth(async () => null);
            return Promise.resolve(false);
        }

        return new Promise((resolve) => {
            const timeout = window.setTimeout(() => resolve(false), connectTimeoutMs);
            client.setAuth(async ({ forceRefreshToken }) => {
                if (generation !== this.generation) return null;
                if (!forceRefreshToken) return this.session?.token ?? null;
                return this.refresh(generation);
            }, (authenticated) => {
                if (generation !== this.generation) return;
                clearTimeout(timeout);
                this.publishAuth(authenticated);
                resolve(authenticated);
            });
        });
    }

    private refresh(generation: number): Promise<string | null> {
        if (this.refreshInFlight) return this.refreshInFlight;
        const previous = this.session;
        if (!previous) return Promise.resolve(null);

        const exchange = async (): Promise<string | null> => {
            if (generation !== this.generation) return null;
            const stored = this.readStoredSession();
            const subject = sessionSubject(previous.token);
            if (stored && subject && sessionSubject(stored.token) === subject && stored.token !== previous.token) {
                this.session = stored;
                return stored.token;
            }
            try {
                const result = await this.requireHttp().action(api.auth.signIn, { refreshToken: previous.refreshToken });
                if (generation !== this.generation) return null;
                this.session = result.tokens ?? null;
                this.writeStoredSession(this.session);
                return this.session?.token ?? null;
            } catch {
                // Keep the refresh token for a later reload when connectivity returns.
                return null;
            }
        };

        const request = async (): Promise<string | null> => {
            if (navigator.locks) return await navigator.locks.request(this.storageKey, exchange);
            return exchange();
        };
        const result = request().catch(() => null).finally(() => {
            if (this.refreshInFlight === result) this.refreshInFlight = null;
        });
        this.refreshInFlight = result;
        return result;
    }
}

export const listingClient = new ListingClient(import.meta.env.VITE_CONVEX_URL?.trim() ?? '');
