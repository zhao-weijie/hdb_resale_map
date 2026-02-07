import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FairValueAnalysis } from './FairValueAnalysis';
import type { HDBTransaction } from '../data/DataLoader';

describe('FairValueAnalysis', () => {
    let fva: FairValueAnalysis;

    beforeAll(async () => {
        fva = new FairValueAnalysis();

        // Mock fetch for coefficients
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    intercept: 8.5,
                    features: {
                        storey_midpoint: 0.01,
                        remaining_lease_years: 0.005,
                        mrt_distance_km: -0.05,
                        floor_area_sqm: 0.008,
                        flat_type_encoded: 0.02
                    },
                    flat_type_mapping: {
                        '0': '2 ROOM',
                        '1': '3 ROOM',
                        '2': '4 ROOM',
                        '3': '5 ROOM',
                        '4': 'EXECUTIVE'
                    },
                    r_squared: 0.85,
                    latest_price_index: 180,
                    latest_quarter: '2024-Q2',
                    n_samples: 100000,
                    summary_stats: {
                        storey_midpoint: { mean: 8, std: 4 },
                        remaining_lease_years: { mean: 75, std: 15 },
                        mrt_distance_km: { mean: 0.5, std: 0.3 },
                        floor_area_sqm: { mean: 90, std: 20 }
                    }
                }),
            } as Response)
        );

        await fva.loadCoefficients();
    });

    it('loads coefficients successfully', () => {
        expect(fva.isReady()).toBe(true);
        expect(fva.getCoefficients()).toBeTruthy();
    });

    it('adjusts prices proportionally to price index', () => {
        const tx1 = { price_psf: 500, price_index: 100 } as HDBTransaction;
        const tx2 = { price_psf: 500, price_index: 150 } as HDBTransaction;

        const adj1 = fva.getAdjustedPricePsf(tx1);
        const adj2 = fva.getAdjustedPricePsf(tx2);

        // Same raw price but different index: older transaction (lower index) adjusts higher
        expect(adj1).toBeGreaterThan(adj2);

        // Verify the math: 500 * (180/100) = 900 vs 500 * (180/150) = 600
        expect(adj1).toBeCloseTo(900, 0);
        expect(adj2).toBeCloseTo(600, 0);
    });

    it('preserves relative ordering after adjustment', () => {
        const txLow = { price_psf: 400, price_index: 150 } as HDBTransaction;
        const txHigh = { price_psf: 600, price_index: 150 } as HDBTransaction;

        const adjLow = fva.getAdjustedPricePsf(txLow);
        const adjHigh = fva.getAdjustedPricePsf(txHigh);

        // Same index, different prices: ordering preserved
        expect(adjLow).toBeLessThan(adjHigh);
    });

    it('returns unadjusted price when coefficients not loaded', () => {
        const fvaEmpty = new FairValueAnalysis();
        const tx = { price_psf: 500, price_index: 100 } as HDBTransaction;

        expect(fvaEmpty.getAdjustedPricePsf(tx)).toBe(500);
    });

    it('calculates price distribution stats correctly', () => {
        const transactions: HDBTransaction[] = [
            { price_psf: 400, price_index: 150 } as HDBTransaction,
            { price_psf: 500, price_index: 150 } as HDBTransaction,
            { price_psf: 600, price_index: 150 } as HDBTransaction,
            { price_psf: 700, price_index: 150 } as HDBTransaction,
            { price_psf: 800, price_index: 150 } as HDBTransaction,
        ];

        const distribution = fva.getPriceDistribution(transactions);

        expect(distribution.min).toBeGreaterThan(0);
        expect(distribution.max).toBeGreaterThan(distribution.min);
        expect(distribution.median).toBeGreaterThan(distribution.min);
        expect(distribution.median).toBeLessThan(distribution.max);
        expect(distribution.mean).toBeGreaterThan(0);
        expect(distribution.q1).toBeLessThan(distribution.median);
        expect(distribution.q3).toBeGreaterThan(distribution.median);
    });
});
