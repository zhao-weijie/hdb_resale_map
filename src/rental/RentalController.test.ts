import { describe, expect, it } from 'vitest';
import { rentalWindowFromStart, sanitizeScenario } from './RentalController';

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
