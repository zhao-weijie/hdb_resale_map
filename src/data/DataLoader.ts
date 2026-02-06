/**
 * DataLoader - Loads and manages HDB resale data from Arrow format
 */

import { tableFromIPC } from 'apache-arrow';
import RBush from 'rbush';

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
    // New fields for fair value analysis
    storey_midpoint: number;
    mrt_distance_m: number;
    price_index: number;
}

interface SpatialItem {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    index: number;
}

export class DataLoader {
    private data: HDBTransaction[] = [];
    private spatialIndex: RBush<SpatialItem> | null = null;

    async load(url: string): Promise<void> {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const table = tableFromIPC(new Uint8Array(buffer));

        // Convert Arrow table to array of objects
        this.data = [];
        for (let i = 0; i < table.numRows; i++) {
            this.data.push({
                month: table.getChild('month')?.get(i) ?? '',
                transaction_date: new Date(table.getChild('transaction_date')?.get(i) ?? 0),
                town: table.getChild('town')?.get(i) ?? '',
                flat_type: table.getChild('flat_type')?.get(i) ?? '',
                block: table.getChild('block')?.get(i) ?? '',
                street_name: table.getChild('street_name')?.get(i) ?? '',
                storey_range: table.getChild('storey_range')?.get(i) ?? '',
                floor_area_sqm: table.getChild('floor_area_sqm')?.get(i) ?? 0,
                flat_model: table.getChild('flat_model')?.get(i) ?? '',
                lease_commence_date: table.getChild('lease_commence_date')?.get(i) ?? 0,
                remaining_lease_years: table.getChild('remaining_lease_years')?.get(i) ?? 0,
                resale_price: table.getChild('resale_price')?.get(i) ?? 0,
                price_psm: table.getChild('price_psm')?.get(i) ?? 0,
                price_psf: table.getChild('price_psf')?.get(i) ?? 0,
                latitude: table.getChild('latitude')?.get(i) ?? 0,
                longitude: table.getChild('longitude')?.get(i) ?? 0,
                // New fields for fair value analysis
                storey_midpoint: table.getChild('storey_midpoint')?.get(i) ?? 0,
                mrt_distance_m: table.getChild('mrt_distance_m')?.get(i) ?? 0,
                price_index: table.getChild('price_index')?.get(i) ?? 100,
            });
        }

        // Build spatial index
        this.buildSpatialIndex();
    }

    private buildSpatialIndex(): void {
        this.spatialIndex = new RBush();
        const items: SpatialItem[] = this.data.map((transaction, index) => ({
            minX: transaction.longitude,
            minY: transaction.latitude,
            maxX: transaction.longitude,
            maxY: transaction.latitude,
            index,
        }));
        this.spatialIndex.load(items);
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
                const distance = this.haversineDistance(
                    centerLat,
                    centerLng,
                    transaction.latitude,
                    transaction.longitude
                );
                return distance <= radiusMeters;
            });
    }

    /**
     * Calculate haversine distance between two points (in meters)
     */
    private haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
        const R = 6371000; // Earth radius in meters
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLng = ((lng2 - lng1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    getAllData(): HDBTransaction[] {
        return this.data;
    }

    getRecordCount(): number {
        return this.data.length;
    }
}
