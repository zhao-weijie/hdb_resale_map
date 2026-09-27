/** Lazy loader for compact HDB whole-flat rental evidence.
 *
 * This loader is intentionally independent from DataLoader. A failed rental
 * request therefore never prevents the resale map from being explored.
 */

import type { RentalDataset, RentalLocation, RentalRecord } from '../rental/types';

interface CoverageSummary {
    validRows: number;
    resolvedRows: number;
    unresolvedRows: number;
    resolvedPercent: number;
    byStatus: Record<string, number>;
    unresolvedByReason: Record<string, number>;
}

interface RentalManifest {
    version: 2;
    generatedAt: string;
    minMonth: string;
    maxMonth: string;
    rows: number;
    url: string;
    sha256: string;
    coverage: CoverageSummary;
    addressCoverage: {
        uniqueAddresses: number;
        resolvedAddresses: number;
        unresolvedAddresses: number;
        byStatus: Record<string, number>;
        unresolvedByReason: Record<string, number>;
    };
}

interface RentalPayload {
    version: 2;
    generatedAt: string;
    columns: string[];
    locationColumns: string[];
    locations: unknown[];
    records: unknown[];
}

const RECORD_COLUMNS = ['month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent', 'location_id'] as const;
const LOCATION_COLUMNS = ['address_key', 'latitude', 'longitude'] as const;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Fetches rental data only on first use. Failed loads are not cached, so a UI
 * retry can request the manifest and asset again without disrupting resale.
 */
export class RentalDataLoader {
    private dataset: RentalDataset | null = null;
    private pending: Promise<RentalDataset> | null = null;

    async load(url = 'data/rental_manifest.json'): Promise<RentalDataset> {
        if (this.dataset) return this.dataset;
        if (this.pending) return this.pending;

        const pending = this.fetchDataset(url);
        this.pending = pending;
        try {
            const dataset = await pending;
            this.dataset = dataset;
            return dataset;
        } finally {
            if (this.pending === pending) this.pending = null;
        }
    }

    clearCache(): void {
        this.dataset = null;
    }

    private async fetchDataset(manifestUrl: string): Promise<RentalDataset> {
        const manifestResponse = await fetch(manifestUrl);
        if (!manifestResponse.ok) {
            throw new Error(`Failed to load rental manifest (${manifestResponse.status})`);
        }
        const manifest = this.validateManifest(await manifestResponse.json());
        const baseUrl = manifestResponse.url || new URL(manifestUrl, globalThis.location?.href ?? 'http://localhost/').href;
        const assetUrl = new URL(manifest.url, baseUrl).href;
        const assetResponse = await fetch(assetUrl);
        if (!assetResponse.ok) {
            throw new Error(`Failed to load rental data (${assetResponse.status})`);
        }
        const payload = this.validatePayload(await assetResponse.json());
        const locations = payload.locations.map((row, id) => this.decodeLocation(row, id));
        if (new Set(locations.map((location) => location.addressKey)).size !== locations.length) {
            throw new Error('Invalid rental locations');
        }
        const records = payload.records.map((row) => this.decodeRecord(row, locations.length));
        if (records.some((record) => record.locationId !== null &&
            locations[record.locationId].addressKey !== canonicalAddressKey(record.block, record.street_name))) {
            throw new Error('Rental location reference does not match its address');
        }

        const months = records.map((record) => record.month);
        const minMonth = months.reduce((min, month) => month < min ? month : min, months[0] ?? '');
        const maxMonth = months.reduce((max, month) => month > max ? month : max, months[0] ?? '');
        const resolvedRows = records.filter((record) => record.locationId !== null).length;
        if (payload.generatedAt !== manifest.generatedAt || records.length !== manifest.rows ||
            minMonth !== manifest.minMonth || maxMonth !== manifest.maxMonth ||
            resolvedRows !== manifest.coverage.resolvedRows || locations.length !== manifest.addressCoverage.resolvedAddresses) {
            throw new Error('Rental data does not match its manifest');
        }
        return {
            version: 2,
            generatedAt: payload.generatedAt,
            minMonth,
            maxMonth,
            records,
            locations,
        };
    }

    private validateManifest(value: unknown): RentalManifest {
        if (!value || typeof value !== 'object') throw new Error('Invalid rental manifest');
        const manifest = value as Partial<RentalManifest>;
        if (manifest.version !== 2 || !this.isDate(manifest.generatedAt) ||
            !this.isMonth(manifest.minMonth) || !this.isMonth(manifest.maxMonth) || manifest.minMonth > manifest.maxMonth ||
            typeof manifest.rows !== 'number' || !Number.isInteger(manifest.rows) || manifest.rows <= 0 ||
            typeof manifest.url !== 'string' || manifest.url.length === 0 || !SHA256_PATTERN.test(manifest.sha256 ?? '') ||
            !this.isCoverage(manifest.coverage, manifest.rows) || !this.isAddressCoverage(manifest.addressCoverage)) {
            throw new Error('Invalid rental manifest');
        }
        return manifest as RentalManifest;
    }

    private validatePayload(value: unknown): RentalPayload {
        if (!value || typeof value !== 'object') throw new Error('Invalid rental data');
        const payload = value as Partial<RentalPayload>;
        if (payload.version !== 2 || !this.isDate(payload.generatedAt) ||
            !Array.isArray(payload.columns) || payload.columns.length !== RECORD_COLUMNS.length ||
            payload.columns.some((column, index) => column !== RECORD_COLUMNS[index]) ||
            !Array.isArray(payload.locationColumns) || payload.locationColumns.length !== LOCATION_COLUMNS.length ||
            payload.locationColumns.some((column, index) => column !== LOCATION_COLUMNS[index]) ||
            !Array.isArray(payload.locations) ||
            !Array.isArray(payload.records)) {
            throw new Error('Invalid rental data');
        }
        return payload as RentalPayload;
    }

    private decodeRecord(value: unknown, locationCount: number): RentalRecord {
        if (!Array.isArray(value) || value.length !== RECORD_COLUMNS.length ||
            !this.isMonth(value[0]) || !this.isNonEmptyString(value[1]) || !this.isNonEmptyString(value[2]) ||
            !this.isNonEmptyString(value[3]) || !this.isNonEmptyString(value[4]) ||
            typeof value[5] !== 'number' || !Number.isFinite(value[5]) || value[5] <= 0 ||
            !(value[6] === null || (Number.isInteger(value[6]) && value[6] >= 0 && value[6] < locationCount))) {
            throw new Error('Invalid rental data record');
        }
        return {
            month: value[0],
            town: value[1],
            block: value[2],
            street_name: value[3],
            flat_type: value[4],
            monthly_rent: value[5],
            locationId: value[6],
        };
    }

    private decodeLocation(value: unknown, id: number): RentalLocation {
        if (!Array.isArray(value) || value.length !== LOCATION_COLUMNS.length ||
            !this.isNonEmptyString(value[0]) || typeof value[1] !== 'number' || !Number.isFinite(value[1]) ||
            typeof value[2] !== 'number' || !Number.isFinite(value[2]) ||
            value[1] < -90 || value[1] > 90 || value[2] < -180 || value[2] > 180) {
            throw new Error('Invalid rental location');
        }
        return { id, addressKey: value[0], latitude: value[1], longitude: value[2] };
    }

    private isCoverage(value: unknown, rows: number): value is CoverageSummary {
        if (!value || typeof value !== 'object') return false;
        const item = value as Partial<CoverageSummary>;
        return item.validRows === rows && Number.isInteger(item.resolvedRows) && (item.resolvedRows ?? -1) >= 0 &&
            Number.isInteger(item.unresolvedRows) && (item.unresolvedRows ?? -1) >= 0 &&
            (item.resolvedRows ?? 0) + (item.unresolvedRows ?? 0) === rows &&
            typeof item.resolvedPercent === 'number' && Number.isFinite(item.resolvedPercent) &&
            item.resolvedPercent > 99.5 && this.isCountMap(item.byStatus) &&
            Object.values(item.byStatus).reduce((total, count) => total + count, 0) === rows &&
            this.isCountMap(item.unresolvedByReason) &&
            Object.values(item.unresolvedByReason).reduce((total, count) => total + count, 0) === item.unresolvedRows;
    }

    private isAddressCoverage(value: unknown): boolean {
        if (!value || typeof value !== 'object') return false;
        const item = value as RentalManifest['addressCoverage'];
        return Number.isInteger(item.uniqueAddresses) && item.uniqueAddresses >= 0 &&
            Number.isInteger(item.resolvedAddresses) && item.resolvedAddresses >= 0 &&
            Number.isInteger(item.unresolvedAddresses) && item.unresolvedAddresses >= 0 &&
            item.resolvedAddresses + item.unresolvedAddresses === item.uniqueAddresses && this.isCountMap(item.byStatus) &&
            Object.values(item.byStatus).reduce((total, count) => total + count, 0) === item.uniqueAddresses &&
            this.isCountMap(item.unresolvedByReason) &&
            Object.values(item.unresolvedByReason).reduce((total, count) => total + count, 0) === item.unresolvedAddresses;
    }

    private isCountMap(value: unknown): value is Record<string, number> {
        return !!value && typeof value === 'object' && Object.values(value).every((count) => Number.isInteger(count) && count >= 0);
    }

    private isMonth(value: unknown): value is string {
        return typeof value === 'string' && MONTH_PATTERN.test(value);
    }

    private isDate(value: unknown): value is string {
        return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    }

    private isNonEmptyString(value: unknown): value is string {
        return typeof value === 'string' && value.trim().length > 0;
    }
}

/** Mirrors scripts/addressing.py; fixtures exercise both implementations. */
export function canonicalAddressKey(block: unknown, streetName: unknown): string {
    const part = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    return `${part(block)}|${part(streetName)}`;
}
