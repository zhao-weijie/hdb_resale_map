import { Email } from '@convex-dev/auth/providers/Email';
import { convexAuth } from '@convex-dev/auth/server';
import { ConvexError } from 'convex/values';

const codeCount = 100_000_000;
const unbiasedLimit = Math.floor(2 ** 32 / codeCount) * codeCount;

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
    signIn: { maxFailedAttempsPerHour: 10 },
    providers: [Email({
        id: 'resend-otp',
        maxAge: 15 * 60,
        async generateVerificationToken() {
            const random = new Uint32Array(1);
            do {
                crypto.getRandomValues(random);
            } while (random[0] >= unbiasedLimit);
            return String(random[0] % codeCount).padStart(8, '0');
        },
        async sendVerificationRequest({ identifier, token }) {
            const canonical = identifier.normalize('NFKC').trim().toLowerCase();
            if (identifier !== canonical || canonical.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(canonical)) {
                throw new ConvexError('Enter a valid email address.');
            }
            const key = process.env.AUTH_RESEND_KEY;
            const from = process.env.AUTH_RESEND_FROM;
            if (!key || !from) throw new ConvexError('Email sign-in needs a configured sender.');
            const result = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from,
                    to: [canonical],
                    subject: 'Your HDB Resale Map sign-in code',
                    text: `Your sign-in code is ${token}. It expires in 15 minutes.`,
                }),
            });
            if (!result.ok) throw new ConvexError('Could not send the sign-in code. Try again shortly.');
        },
    })],
});
