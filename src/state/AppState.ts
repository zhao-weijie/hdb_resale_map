/**
 * Central application state management with pub/sub pattern
 * No external dependencies - lightweight observable store
 */

import type { HDBTransaction } from '../data/DataLoader';
import type { MapMetric } from '../metrics';
import type { GlobalFilters } from '../utils/filters';
import {
    NO_SPATIAL_SELECTION,
    filterBySpatialSelection,
    type SpatialSelection
} from '../spatial/selection';

export interface AppState {
    // Data
    allTransactions: HDBTransaction[];
    filteredTransactions: HDBTransaction[];
    selectedTransactions: HDBTransaction[] | null;
    spatialSelection: SpatialSelection;

    // UI State
    globalFilters: GlobalFilters;
    selectionMode: 'radial' | 'rect';
    isSelectionModeActive: boolean;
    /** `price` modes colour individual transactions; rental modes colour a block/type estimate. */
    colorMode: MapMetric;
    /** The flat type used to colour a rental map.  The filter can still contain several types. */
    rentalActiveFlatType: string | null;
    /** Persisted scenario inputs are intentionally kept separate from filters. */
    rentalScenario: Record<string, number | string>;
    colorScale: 'viridis' | 'turbo';

    // MOP Expiry Feature
    displayMopExpiries: boolean;
    mopExpiryDateRange: [string, string];
    mopProjectTypes: string[];
}

type StateKey = keyof AppState;
type StateListener<K extends StateKey> = (value: AppState[K]) => void;

export class StateStore {
    private state: AppState;
    private listeners: Map<StateKey, Set<StateListener<any>>> = new Map();

    constructor() {
        // Initialize with default state
        this.state = {
            allTransactions: [],
            filteredTransactions: [],
            selectedTransactions: null,
            spatialSelection: NO_SPATIAL_SELECTION,
            globalFilters: {
                date: '2024-01',
                flatTypes: ['2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'],
                leaseMin: 0,
                leaseMax: 99,
                floorMin: 1
            },
            selectionMode: 'radial',
            isSelectionModeActive: false,
            colorMode: 'price_psf',
            colorScale: 'viridis',
            rentalActiveFlatType: null,
            rentalScenario: {},

            // MOP Expiry Feature
            displayMopExpiries: false,
            // Default: 2 months back to 12 months future
            mopExpiryDateRange: [
                new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
            ],
            mopProjectTypes: ['Prime', 'Plus', 'Standard', 'Mature', 'Non-Mature', 'Unknown']
        };
    }

    /**
     * Get the current value of a state key
     */
    get<K extends StateKey>(key: K): AppState[K] {
        return this.state[key];
    }

    /**
     * Prepare related selection state before notifying any listeners.
     * Geometry and selected rows are coherent even inside filter listeners.
     */
    set<K extends StateKey>(key: K, value: AppState[K]): void {
        this.state[key] = value;
        if (key === 'globalFilters') {
            this.state.spatialSelection = NO_SPATIAL_SELECTION;
            this.refreshSelectedTransactions();
        } else if (key === 'spatialSelection' || key === 'filteredTransactions') {
            this.refreshSelectedTransactions();
        }
        this.notify(key);
        if (key === 'globalFilters') this.notify('spatialSelection');
        if (key === 'globalFilters' || key === 'spatialSelection' || key === 'filteredTransactions') {
            this.notify('selectedTransactions');
        }
    }

    setSpatialSelection(selection: SpatialSelection): void {
        this.set('spatialSelection', selection);
    }

    clearSpatialSelection(): void {
        this.setSpatialSelection(NO_SPATIAL_SELECTION);
    }

    private refreshSelectedTransactions(): void {
        this.state.selectedTransactions = filterBySpatialSelection(
            this.state.filteredTransactions,
            this.state.spatialSelection,
            (transaction) => ({ latitude: transaction.latitude, longitude: transaction.longitude })
        );
    }

    /**
     * Subscribe to changes for a specific state key
     * @returns Unsubscribe function
     */
    subscribe<K extends StateKey>(key: K, callback: StateListener<K>): () => void {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key)!.add(callback);

        // Return unsubscribe function
        return () => {
            const listeners = this.listeners.get(key);
            if (listeners) {
                listeners.delete(callback);
            }
        };
    }

    /**
     * Notify all listeners for a specific key
     */
    private notify<K extends StateKey>(key: K): void {
        const listeners = this.listeners.get(key);
        if (listeners) {
            const value = this.state[key];
            listeners.forEach(listener => listener(value));
        }
    }

    /**
     * Get the entire state (for debugging)
     */
    getAll(): AppState {
        return { ...this.state };
    }
}

// Export singleton instance
export const appState = new StateStore();
