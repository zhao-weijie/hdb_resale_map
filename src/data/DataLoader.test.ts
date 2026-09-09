import { afterEach, describe, expect, it, vi } from 'vitest';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { DataLoader } from './DataLoader';

const manifest = {
    version: 1,
    minMonth: '2023-01',
    maxMonth: '2024-12',
    years: [
        { year: 2023, url: '2023.arrow', rows: 1, minMonth: '2023-02', maxMonth: '2023-02', sha256: 'a'.repeat(64) },
        { year: 2024, url: '2024.arrow', rows: 1, minMonth: '2024-02', maxMonth: '2024-02', sha256: 'b'.repeat(64) },
    ],
};

function arrow(month: string, block: string, street: string): Uint8Array {
    return tableToIPC(tableFromArrays({
        month: [month], transaction_date: [new Date(`${month}-01`).getTime()], town: ['TOWN'],
        flat_type: ['4 ROOM'], block: [block], street_name: [street], storey_range: ['07 TO 09'],
        floor_area_sqm: [90], flat_model: ['Improved'], lease_commence_date: [1990],
        remaining_lease_years: [70], resale_price: [500000], price_psm: [5555], price_psf: [516],
        latitude: [1.35], longitude: [103.8], mrt_distance_m: [500],
    }), 'file');
}

function response(body: unknown, url: string, ok = true): Response {
    const isBytes = body instanceof Uint8Array;
    return {
        ok,
        status: ok ? 200 : 500,
        url,
        json: async () => body,
        arrayBuffer: async () => isBytes
            ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
            : new ArrayBuffer(0),
    } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('DataLoader partition loading', () => {
    it('resolves year URLs relative to the manifest and builds block and spatial indexes', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith('manifest.json')) return response(manifest, 'https://example.test/data/manifest.json');
            return response(arrow('2024-02', '123', 'Test Road'), url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new DataLoader();

        await loader.loadManifest('https://example.test/data/manifest.json');
        await loader.ensureDateRange('2024-01', '2024-12');

        expect(fetchMock).toHaveBeenCalledWith('https://example.test/data/2024.arrow');
        expect(loader.getTransactionsForBlock(' 123 ', 'test road')).toHaveLength(1);
        expect(loader.queryRectangle(1.3, 103.7, 1.4, 103.9)).toHaveLength(1);
    });

    it('deduplicates concurrent year requests', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith('manifest.json')) return response(manifest, 'https://example.test/data/manifest.json');
            return response(arrow('2024-02', '1', 'ROAD'), url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new DataLoader();
        await loader.loadManifest('https://example.test/data/manifest.json');

        await Promise.all([
            loader.ensureDateRange('2024-01', '2024-12'),
            loader.ensureDateRange('2024-01', '2024-12'),
        ]);

        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('2024.arrow'))).toHaveLength(1);
        expect(loader.getRecordCount()).toBe(1);
    });

    it('does not partially commit a failed multi-year request', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith('manifest.json')) return response(manifest, 'https://example.test/data/manifest.json');
            if (url.endsWith('2024.arrow')) return response(null, url, false);
            return response(arrow('2023-02', '1', 'ROAD'), url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new DataLoader();
        await loader.loadManifest('https://example.test/data/manifest.json');

        await expect(loader.ensureDateRange('2023-01', '2024-12')).rejects.toThrow('Failed to load');
        expect(loader.getRecordCount()).toBe(0);
    });

    it('loads full history for a blank start month and rejects stale partition contents', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith('manifest.json')) return response(manifest, 'https://example.test/data/manifest.json');
            if (url.endsWith('2023.arrow')) return response(arrow('2023-02', '1', 'ROAD'), url);
            return response(arrow('2024-03', '2', 'ROAD'), url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new DataLoader();
        await loader.loadManifest('https://example.test/data/manifest.json');

        await expect(loader.ensureDateRange('')).rejects.toThrow('does not match its manifest');
        expect(loader.getRecordCount()).toBe(0);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('.arrow'))).toHaveLength(2);
    });

    it('accepts a future start month without requesting a partition', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) =>
            response(manifest, String(input)));
        vi.stubGlobal('fetch', fetchMock);
        const loader = new DataLoader();
        await loader.loadManifest('https://example.test/data/manifest.json');

        await loader.ensureDateRange('2030-01');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(loader.getRecordCount()).toBe(0);
    });

    it('rejects malformed manifests without discarding existing partition data', async () => {
        const data = arrow('2024-02', '1', 'ROAD');
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            return url.endsWith('.arrow')
                ? response(data, url)
                : response(url.includes('/data/') ? manifest : { version: 1, years: 'invalid' }, url);
        });
        vi.stubGlobal('fetch', fetchMock);
        const loader = new DataLoader();
        await loader.loadManifest('https://example.test/data/manifest.json');
        await loader.ensureDateRange('2024-01');

        await expect(loader.loadManifest('https://example.test/manifest.json')).rejects.toThrow('Invalid data manifest');
        expect(loader.getRecordCount()).toBe(1);
    });
});
