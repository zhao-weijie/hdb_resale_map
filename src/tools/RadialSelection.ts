/**
 * RadialSelection - Tool for drawing circular area selections
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import { appState } from '../state/AppState';
import { circleSelection, filterBySpatialSelection } from '../spatial/selection';

export class RadialSelection {
    private dataLoader: DataLoader;

    constructor(dataLoader: DataLoader) {
        this.dataLoader = dataLoader;
    }

    /**
     * Start a radial selection
     */
    setSelection(centerLat: number, centerLng: number, radiusMeters: number): void {
        appState.setSpatialSelection(circleSelection(centerLat, centerLng, radiusMeters));
    }

    /**
     * Clear the selection
     */
    clearSelection(): void {
        appState.clearSpatialSelection();
    }

    /**
     * Query transactions within the selected area
     */
    getSelectedTransactions(): HDBTransaction[] | null {
        return filterBySpatialSelection(
            this.dataLoader.getAllData(),
            appState.get('spatialSelection'),
            (transaction) => ({ latitude: transaction.latitude, longitude: transaction.longitude })
        );
    }

    isSelectionActive(): boolean {
        return appState.get('spatialSelection').kind === 'circle';
    }

    getSelectionInfo(): { center: [number, number]; radius: number } | null {
        const selection = appState.get('spatialSelection');
        if (selection.kind !== 'circle') return null;
        return {
            center: [selection.center.latitude, selection.center.longitude],
            radius: selection.radiusMeters,
        };
    }
    // Helper aliases for AnalyticsPanel
    hasSelection(): boolean {
        return appState.get('spatialSelection').kind === 'circle';
    }

    getCurrentCenter(): { lat: number, lng: number } | null {
        const selection = appState.get('spatialSelection');
        if (selection.kind !== 'circle') return null;
        return { lat: selection.center.latitude, lng: selection.center.longitude };
    }
}
