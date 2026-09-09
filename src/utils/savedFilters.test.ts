import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSavedFilters } from './savedFilters';

const defaults = { date: '2024-01', flatTypes: ['4 ROOM'], leaseMin: 0, leaseMax: 99, floorMin: 1 };
afterEach(() => vi.unstubAllGlobals());

describe('saved startup filters', () => {
    it('preserves all-history and empty selections before data loading', () => {
        vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ ...defaults, date: '', flatTypes: [], leaseMax: 0 }) });
        expect(readSavedFilters(defaults)).toEqual({ ...defaults, date: '', flatTypes: [], leaseMax: 0 });
    });

    it('falls back for malformed fields and unavailable storage', () => {
        vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ date: '2024-99', flatTypes: '4 ROOM', leaseMin: 'bad' }) });
        expect(readSavedFilters(defaults)).toEqual(defaults);
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Unavailable'); } });
        expect(readSavedFilters(defaults)).toEqual(defaults);
    });
});
