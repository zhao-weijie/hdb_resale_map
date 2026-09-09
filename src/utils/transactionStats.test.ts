import { describe, expect, it } from 'vitest';
import type { HDBTransaction } from '../data/DataLoader';
import { getTransactionStats } from './transactionStats';

const transactions = (prices: number[], psf = prices): HDBTransaction[] =>
    prices.map((price, index) => ({
        resale_price: price,
        price_psf: psf[index],
    } as HDBTransaction));

describe('getTransactionStats', () => {
    it('returns null for empty transaction arrays', () => {
        expect(getTransactionStats([], 'price')).toBeNull();
    });

    it('computes odd-sized population statistics', () => {
        expect(getTransactionStats(transactions([10, 30, 20]), 'price')).toEqual({
            min: 10,
            max: 30,
            median: 20,
            mean: 20,
            std: Math.sqrt(200 / 3),
        });
    });

    it('uses the conventional average of the two middle values for even medians', () => {
        expect(getTransactionStats(transactions([4, 1, 3, 2]), 'price')?.median).toBe(2.5);
    });

    it('caches each metric per array reference and keeps distinct arrays independent', () => {
        const first = transactions([100, 200], [10, 20]);
        const second = transactions([300, 500], [30, 50]);
        const firstPrice = getTransactionStats(first, 'price');

        expect(getTransactionStats(first, 'price')).toBe(firstPrice);
        expect(getTransactionStats(first, 'price_psf')?.mean).toBe(15);
        expect(getTransactionStats(second, 'price')?.mean).toBe(400);
        expect(getTransactionStats(second, 'price')).not.toBe(firstPrice);
    });
});
