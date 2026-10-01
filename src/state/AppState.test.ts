import { describe, it, expect, beforeEach } from 'vitest';
import { StateStore } from './AppState';
import type { HDBTransaction } from '../data/DataLoader';
import { circleSelection, rectangleSelection } from '../spatial/selection';
import { MAP_METRIC_IDS } from '../metrics';

describe('StateStore', () => {
    let store: StateStore;

    beforeEach(() => {
        store = new StateStore();
    });

    it('initializes with default state', () => {
        expect(store.get('colorMode')).toBe('price_psf');
        expect(store.get('selectionMode')).toBe('radial');
        expect(store.get('selectedTransactions')).toBeNull();
        expect(store.get('spatialSelection')).toEqual({ kind: 'none' });
        expect(store.get('globalFilters')).toEqual({
            date: '2024-01',
            flatTypes: ['2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'],
            leaseMin: 0,
            leaseMax: 99,
            floorMin: 1
        });
    });

    it('sets and gets state values', () => {
        store.set('colorMode', 'price');
        expect(store.get('colorMode')).toBe('price');

        store.setSpatialSelection({ kind: 'circle', center: { latitude: 1.3, longitude: 103.8 }, radiusMeters: 1000 });
        expect(store.get('spatialSelection')).toEqual({
            kind: 'circle', center: { latitude: 1.3, longitude: 103.8 }, radiusMeters: 1000
        });
    });

    it('keeps rental map selection and scenario state independent of resale filters', () => {
        store.set('colorMode', 'gross_yield');
        store.set('rentalActiveFlatType', '4 ROOM');
        store.set('rentalScenario', { ltv: 0.75, initialRate: 0.03 });
        expect(store.get('colorMode')).toBe('gross_yield');
        expect(store.get('rentalActiveFlatType')).toBe('4 ROOM');
        expect(store.get('rentalScenario')).toEqual({ ltv: 0.75, initialRate: 0.03 });
        expect(store.get('globalFilters').date).toBe('2024-01');
    });

    it('notifies subscribers when state changes', () => {
        let callbackValue: string | null = null;
        let callCount = 0;

        store.subscribe('colorMode', (value) => {
            callbackValue = value;
            callCount++;
        });

        store.set('colorMode', 'price');
        expect(callbackValue).toBe('price');
        expect(callCount).toBe(1);

        store.set('colorMode', 'price_psf');
        expect(callbackValue).toBe('price_psf');
        expect(callCount).toBe(2);
    });

    it('allows multiple subscribers to the same key', () => {
        let callback1Value: string | null = null;
        let callback2Value: string | null = null;

        store.subscribe('colorScale', (value) => { callback1Value = value; });
        store.subscribe('colorScale', (value) => { callback2Value = value; });

        store.set('colorScale', 'turbo');

        expect(callback1Value).toBe('turbo');
        expect(callback2Value).toBe('turbo');
    });

    it('unsubscribes correctly', () => {
        let callCount = 0;

        const unsubscribe = store.subscribe('selectionMode', () => {
            callCount++;
        });

        store.set('selectionMode', 'rect');
        expect(callCount).toBe(1);

        unsubscribe();

        store.set('selectionMode', 'radial');
        expect(callCount).toBe(1); // Should not increment after unsubscribe
    });

    it('returns complete state with getAll', () => {
        const state = store.getAll();
        expect(state).toHaveProperty('colorMode');
        expect(state).toHaveProperty('globalFilters');
        expect(state).toHaveProperty('selectedTransactions');
        expect(state).toHaveProperty('spatialSelection');
    });

    it.each(['circle', 'rectangle'] as const)('publishes coherent %s creation, resize, empty selection and clear', (shape) => {
        const inside = { latitude: 1.3, longitude: 103.8 } as HDBTransaction;
        const nearby = { latitude: 1.305, longitude: 103.8 } as HDBTransaction;
        store.set('filteredTransactions', [inside, nearby]);
        const small = shape === 'circle' ? circleSelection(1.3, 103.8, 100)
            : rectangleSelection(1.299, 103.799, 1.301, 103.801);
        const large = shape === 'circle' ? circleSelection(1.3, 103.8, 1000)
            : rectangleSelection(1.29, 103.79, 1.31, 103.81);
        const empty = shape === 'circle' ? circleSelection(1.4, 103.9, 100)
            : rectangleSelection(1.39, 103.89, 1.41, 103.91);
        const observations: ReturnType<StateStore['getAll']>[] = [];
        store.subscribe('spatialSelection', (geometry) => {
            expect(store.get('spatialSelection')).toBe(geometry);
            observations.push(store.getAll());
        });
        store.subscribe('selectedTransactions', (rows) => {
            expect(store.get('selectedTransactions')).toBe(rows);
            observations.push(store.getAll());
        });
        // Both public setters must provide the same listener-visible contract.
        store.setSpatialSelection(small);
        store.set('spatialSelection', large);
        store.setSpatialSelection(empty);
        store.clearSpatialSelection();
        expect(observations.map(({ spatialSelection, selectedTransactions }) => ({ spatialSelection, selectedTransactions })))
            .toEqual([
                ...Array(2).fill({ spatialSelection: small, selectedTransactions: [inside] }),
                ...Array(2).fill({ spatialSelection: large, selectedTransactions: [inside, nearby] }),
                ...Array(2).fill({ spatialSelection: empty, selectedTransactions: [] }),
                ...Array(2).fill({ spatialSelection: { kind: 'none' }, selectedTransactions: null }),
            ]);
    });

    it.each(['circle', 'rectangle'] as const)('preserves %s geometry and rows during repeated comparison-mode changes', (shape) => {
        const selection = shape === 'circle' ? circleSelection(1.3, 103.8, 500)
            : rectangleSelection(1.29, 103.79, 1.31, 103.81);
        const inside = { latitude: 1.3, longitude: 103.8 } as HDBTransaction;
        store.set('filteredTransactions', [inside]);
        store.setSpatialSelection(selection);
        const selected = store.get('selectedTransactions');
        const assertPreserved = () => {
            expect(store.get('spatialSelection')).toBe(selection);
            expect(store.get('selectedTransactions')).toBe(selected);
        };
        store.subscribe('colorMode', assertPreserved);
        store.subscribe('rentalActiveFlatType', assertPreserved);
        store.subscribe('selectionMode', assertPreserved);
        store.subscribe('colorScale', assertPreserved);
        for (const mode of [...MAP_METRIC_IDS, ...MAP_METRIC_IDS].reverse()) {
            store.set('colorMode', mode);
            store.set('rentalActiveFlatType', '4 ROOM');
            store.set('rentalActiveFlatType', '5 ROOM');
            store.set('selectionMode', 'rect');
            store.set('selectionMode', 'radial');
            store.set('colorScale', 'turbo');
            store.set('colorScale', 'viridis');
        }
        assertPreserved();
    });

    it('clears geometry and rows before filter listeners and nested flat-type listeners run', () => {
        const inside = { latitude: 1.3, longitude: 103.8 } as HDBTransaction;
        store.set('filteredTransactions', [inside]);
        store.setSpatialSelection({ kind: 'circle', center: { latitude: 1.3, longitude: 103.8 }, radiusMeters: 500 });
        expect(store.get('selectedTransactions')).toEqual([inside]);
        const observations: ReturnType<StateStore['getAll']>[] = [];
        store.subscribe('globalFilters', () => {
            observations.push(store.getAll());
            // Matches the rental controller selecting a type inside a filter listener.
            store.set('rentalActiveFlatType', '5 ROOM');
        });
        for (const key of ['rentalActiveFlatType', 'spatialSelection', 'selectedTransactions'] as const) {
            store.subscribe(key, () => observations.push(store.getAll()));
        }
        store.set('globalFilters', { ...store.get('globalFilters'), floorMin: 5 });
        expect(observations).toHaveLength(4);
        for (const observed of observations) {
            expect(observed.globalFilters.floorMin).toBe(5);
            expect(observed.spatialSelection).toEqual({ kind: 'none' });
            expect(observed.selectedTransactions).toBeNull();
        }
    });

    it('rederives rows before publishing a replacement filtered population', () => {
        const previous = { latitude: 1.3, longitude: 103.8 } as HDBTransaction;
        const replacement = { latitude: 1.3001, longitude: 103.8 } as HDBTransaction;
        store.set('filteredTransactions', [previous]);
        const selection = circleSelection(1.3, 103.8, 500);
        store.setSpatialSelection(selection);
        const observations: ReturnType<StateStore['getAll']>[] = [];
        store.subscribe('filteredTransactions', () => observations.push(store.getAll()));
        store.subscribe('selectedTransactions', () => observations.push(store.getAll()));
        store.set('filteredTransactions', [replacement]);
        expect(observations).toHaveLength(2);
        for (const observed of observations) {
            expect(observed.filteredTransactions).toEqual([replacement]);
            expect(observed.selectedTransactions).toEqual([replacement]);
            expect(observed.spatialSelection).toBe(selection);
        }
    });
});
