import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRentalScalePresentation, rentalWindowFromStart, sanitizeScenario, scenarioFormMarkup } from './RentalController';
import { circleSelection } from '../spatial/selection';

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
