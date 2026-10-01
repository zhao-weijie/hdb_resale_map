import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalController, buildRentalScalePresentation, rentalWindowFromStart, sanitizeScenario, scenarioFormMarkup } from './RentalController';
import { circleSelection } from '../spatial/selection';
import { appState } from '../state/AppState';
import type { HDBTransaction } from '../data/DataLoader';
import type { RentalMapPoint } from '../map/MapView';
import { createRentalEstimationContext, estimateRentForTarget } from './model';

describe('resale history in rental details', () => {
    const originalFilters = appState.get('globalFilters');
    afterEach(() => {
        appState.set('globalFilters', originalFilters);
        vi.unstubAllGlobals();
    });

    it('widens and narrows the displayed history independently of the rental window', () => {
        const target = { block: '123', streetName: 'TEST ROAD', flatType: '4 ROOM' };
        const transaction = (month: string, overrides: Partial<HDBTransaction> = {}): HDBTransaction => ({
            month, transaction_date: new Date(`${month}-15`), block: target.block, street_name: target.streetName,
            flat_type: '4 ROOM', town: 'TOWN', storey_range: '07 TO 09', floor_area_sqm: 90,
            flat_model: 'Improved', lease_commence_date: 1990, remaining_lease_years: 70,
            resale_price: 500000, price_psm: 5555, price_psf: 516, latitude: 1.3, longitude: 103.8,
            mrt_distance_m: 500, ...overrides,
        });
        const records = [transaction('2023-02'), transaction('2025-06'), transaction('2026-09'),
            transaction('2024-03', { flat_type: '5 ROOM' }),
            transaction('2024-04', { storey_range: '01 TO 03' }),
            transaction('2024-05', { remaining_lease_years: 30 })];
        const context = createRentalEstimationContext({ rentalRecords: [], resaleComparables: records,
            analysisWindow: { minMonth: '2025-01', maxMonth: '2026-08' } });
        const estimate = estimateRentForTarget(context, target);
        const point: RentalMapPoint = { ...target, latitude: 1.3, longitude: 103.8,
            rent: null, rentPsf: null, grossYield: null, monthlySurplus: null };
        const tableHost = { innerHTML: '', querySelector: () => null };
        const body = { innerHTML: '', addEventListener: () => {} };
        const modal = { querySelector: (selector: string) => selector === '.rental-resale-table' ? tableHost : body };
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { createElement: () => ({ textContent: '', get innerHTML() { return this.textContent; } }) });
        const getTransactionsForBlock = vi.fn(() => records);
        // Exercise the actual detail renderer with only its DOM shell stubbed.
        const controller = Object.assign(Object.create(RentalController.prototype), {
            dataLoader: { getTransactionsForBlock }, rows: [{ point, target, estimate, scenario: null }],
            estimationContext: context, overrides: new Map(), modal: () => modal, bindObservationTooltips: () => {},
        }) as { openDetails(point: RentalMapPoint): void };
        const filters = { date: '2025-01', flatTypes: ['4 ROOM'], leaseMin: 60, leaseMax: 99, floorMin: 7 };
        appState.set('globalFilters', filters);
        controller.openDetails(point);
        expect(tableHost.innerHTML).not.toContain('Feb 23');
        expect(tableHost.innerHTML).toContain('Sept 26');

        appState.set('globalFilters', { ...filters, date: '2023-01' });
        controller.openDetails(point);
        expect(getTransactionsForBlock).toHaveBeenCalledWith('123', 'TEST ROAD');
        expect(tableHost.innerHTML).toContain('Feb 23');
        expect(tableHost.innerHTML).toContain('Jun 25');
        expect(tableHost.innerHTML).toContain('Sept 26');
        expect(tableHost.innerHTML).not.toContain('Mar 24');
        expect(tableHost.innerHTML).not.toContain('Apr 24');
        expect(tableHost.innerHTML).not.toContain('May 24');
        expect(tableHost.innerHTML.indexOf('Sept 26')).toBeLessThan(tableHost.innerHTML.indexOf('Feb 23'));
        expect(context.analysisWindow).toEqual({ minMonth: '2025-01', maxMonth: '2026-08' });
        expect(estimate.resale.records).toHaveLength(1);

        appState.set('globalFilters', filters);
        controller.openDetails(point);
        expect(tableHost.innerHTML).not.toContain('Feb 23');
    });
});

describe('rental evidence month UI', () => {
    it('uses one start month through the latest month shared by both datasets', () => {
        expect(rentalWindowFromStart('2025-01', '2021-01', '2026-08', '2026-09')).toEqual({ minMonth: '2025-01', maxMonth: '2026-08' });
        expect(rentalWindowFromStart('2025-01', '2021-01', '2026-10', '2026-08')).toEqual({ minMonth: '2025-01', maxMonth: '2026-08' });
    });

    it('rejects invalid or unavailable start months', () => {
        expect(rentalWindowFromStart('2020-12', '2021-01', '2026-08', '2026-08')).toBeNull();
        expect(rentalWindowFromStart('2026-09', '2021-01', '2026-08', '2026-08')).toBeNull();
        expect(rentalWindowFromStart('not-a-month', '2021-01', '2026-08', '2026-08')).toBeNull();
    });
});

describe('rental scenario UI validation', () => {
    it('anchors date and month picker hit targets to their own inputs', () => {
        const stylesheet = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
        expect(stylesheet).toMatch(/input\[type="date"\],\s*input\[type="month"\]\s*\{\s*position:\s*relative;/);
    });

    it('renders its inputs inside the scenario form', () => {
        const markup = scenarioFormMarkup({ purchaseDate: '2026-09-25' });
        expect(markup).toContain('<form class="rental-scenario-form">');
        expect(markup).toMatch(/<button>Apply scenario<\/button><\/form>$/);
    });

    it('keeps only model-valid, serializable assumptions', () => {
        expect(sanitizeScenario({
            purchaseDate: '2026-09-25', ltv: .75, mortgageYears: 25,
            initialRate: .03, rentalRate: .03, annualRentGrowth: -.02, operatingReserve: .1,
            ignored: '<img src=x>',
        })).toEqual({
            purchaseDate: '2026-09-25', ltv: .75, mortgageYears: 25,
            initialRate: .03, rentalRate: .03, annualRentGrowth: -.02, operatingReserve: .1,
        });
    });

    it('rejects invalid calendar dates and values the model would clamp', () => {
        expect(sanitizeScenario({ purchaseDate: '2025-02-30', ltv: 2, annualRentGrowth: 1.5 })).toEqual({});
    });
});

describe('rental scale presentation', () => {
    const points = [
        { block: '1', streetName: 'A', flatType: '4 ROOM', latitude: 1.3, longitude: 103.8,
            rent: 2_000, rentPsf: null, grossYield: null, monthlySurplus: null },
        { block: '2', streetName: 'B', flatType: '4 ROOM', latitude: 1.301, longitude: 103.8,
            rent: 4_000, rentPsf: null, grossYield: null, monthlySurplus: null },
        { block: '3', streetName: 'C', flatType: '5 ROOM', latitude: 1.3, longitude: 103.8,
            rent: 9_000, rentPsf: null, grossYield: null, monthlySurplus: null },
    ];

    it('keeps the global domain while selection changes only selected statistics', () => {
        const none = buildRentalScalePresentation('rent', points, '4 ROOM', { kind: 'none' });
        const selected = buildRentalScalePresentation('rent', points, '4 ROOM', circleSelection(1.3, 103.8, 20));
        expect(selected.domain).toEqual(none.domain);
        expect(selected.all.summary?.count).toBe(2);
        expect(selected.selected?.summary?.count).toBe(1);
        expect(selected.selected?.summary?.median).toBe(2_000);
    });

    it('represents an active empty selection and unsupported values as no data', () => {
        const selected = buildRentalScalePresentation('rent_psf', points, '4 ROOM', circleSelection(1.4, 103.9, 10));
        expect(selected.domain).toBeNull();
        expect(selected.selected).toEqual({ summary: null });
    });
});
