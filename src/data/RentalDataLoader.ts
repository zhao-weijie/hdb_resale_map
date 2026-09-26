/** Lazy loader for compact HDB whole-flat rental evidence.
 *
 * This loader is intentionally independent from DataLoader. A failed rental
 * request therefore never prevents the resale map from being explored.
 */

import type { ProjectClassification, RentalDataset, RentalRecord } from '../rental/types';

interface RentalManifest {
    version: 1;
    generatedAt: string;
    minMonth: string;
    maxMonth: string;
    rows: number;
    url: string;
    sha256: string;
}

interface RentalPayload {
    version: 1;
    generatedAt: string;
    columns: string[];
    records: unknown[];
    classifications: unknown[];
}

const RECORD_COLUMNS = ['month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent'] as const;
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
        const records = payload.records.map((row) => this.decodeRecord(row));
        const classifications = payload.classifications.map((item) => this.decodeClassification(item));

        const months = records.map((record) => record.month);
        const minMonth = months.reduce((min, month) => month < min ? month : min, months[0] ?? '');
        const maxMonth = months.reduce((max, month) => month > max ? month : max, months[0] ?? '');
        if (payload.generatedAt !== manifest.generatedAt || records.length !== manifest.rows ||
            minMonth !== manifest.minMonth || maxMonth !== manifest.maxMonth) {
            throw new Error('Rental data does not match its manifest');
        }
        return {
            version: 1,
            generatedAt: payload.generatedAt,
            minMonth,
            maxMonth,
            records,
            classifications,
        };
    }

    private validateManifest(value: unknown): RentalManifest {
        if (!value || typeof value !== 'object') throw new Error('Invalid rental manifest');
        const manifest = value as Partial<RentalManifest>;
        if (manifest.version !== 1 || !this.isDate(manifest.generatedAt) ||
            !this.isMonth(manifest.minMonth) || !this.isMonth(manifest.maxMonth) || manifest.minMonth > manifest.maxMonth ||
            typeof manifest.rows !== 'number' || !Number.isInteger(manifest.rows) || manifest.rows <= 0 ||
            typeof manifest.url !== 'string' || manifest.url.length === 0 || !SHA256_PATTERN.test(manifest.sha256 ?? '')) {
            throw new Error('Invalid rental manifest');
        }
        return manifest as RentalManifest;
    }

    private validatePayload(value: unknown): RentalPayload {
        if (!value || typeof value !== 'object') throw new Error('Invalid rental data');
        const payload = value as Partial<RentalPayload>;
        if (payload.version !== 1 || !this.isDate(payload.generatedAt) ||
            !Array.isArray(payload.columns) || payload.columns.length !== RECORD_COLUMNS.length ||
            payload.columns.some((column, index) => column !== RECORD_COLUMNS[index]) ||
            !Array.isArray(payload.records) || !Array.isArray(payload.classifications)) {
            throw new Error('Invalid rental data');
        }
        return payload as RentalPayload;
    }

    private decodeRecord(value: unknown): RentalRecord {
        if (!Array.isArray(value) || value.length !== RECORD_COLUMNS.length ||
            !this.isMonth(value[0]) || !this.isNonEmptyString(value[1]) || !this.isNonEmptyString(value[2]) ||
            !this.isNonEmptyString(value[3]) || !this.isNonEmptyString(value[4]) ||
            typeof value[5] !== 'number' || !Number.isFinite(value[5]) || value[5] <= 0) {
            throw new Error('Invalid rental data record');
        }
        return {
            month: value[0],
            town: value[1],
            block: value[2],
            street_name: value[3],
            flat_type: value[4],
            monthly_rent: value[5],
        };
    }

    private decodeClassification(value: unknown): ProjectClassification {
        if (!value || typeof value !== 'object') throw new Error('Invalid rental classification');
        const item = value as Partial<ProjectClassification>;
        const categories = new Set(['legacy', 'standard', 'plus', 'prime', 'plh', 'unknown']);
        const eligibility = new Set(['allowed', 'prohibited', 'unknown']);
        if (!this.isNonEmptyString(item.block) || !this.isNonEmptyString(item.street_name) ||
            !categories.has(item.category ?? '') || !eligibility.has(item.wholeFlatRental ?? '') ||
            !this.isNonEmptyString(item.sourceUrl) || !this.isDate(item.reviewedAt) ||
            (item.projectName !== undefined && !this.isNonEmptyString(item.projectName)) ||
            (item.mopDate !== undefined && !this.isDate(item.mopDate))) {
            throw new Error('Invalid rental classification');
        }
        return item as ProjectClassification;
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
