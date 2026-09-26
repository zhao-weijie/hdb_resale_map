import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalDataLoader } from './RentalDataLoader';

const manifest = {
    version: 1,
    generatedAt: '2026-09-25T00:00:00Z',
    minMonth: '2025-01',
    maxMonth: '2025-02',
    rows: 2,
    url: 'rental_data-test.json',
    sha256: 'a'.repeat(64),
};

const payload = {
    version: 1,
    generatedAt: manifest.generatedAt,
    columns: ['month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent'],
    records: [
        ['2025-01', 'TOWN', '123', 'TEST ROAD', '4 ROOM', 3200],
        ['2025-02', 'TOWN', '123', 'TEST ROAD', '4 ROOM', 3300],
    ],
    classifications: [],
};

function response(body: unknown, url: string, ok = true): Response {
    return { ok, status: ok ? 200 : 500, url, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('RentalDataLoader', () => {
    it('lazily resolves the asset relative to the manifest and caches a valid dataset', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            return url.endsWith('rental_manifest.json')
                ? response(manifest, 'https://example.test/data/rental_manifest.json')
                : response(payload, url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new RentalDataLoader();

        const [first, second] = await Promise.all([loader.load('https://example.test/data/rental_manifest.json'), loader.load('https://example.test/data/rental_manifest.json')]);
        const third = await loader.load('https://example.test/data/rental_manifest.json');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenCalledWith('https://example.test/data/rental_data-test.json');
        expect(first).toBe(second);
        expect(third).toBe(first);
        expect(first.records).toEqual([
            { month: '2025-01', town: 'TOWN', block: '123', street_name: 'TEST ROAD', flat_type: '4 ROOM', monthly_rent: 3200 },
            { month: '2025-02', town: 'TOWN', block: '123', street_name: 'TEST ROAD', flat_type: '4 ROOM', monthly_rent: 3300 },
        ]);
    });

    it('rejects corrupt manifests before requesting an asset', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) =>
            response({ ...manifest, sha256: 'not-a-hash' }, String(input)));
        vi.stubGlobal('fetch', fetchMock);

        await expect(new RentalDataLoader().load('https://example.test/data/rental_manifest.json')).rejects.toThrow('Invalid rental manifest');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects corrupt data and retries cleanly on a later request', async () => {
        let attempt = 0;
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith('rental_manifest.json')) return response(manifest, url);
            attempt += 1;
            return response(attempt === 1
                ? { ...payload, records: [['2025-01', 'TOWN', '123', 'ROAD', '4 ROOM', 0]] }
                : payload, url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new RentalDataLoader();

        await expect(loader.load('https://example.test/data/rental_manifest.json')).rejects.toThrow('Invalid rental data record');
        await expect(loader.load('https://example.test/data/rental_manifest.json')).resolves.toMatchObject({ records: payload.records.map(([month, town, block, street_name, flat_type, monthly_rent]) => ({ month, town, block, street_name, flat_type, monthly_rent })) });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('does not retain cache after clearCache', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            return url.endsWith('rental_manifest.json') ? response(manifest, url) : response(payload, url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new RentalDataLoader();

        await loader.load('https://example.test/data/rental_manifest.json');
        loader.clearCache();
        await loader.load('https://example.test/data/rental_manifest.json');
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});
