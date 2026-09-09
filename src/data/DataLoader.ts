/**
 * DataLoader - Loads and manages HDB resale data from Arrow format
 */

import { tableFromIPC } from 'apache-arrow';
import RBush from 'rbush';
import { haversineDistance } from '../utils/geo';


export interface HDBTransaction {
    month: string;
    transaction_date: Date;
    town: string;
    flat_type: string;
    block: string;
    street_name: string;
    storey_range: string;
    floor_area_sqm: number;
    flat_model: string;
    lease_commence_date: number;
    remaining_lease_years: number;
    resale_price: number;
    price_psm: number;
    price_psf: number;
    latitude: number;
    longitude: number;
    mrt_distance_m: number;
}

interface SpatialItem {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    index: number;
}

interface ManifestYear {
    year: number;
    url: string;
    rows: number;
    minMonth: string;
    maxMonth: string;
    sha256: string;
}

interface DataManifest {
    version: 1;
    minMonth: string;
    maxMonth: string;
    years: ManifestYear[];
}

export class DataLoader {
    private data: HDBTransaction[] = [];
    private spatialIndex: RBush<SpatialItem> | null = null;
    private blockIndex = new Map<string, HDBTransaction[]>();
    private manifest: DataManifest | null = null;
    private manifestUrl = '';
    private loadedYears = new Set<number>();
    private pendingYears = new Map<number, Promise<HDBTransaction[]>>();

    async loadManifest(url = 'data/manifest.json'): Promise<void> {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load data manifest (${response.status})`);
        const candidate: unknown = await response.json();
        const manifest = this.validateManifest(candidate);
        this.manifest = manifest;
        this.manifestUrl = response.url || new URL(url, globalThis.location?.href ?? 'http://localhost/').href;
        this.data = [];
        this.loadedYears.clear();
        this.pendingYears.clear();
        this.rebuildIndexes();
    }

    async ensureDateRange(fromMonth: string, toMonth?: string): Promise<void> {
        if (!this.manifest) throw new Error('Data manifest has not been loaded');
        if (fromMonth === '' || fromMonth === 'all') fromMonth = this.manifest.minMonth;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth)) throw new Error(`Invalid month: ${fromMonth}`);
        const endMonth = toMonth ?? this.manifest.maxMonth;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth) || (toMonth !== undefined && fromMonth > endMonth)) {
            throw new Error(`Invalid date range: ${fromMonth} to ${endMonth}`);
        }
        if (toMonth === undefined && fromMonth > this.manifest.maxMonth) return;
        const fromYear = Number(fromMonth.slice(0, 4));
        const toYear = Number(endMonth.slice(0, 4));
        const required = this.manifest.years.filter(({ year }) =>
            year >= fromYear && year <= toYear && !this.loadedYears.has(year));
        if (required.length === 0) return;

        const batches = required.map((entry) => {
            let pending = this.pendingYears.get(entry.year);
            if (!pending) {
                const resolvedUrl = new URL(entry.url, this.manifestUrl).href;
                pending = this.fetchArrow(resolvedUrl).finally(() => this.pendingYears.delete(entry.year));
                this.pendingYears.set(entry.year, pending);
            }
            return pending.then((transactions) => {
                this.validatePartition(entry, transactions);
                return { entry, transactions };
            });
        });
        const results = await Promise.all(batches);
        let changed = false;
        for (const { entry, transactions } of results) {
            if (this.loadedYears.has(entry.year)) continue;
            this.data = [...this.data, ...transactions];
            this.loadedYears.add(entry.year);
            changed = true;
        }
        if (changed) {
            this.data.sort((a, b) => a.month.localeCompare(b.month));
            this.rebuildIndexes();
        }
    }

    private async fetchArrow(url: string): Promise<HDBTransaction[]> {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load transaction data (${response.status}): ${url}`);
        const buffer = await response.arrayBuffer();
        const table = tableFromIPC(new Uint8Array(buffer));
        const names = [
            'month', 'transaction_date', 'town', 'flat_type', 'block', 'street_name',
            'storey_range', 'floor_area_sqm', 'flat_model', 'lease_commence_date',
            'remaining_lease_years', 'resale_price', 'price_psm', 'price_psf',
            'latitude', 'longitude', 'mrt_distance_m',
        ] as const;
        const columns = Object.fromEntries(names.map((name) => [name, table.getChild(name)]));
        const missing = names.filter((name) => !columns[name]);
        if (missing.length) throw new Error(`Arrow data is missing columns: ${missing.join(', ')}`);

        const loaded: HDBTransaction[] = [];
        for (let i = 0; i < table.numRows; i++) {
            loaded.push({
                month: columns.month!.get(i) ?? '',
                transaction_date: new Date(columns.transaction_date!.get(i) ?? 0),
                town: columns.town!.get(i) ?? '',
                flat_type: columns.flat_type!.get(i) ?? '',
                block: columns.block!.get(i) ?? '',
                street_name: columns.street_name!.get(i) ?? '',
                storey_range: columns.storey_range!.get(i) ?? '',
                floor_area_sqm: columns.floor_area_sqm!.get(i) ?? 0,
                flat_model: columns.flat_model!.get(i) ?? '',
                lease_commence_date: columns.lease_commence_date!.get(i) ?? 0,
                remaining_lease_years: columns.remaining_lease_years!.get(i) ?? 0,
                resale_price: columns.resale_price!.get(i) ?? 0,
                price_psm: columns.price_psm!.get(i) ?? 0,
                price_psf: columns.price_psf!.get(i) ?? 0,
                latitude: columns.latitude!.get(i) ?? 0,
                longitude: columns.longitude!.get(i) ?? 0,
                mrt_distance_m: columns.mrt_distance_m!.get(i) ?? 0,
            });
        }
        return loaded;
    }

    private rebuildIndexes(): void {
        this.spatialIndex = new RBush();
        const items: SpatialItem[] = this.data.map((transaction, index) => ({
            minX: transaction.longitude,
            minY: transaction.latitude,
            maxX: transaction.longitude,
            maxY: transaction.latitude,
            index,
        }));
        this.spatialIndex.load(items);
        this.blockIndex.clear();
        for (const transaction of this.data) {
            const key = this.blockKey(transaction.block, transaction.street_name);
            const matches = this.blockIndex.get(key);
            if (matches) matches.push(transaction);
            else this.blockIndex.set(key, [transaction]);
        }
    }

    private validateManifest(value: unknown): DataManifest {
        if (!value || typeof value !== 'object') throw new Error('Invalid data manifest');
        const manifest = value as Partial<DataManifest>;
        if (manifest.version !== 1 || typeof manifest.minMonth !== 'string' ||
            typeof manifest.maxMonth !== 'string' || !Array.isArray(manifest.years)) {
            throw new Error('Invalid data manifest');
        }
        const seen = new Set<number>();
        for (const entry of manifest.years) {
            if (!entry || !Number.isInteger(entry.year) || seen.has(entry.year) ||
                typeof entry.url !== 'string' || entry.url.length === 0 ||
                !Number.isInteger(entry.rows) || entry.rows < 0 ||
                typeof entry.minMonth !== 'string' || typeof entry.maxMonth !== 'string' ||
                !/^[a-f0-9]{64}$/.test(entry.sha256)) {
                throw new Error('Invalid data manifest year entry');
            }
            seen.add(entry.year);
        }
        return manifest as DataManifest;
    }

    private validatePartition(entry: ManifestYear, transactions: HDBTransaction[]): void {
        const months = transactions.map(({ month }) => month);
        const minMonth = months.reduce((min, month) => month < min ? month : min, months[0] ?? '');
        const maxMonth = months.reduce((max, month) => month > max ? month : max, months[0] ?? '');
        if (transactions.length !== entry.rows || minMonth !== entry.minMonth || maxMonth !== entry.maxMonth ||
            months.some((month) => !month.startsWith(`${entry.year}-`))) {
            throw new Error(`Partition ${entry.year} does not match its manifest`);
        }
    }

    private blockKey(block: string, streetName: string): string {
        return `${block.trim().toUpperCase()}|${streetName.trim().toUpperCase()}`;
    }

    /**
     * Query data within a circular area
     */
    queryCircle(centerLat: number, centerLng: number, radiusMeters: number): HDBTransaction[] {
        if (!this.spatialIndex) return [];

        // Convert radius to approximate lat/lng bounds
        // 1 degree latitude ≈ 111km, 1 degree longitude ≈ 111km * cos(latitude)
        const latOffset = radiusMeters / 111000;
        const lngOffset = radiusMeters / (111000 * Math.cos((centerLat * Math.PI) / 180));

        const bbox = {
            minX: centerLng - lngOffset,
            minY: centerLat - latOffset,
            maxX: centerLng + lngOffset,
            maxY: centerLat + latOffset,
        };

        const candidates = this.spatialIndex.search(bbox);

        // Filter by exact circle distance
        return candidates
            .map((item) => this.data[item.index])
            .filter((transaction) => {
                const distance = haversineDistance(
                    centerLat,
                    centerLng,
                    transaction.latitude,
                    transaction.longitude
                );
                return distance <= radiusMeters;
            });
    }

    /**
     * Query data within a rectangular area (bounding box)
     */
    queryRectangle(minLat: number, minLng: number, maxLat: number, maxLng: number): HDBTransaction[] {
        if (!this.spatialIndex) return [];

        const bbox = {
            minX: minLng,
            minY: minLat,
            maxX: maxLng,
            maxY: maxLat,
        };

        const candidates = this.spatialIndex.search(bbox);

        // RBush is precise for rectangles matching the axes, so we can return directly
        // But RBush stores items based on their individual points, and search returns items that INTERSECT
        // Since our items are points (minX=maxX, minY=maxY), intersection means they are inside the bbox.
        // So we just map back to data.
        return candidates.map((item) => this.data[item.index]);
    }


    getAllData(): HDBTransaction[] {
        return this.data;
    }

    getRecordCount(): number {
        return this.data.length;
    }

    getTransactionsForBlock(block: string, streetName: string): HDBTransaction[] {
        return this.blockIndex.get(this.blockKey(block, streetName)) ?? [];
    }
}
