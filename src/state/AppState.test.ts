import { describe, it, expect, beforeEach } from 'vitest';
import { StateStore } from './AppState';

describe('StateStore', () => {
    let store: StateStore;

    beforeEach(() => {
        store = new StateStore();
    });

    it('initializes with default state', () => {
        expect(store.get('colorMode')).toBe('price_psf');
        expect(store.get('selectionMode')).toBe('radial');
        expect(store.get('activeTab')).toBe('overview');
        expect(store.get('selectedTransactions')).toBeNull();
        expect(store.get('globalFilters')).toEqual({
            date: 'all',
            flatTypes: ['2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'],
            leaseMin: 0,
            leaseMax: 99
        });
    });

    it('sets and gets state values', () => {
        store.set('colorMode', 'price');
        expect(store.get('colorMode')).toBe('price');

        store.set('selectionRadius', 1000);
        expect(store.get('selectionRadius')).toBe(1000);
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

        store.subscribe('activeTab', (value) => { callback1Value = value; });
        store.subscribe('activeTab', (value) => { callback2Value = value; });

        store.set('activeTab', 'fairvalue');

        expect(callback1Value).toBe('fairvalue');
        expect(callback2Value).toBe('fairvalue');
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
    });
});
