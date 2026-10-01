/**
 * RadialSelection - Tool for drawing circular area selections
 */

import { appState } from '../state/AppState';
import { circleSelection } from '../spatial/selection';

export class RadialSelection {
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
