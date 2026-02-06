/**
 * RadialSelection - Tool for drawing circular area selections
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';

export class RadialSelection {
    private dataLoader: DataLoader;
    private centerLat: number | null = null;
    private centerLng: number | null = null;
    private radiusMeters: number = 0;
    private isActive: boolean = false;

    constructor(dataLoader: DataLoader) {
        this.dataLoader = dataLoader;
    }

    /**
     * Start a radial selection
     */
    setSelection(centerLat: number, centerLng: number, radiusMeters: number): void {
        this.centerLat = centerLat;
        this.centerLng = centerLng;
        this.radiusMeters = radiusMeters;
        this.isActive = true;
    }

    /**
     * Clear the selection
     */
    clearSelection(): void {
        this.centerLat = null;
        this.centerLng = null;
        this.radiusMeters = 0;
        this.isActive = false;
    }

    /**
     * Query transactions within the selected area
     */
    getSelectedTransactions(): HDBTransaction[] | null {
        if (!this.isActive || this.centerLat === null || this.centerLng === null) {
            return null;
        }
        return this.dataLoader.queryCircle(this.centerLat, this.centerLng, this.radiusMeters);
    }

    isSelectionActive(): boolean {
        return this.isActive;
    }

    getSelectionInfo(): { center: [number, number]; radius: number } | null {
        if (!this.isActive || this.centerLat === null || this.centerLng === null) {
            return null;
        }
        return {
            center: [this.centerLat, this.centerLng],
            radius: this.radiusMeters,
        };
    }
}
