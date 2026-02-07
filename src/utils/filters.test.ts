import { describe, it, expect } from 'vitest';
import { applyFilters, GlobalFilters } from './filters';
import type { HDBTransaction } from '../data/DataLoader';

// Helper to create mock transactions
const createMockTransaction = (overrides: Partial<HDBTransaction>): HDBTransaction => ({
    month: '2024-01',
    transaction_date: new Date('2024-01-15'),
    town: 'ANG MO KIO',
    flat_type: '4 ROOM',
    block: '123',
    street_name: 'ANG MO KIO AVE 1',
    storey_range: '07 TO 09',
    floor_area_sqm: 90,
    flat_model: 'Improved',
    lease_commence_date: 1990,
    remaining_lease_years: 75,
    resale_price: 500000,
    price_psm: 5555,
    price_psf: 516,
    latitude: 1.3521,
    longitude: 103.8198,
    storey_midpoint: 8,
    mrt_distance_m: 500,
    price_index: 150,
    ...overrides
});

const mockTransactions: HDBTransaction[] = [
    createMockTransaction({ flat_type: '4 ROOM', remaining_lease_years: 75, transaction_date: new Date('2024-01-15') }),
    createMockTransaction({ flat_type: '3 ROOM', remaining_lease_years: 60, transaction_date: new Date('2020-06-01') }),
    createMockTransaction({ flat_type: '5 ROOM', remaining_lease_years: 90, transaction_date: new Date('2024-06-01') }),
    createMockTransaction({ flat_type: 'EXECUTIVE', remaining_lease_years: 85, transaction_date: new Date('2023-01-01') }),
];

describe('applyFilters', () => {
    it('filters by flat type correctly', () => {
        const filters: GlobalFilters = {
            flatTypes: ['4 ROOM', '5 ROOM'],
            date: 'all',
            leaseMin: 0,
            leaseMax: 99
        };
        const result = applyFilters(mockTransactions, filters);
        expect(result.every(t => ['4 ROOM', '5 ROOM'].includes(t.flat_type))).toBe(true);
        expect(result.length).toBe(2);
    });

    it('filters by lease range correctly', () => {
        const filters: GlobalFilters = {
            flatTypes: ['2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'],
            date: 'all',
            leaseMin: 70,
            leaseMax: 99
        };
        const result = applyFilters(mockTransactions, filters);
        expect(result.every(t => t.remaining_lease_years >= 70)).toBe(true);
        expect(result.length).toBe(3); // 75, 90, 85 years remaining
    });

    it('returns empty array when no matches', () => {
        const filters: GlobalFilters = {
            flatTypes: ['MULTI-GENERATION'],
            date: 'all',
            leaseMin: 0,
            leaseMax: 99
        };
        const result = applyFilters(mockTransactions, filters);
        expect(result).toEqual([]);
    });

    it('combines multiple filters correctly', () => {
        const filters: GlobalFilters = {
            flatTypes: ['4 ROOM', '5 ROOM', 'EXECUTIVE'],
            date: 'all',
            leaseMin: 80,
            leaseMax: 99
        };
        const result = applyFilters(mockTransactions, filters);
        // Should only include 5 ROOM (90 years) and EXECUTIVE (85 years)
        expect(result.length).toBe(2);
        expect(result.every(t => t.remaining_lease_years >= 80)).toBe(true);
    });

    it('returns all transactions when filters are permissive', () => {
        const filters: GlobalFilters = {
            flatTypes: ['2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'],
            date: 'all',
            leaseMin: 0,
            leaseMax: 99
        };
        const result = applyFilters(mockTransactions, filters);
        expect(result.length).toBe(mockTransactions.length);
    });
});
