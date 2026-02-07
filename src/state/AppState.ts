/**
 * Central application state management with pub/sub pattern
 * No external dependencies - lightweight observable store
 */

import type { HDBTransaction } from '../data/DataLoader';
import type { GlobalFilters } from '../utils/filters';

export interface AppState {
    // Data
    allTransactions: HDBTransaction[];
    filteredTransactions: HDBTransaction[];
    selectedTransactions: HDBTransaction[] | null;

    // UI State
    globalFilters: GlobalFilters;
    selectionMode: 'radial' | 'rect';
    isSelectionModeActive: boolean;
    activeTab: 'overview' | 'fairvalue';
    colorMode: 'price' | 'price_psf';

    // Selection geometry
    selectionCenter: { lat: number; lng: number } | null;
    selectionRadius: number;
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
            globalFilters: {
                date: 'all',
                flatTypes: ['2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'],
                leaseMin: 0,
                leaseMax: 99
            },
            selectionMode: 'radial',
            isSelectionModeActive: false,
            activeTab: 'overview',
            colorMode: 'price_psf',
            selectionCenter: null,
            selectionRadius: 500,
        };
    }

    /**
     * Get the current value of a state key
     */
    get<K extends StateKey>(key: K): AppState[K] {
        return this.state[key];
    }

    /**
     * Set a new value for a state key and notify listeners
     */
    set<K extends StateKey>(key: K, value: AppState[K]): void {
        this.state[key] = value;
        this.notify(key);
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
