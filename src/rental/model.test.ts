import { describe, expect, it } from 'vitest';
import {
    calculateBSD, calculateMortgageDuty, calculateNonOwnerPropertyTax, calculateScenario,
    estimateRent, filterRentalRecords, getMapRentalMetric, getPaletteDomain, resolveRentalEligibility,
    getSharedRentalAnalysisWindow, normalizeAddressPart, normalizeFlatType, paletteScalar,
    singaporeToday,
} from './model';
import type { BlockTypeTarget, RentalRecord, ResaleComparable } from './types';

const target: BlockTypeTarget = {
    block: '123A', streetName: 'Example Road', flatType: '4 ROOM', town: 'Town',
    latitude: 1.3, longitude: 103.8, leaseCommencement: 2000, nearestMrtExitMeters: 280,
};

const resale = (overrides: Partial<ResaleComparable> = {}): ResaleComparable => ({
    month: '2026-08', town: 'Town', block: '123A', street_name: 'EXAMPLE ROAD', flat_type: '4 ROOM',
    resale_price: 600_000, floor_area_sqm: 100, lease_commence_date: 2000,
    remaining_lease_years: 73, storey_range: '04 TO 06', latitude: 1.3, longitude: 103.8, mrt_distance_m: 280,
    ...overrides,
});

const rent = (overrides: Partial<RentalRecord> = {}): RentalRecord => ({
    month: '2026-08', town: 'Town', block: '123A', street_name: 'Example Road', flat_type: '4 ROOM', monthly_rent: 3_000,
    ...overrides,
});

describe('rental evidence estimation', () => {
    it('matches official full street names to abbreviated transaction addresses for restrictions', () => {
        const eligibility = resolveRentalEligibility({ block: '36A', streetName: 'KELANTAN RD', flatType: '4 ROOM' }, [{
            block: '36A', street_name: 'KELANTAN ROAD', category: 'plh', wholeFlatRental: 'prohibited',
            sourceUrl: 'https://www.hdb.gov.sg/', reviewedAt: '2026-09-25',
        }]);
        expect(eligibility.eligibility).toBe('prohibited');
    });
    it('normalizes address and flat-type joins and keeps equal observations', () => {
        expect(normalizeAddressPart('  123a,  Example   Road ')).toBe('123A EXAMPLE ROAD');
        expect(normalizeFlatType('4 rooms')).toBe('4 ROOM');
        expect(normalizeFlatType('4-ROOM')).toBe('4 ROOM');
        expect(normalizeFlatType('multi-generation')).toBe('MULTI GENERATION');
        const records = Array.from({ length: 5 }, () => rent());
        const result = estimateRent({ target, rentalRecords: records, resaleComparables: [resale(), resale(), resale()] });
        expect(result.source).toBe('same_block');
        expect(result.monthlyRent).toBe(3_000);
        expect(result.direct.summary?.count).toBe(5);
        expect(result.rentPsf).toBeCloseTo(3_000 / (100 * 10.7639104167));
    });

    it('uses January of the prior year through the latest month shared by datasets', () => {
        expect(getSharedRentalAnalysisWindow(
            [rent({ month: '2026-11' })], [resale({ month: '2026-08' })],
        )).toEqual({ minMonth: '2025-01', maxMonth: '2026-08' });
    });

    it('uses only resale prices and areas inside the selected rental analysis window', () => {
        const result = estimateRent({
            target, analysisWindow: { minMonth: '2025-01', maxMonth: '2026-08' },
            rentalRecords: Array.from({ length: 5 }, () => rent()),
            resaleComparables: [resale(), resale(), resale(), ...Array.from({ length: 10 }, () =>
                resale({ month: '2024-12', resale_price: 300_000, floor_area_sqm: 60 })),
                resale({ month: '2026-09', resale_price: 900_000 })],
        });
        expect(result.resale.summary?.count).toBe(3);
        expect(result.resale.summary?.median).toBe(600_000);
        expect(result.resale.areaSummary?.median).toBe(100);
    });

    it('removes only town/type 3-IQR outliers when there are at least 20 observations', () => {
        const records = [
            ...Array.from({ length: 20 }, () => rent({ monthly_rent: 3_000 })),
            rent({ monthly_rent: 30_000 }),
        ];
        const filtered = filterRentalRecords(records, { minMonth: '2026-01', maxMonth: '2026-12' });
        expect(filtered).toHaveLength(20);
        expect(filtered.every((record) => record.monthly_rent === 3_000)).toBe(true);
    });

    it('retains thin direct evidence but falls back only to nearby samples from three blocks', () => {
        const direct = [rent({ monthly_rent: 2_900 }), rent({ monthly_rent: 3_100 })];
        const nearbyBlocks = ['124', '125', '126'];
        const nearby = nearbyBlocks.flatMap((block, index) => Array.from({ length: 4 }, () => rent({
            block, street_name: 'Example Road', monthly_rent: 3_100 + index * 100,
        })));
        const comparables = [
            resale(),
            ...nearbyBlocks.map((block, index) => resale({ block, latitude: 1.3005 + index * 0.0001, longitude: 103.8, lease_commence_date: 2004 })),
        ];
        const result = estimateRent({ target, rentalRecords: [...direct, ...nearby], resaleComparables: comparables });
        expect(result.source).toBe('nearby_blocks');
        expect(result.direct.summary?.count).toBe(2);
        expect(result.nearby?.summary?.count).toBe(12);
        expect(result.nearby?.blockCount).toBe(3);
        expect(result.monthlyRent).toBe(3_200);
    });

    it('does not produce an estimate when fallback evidence is too thin and reports invalid rents', () => {
        const result = estimateRent({
            target,
            rentalRecords: [rent({ monthly_rent: 0 }), rent({ monthly_rent: Number.NaN }), rent({ monthly_rent: 3_000 })],
            resaleComparables: [resale(), resale({ resale_price: 610_000 }), resale({ resale_price: 620_000 })],
        });
        expect(result.source).toBe('unavailable');
        expect(result.direct.rawCount).toBe(3);
        expect(result.direct.excludedInvalid).toBe(2);
    });

    it('can locate current nearby rentals using older resale metadata without including old purchase prices', () => {
        const nearbyBlocks = ['124', '125', '126'];
        const result = estimateRent({
            target, analysisWindow: { minMonth: '2025-01', maxMonth: '2026-08' },
            rentalRecords: nearbyBlocks.flatMap((block) => Array.from({ length: 4 }, () => rent({ block }))),
            resaleComparables: [resale(), resale(), resale(),
                resale({ month: '2024-01', resale_price: 100_000 }),
                ...nearbyBlocks.map((block, i) => resale({ block, month: '2024-01', latitude: 1.3005 + i * 0.0001 }))],
        });
        expect(result.source).toBe('nearby_blocks');
        expect(result.nearby?.summary?.count).toBe(12);
        expect(result.nearby?.blockCount).toBe(3);
        expect(result.resale.summary?.count).toBe(3);
        expect(result.resale.summary?.median).toBe(600_000);
    });

    it('applies floor and lease filtering only to resale comparables, and needs three for map price', () => {
        const result = estimateRent({
            target,
            rentalRecords: Array.from({ length: 5 }, () => rent()),
            resaleComparables: [resale(), resale({ storey_range: '01 TO 03' }), resale({ remaining_lease_years: 50 })],
            resaleFilters: { floorMin: 4, leaseMin: 70 },
        });
        expect(result.resale.summary?.count).toBe(1);
        expect(result.resale.qualifiedForMap).toBe(false);
        expect(result.monthlyRent).toBe(3_000);
    });

    it('suppresses projections for source-backed Plus/Prime/PLH and marks missing classifications provisional', () => {
        const base = { target, rentalRecords: Array.from({ length: 5 }, () => rent()), resaleComparables: [resale(), resale(), resale()] };
        expect(estimateRent({ ...base, classifications: [{
            block: '123A', street_name: 'Example Road', category: 'plus', wholeFlatRental: 'allowed',
            sourceUrl: 'https://example.test', reviewedAt: '2026-09-01',
        }] }).eligibility).toBe('prohibited');
        const unknown = estimateRent(base);
        expect(unknown.eligibility).toBe('unknown');
        expect(unknown.provisional).toBe(true);
    });
});

describe('scenario finance model', () => {
    it('uses the Singapore purchase date before midnight UTC', () => {
        expect(singaporeToday(new Date('2026-09-30T17:00:00Z'))).toBe('2026-10-01');
        expect(singaporeToday(new Date('2026-09-30T15:59:00Z'))).toBe('2026-09-30');
    });
    it('calculates BSD, mortgage duty, and progressive non-owner property tax', () => {
        expect(calculateBSD(1_000_000)).toBe(24_600);
        expect(calculateBSD(497_944)).toBe(9_538);
        expect(calculateBSD(1)).toBe(1);
        expect(calculateBSD(0)).toBe(0);
        expect(calculateBSD(3_000_100)).toBe(119_606);
        expect(calculateScenario({ purchasePrice: 600_000, marketValue: 650_000, currentMonthlyRent: 3_000 }).bsd).toBe(14_100);
        expect(calculateMortgageDuty(100)).toBe(1);
        expect(calculateMortgageDuty(200_000)).toBe(500);
        expect(calculateNonOwnerPropertyTax(30_000)).toBe(3_600);
        expect(calculateNonOwnerPropertyTax(45_000)).toBe(6_600);
        expect(calculateNonOwnerPropertyTax(60_000)).toBe(10_800);
        expect(calculateNonOwnerPropertyTax(70_000)).toBe(14_400);
    });

    it('amortizes for 60 months then reprices the remaining 20 years', () => {
        const scenario = calculateScenario({
            purchasePrice: 1_000_000, currentMonthlyRent: 3_000, evidenceAsOf: '2025-01',
            assumptions: { purchaseDate: '2025-01-01', rentalRate: 0.06 },
        });
        expect(scenario.loanAmount).toBe(750_000);
        expect(scenario.remainingMortgageMonths).toBe(240);
        expect(scenario.balanceAtRentalStart).toBeLessThan(750_000);
        expect(scenario.rentalMonthlyPayment).toBeGreaterThan(scenario.initialMonthlyPayment);
        expect(scenario.rentProjectionMonths).toBe(60);
        expect(scenario.upfrontCapital).toBe(275_100);
        expect(scenario.annualValue).toBe(36_000);
        expect(scenario.propertyMonthlySurplus).toBeCloseTo(
            scenario.projectedMonthlyRent - scenario.projectedMonthlyRent * 0.1 - scenario.rentalMonthlyPayment - scenario.annualPropertyTax / 12,
        );
        expect(scenario.firstRentalYearPrincipal).toBeGreaterThan(0);
    });

    it('handles zero-rate and zero-loan scenarios without NaN values', () => {
        const scenario = calculateScenario({
            purchasePrice: 500_000, currentMonthlyRent: 2_000,
            assumptions: { ltv: 0, initialRate: 0, rentalRate: 0, mortgageYears: 0 },
        });
        expect(scenario.loanAmount).toBe(0);
        expect(scenario.initialMonthlyPayment).toBe(0);
        expect(Object.values(scenario).every((value) => typeof value !== 'number' || Number.isFinite(value))).toBe(true);
    });

    it('keeps the five-year rental start when the mortgage ends earlier or there is no loan', () => {
        for (const mortgageYears of [0, 3]) {
            const scenario = calculateScenario({
                purchasePrice: 600_000, currentMonthlyRent: 3_000, evidenceAsOf: '2026-09',
                assumptions: { purchaseDate: '2026-09-25', mortgageYears, ltv: mortgageYears ? 0.75 : 0, annualRentGrowth: 0.02 },
            });
            expect(scenario.rentalStartDate).toBe('2031-09-25');
            expect(scenario.rentProjectionMonths).toBe(60);
            expect(scenario.projectedMonthlyRent).toBeCloseTo(3_000 * 1.02 ** 5);
            expect(scenario.balanceAtRentalStart).toBe(0);
            expect(scenario.rentalMonthlyPayment).toBe(0);
        }
    });

    it('rejects impossible purchase dates and clamps leap-day anniversaries', () => {
        const input = { purchasePrice: 600_000, currentMonthlyRent: 3_000 };
        const invalid = calculateScenario({ ...input, assumptions: { purchaseDate: '2025-02-30' } });
        expect(invalid.assumptions.purchaseDate).not.toBe('2025-02-30');
        expect(calculateScenario({ ...input, assumptions: { purchaseDate: '2024-02-29' } }).rentalStartDate).toBe('2029-02-28');
    });

    it('does not treat a positive loan with a zero term as free financing', () => {
        const scenario = calculateScenario({ purchasePrice: 600_000, currentMonthlyRent: 3_000, assumptions: { mortgageYears: 0 } });
        expect(scenario.assumptions.mortgageYears).toBe(25);
        expect(scenario.rentalMonthlyPayment).toBeGreaterThan(0);
    });

    it('matches the default post-MOP cash-flow fixture and keeps principal separate', () => {
        const scenario = calculateScenario({
            purchasePrice: 600_000, currentMonthlyRent: 3_000,
            assumptions: { purchaseDate: '2025-01-01' },
        });
        expect(scenario.initialMonthlyPayment).toBeCloseTo(2_133.95091236, 6);
        expect(scenario.balanceAtRentalStart).toBeCloseTo(384_774.640319, 6);
        expect(scenario.annualPropertyTax).toBe(4_800);
        expect(scenario.propertyMonthlySurplus).toBeCloseTo(166.049088, 6);
        expect(scenario.upfrontCapital).toBe(163_100);
        expect(scenario.firstRentalYearPrincipal).toBeCloseTo(14_259.174721, 6);
        expect(scenario.propertyMonthlySurplus).not.toBeCloseTo(scenario.propertyMonthlySurplus + scenario.firstRentalYearPrincipal / 12);
    });

    it('exposes stable palette scalars and UI map metric aliases', () => {
        const domain = getPaletteDomain([0, 10, 20, 30, 1_000]);
        expect(domain?.min).toBeGreaterThanOrEqual(0);
        expect(paletteScalar(-1, domain)).toBe(0);
        expect(paletteScalar(1_000, domain)).toBe(1);
        const estimate = estimateRent({ target, rentalRecords: Array.from({ length: 5 }, () => rent()), resaleComparables: [resale(), resale(), resale()] });
        expect(getMapRentalMetric('rent', estimate).value).toBe(3_000);
    });
});
