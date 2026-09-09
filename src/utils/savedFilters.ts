import type { GlobalFilters } from './filters';

/** Restore filters before choosing which history files to fetch. */
export function readSavedFilters(defaults: GlobalFilters): GlobalFilters {
    try {
        const value = JSON.parse(localStorage.getItem('hdb_globalFilters') || 'null');
        if (!value || typeof value !== 'object') return defaults;
        const number = (key: 'leaseMin' | 'leaseMax' | 'floorMin') =>
            typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : defaults[key];
        return {
            date: value.date === '' || value.date === 'all' || /^\d{4}-(0[1-9]|1[0-2])$/.test(value.date)
                ? value.date : defaults.date,
            flatTypes: Array.isArray(value.flatTypes) && value.flatTypes.every((v: unknown) => typeof v === 'string')
                ? value.flatTypes : defaults.flatTypes,
            leaseMin: number('leaseMin'),
            leaseMax: number('leaseMax'),
            floorMin: number('floorMin'),
        };
    } catch { return defaults; }
}
