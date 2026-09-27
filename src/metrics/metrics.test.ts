import { describe, expect, it } from 'vitest';
import {
    MAP_METRIC_IDS,
    METRIC_REGISTRY,
    calculateMetricDomain,
    createScalePresentation,
    metricValue,
    scaleScalar,
    summarizeNumbers,
} from './index';

describe('metric registry', () => {
    it('defines an accessor, formatter, palette, and domain policy for every metric', () => {
        expect(Object.keys(METRIC_REGISTRY)).toEqual([...MAP_METRIC_IDS]);

        const datum = {
            resale_price: 500_000,
            price_psf: 500,
            rent: 3_000,
            rentPsf: 3.25,
            grossYield: 4.2,
            monthlySurplus: -250,
        };
        expect(MAP_METRIC_IDS.map((metric) => metricValue(metric, datum))).toEqual([
            500_000, 500, 3_000, 3.25, 4.2, -250,
        ]);
        for (const metric of MAP_METRIC_IDS) {
            const definition = METRIC_REGISTRY[metric];
            expect(definition.formatter(metricValue(metric, datum)!)).toBeTruthy();
            expect(definition.palette).toBe(metric === 'monthly_surplus' ? 'diverging' : 'sequential');
        }
    });

    it('rejects non-finite accessor values', () => {
        expect(metricValue('rent', { rent: Number.NaN })).toBeNull();
        expect(metricValue('price', { resale_price: Number.POSITIVE_INFINITY })).toBeNull();
    });
});

describe('numeric summaries', () => {
    it('calculates median, quartiles, and IQR without mutating the input', () => {
        const values = [40, 10, 30, 20];
        expect(summarizeNumbers(values)).toEqual({
            count: 4,
            min: 10,
            q1: 17.5,
            median: 25,
            q3: 32.5,
            max: 40,
            iqr: 15,
        });
        expect(values).toEqual([40, 10, 30, 20]);
    });

    it('ignores non-finite values and returns null when no usable values remain', () => {
        expect(summarizeNumbers([1, null, Number.NaN, Number.POSITIVE_INFINITY, 3])?.count).toBe(2);
        expect(summarizeNumbers([null, undefined, Number.NaN])).toBeNull();
    });
});

describe('metric domains', () => {
    it.each(MAP_METRIC_IDS.filter((metric) => metric !== 'monthly_surplus'))(
        'uses the robust 5th–95th percentile policy for %s',
        (metric) => {
            const values = Array.from({ length: 101 }, (_, index) => index);
            const domain = calculateMetricDomain(metric, values)!;
            expect(domain.min).toBe(5);
            expect(domain.max).toBe(95);
            expect(domain.lowClipped).toBe(true);
            expect(domain.highClipped).toBe(true);
        },
    );

    it('uses the 95th percentile of absolute surplus and remains zero-centred', () => {
        const values = Array.from({ length: 101 }, (_, index) => index - 50);
        const domain = calculateMetricDomain('monthly_surplus', values)!;
        expect(domain.min).toBe(-48);
        expect(domain.max).toBe(48);
        expect(domain.lowClipped).toBe(true);
        expect(domain.highClipped).toBe(true);
    });

    it('gives constant and all-zero inputs a finite non-zero domain', () => {
        expect(calculateMetricDomain('rent', [3_000, 3_000])).toMatchObject({
            min: 2_999,
            max: 3_001,
            constant: true,
        });
        expect(calculateMetricDomain('monthly_surplus', [0, 0])).toMatchObject({
            min: -1,
            max: 1,
            constant: true,
        });
    });

    it('returns null for empty and wholly non-finite inputs', () => {
        expect(calculateMetricDomain('price', [])).toBeNull();
        expect(calculateMetricDomain('price', [Number.NaN, Number.NEGATIVE_INFINITY])).toBeNull();
    });
});

describe('scale presentation', () => {
    it('keeps the global domain unchanged when selected values change', () => {
        const all = Array.from({ length: 101 }, (_, index) => index);
        const first = createScalePresentation('price', all, [10, 20]);
        const second = createScalePresentation('price', all, [90, 100, 1_000_000]);
        expect(first.domain).toEqual(second.domain);
        expect(first.selected?.summary?.count).toBe(2);
        expect(second.selected?.summary?.count).toBe(3);
    });

    it('distinguishes no selection from an active empty selection', () => {
        expect(createScalePresentation('rent', [1, 2]).selected).toBeNull();
        expect(createScalePresentation('rent', [1, 2], []).selected).toEqual({ summary: null });
    });

    it('clips scalars to the global domain and rejects unusable inputs', () => {
        const domain = calculateMetricDomain('price', Array.from({ length: 101 }, (_, index) => index));
        expect(scaleScalar(-1, domain)).toBe(0);
        expect(scaleScalar(50, domain)).toBe(0.5);
        expect(scaleScalar(1_000, domain)).toBe(1);
        expect(scaleScalar(Number.NaN, domain)).toBeNull();
        expect(scaleScalar(1, null)).toBeNull();
    });
});
