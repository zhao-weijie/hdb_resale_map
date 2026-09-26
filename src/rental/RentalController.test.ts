import { describe, expect, it } from 'vitest';
import { sanitizeScenario } from './RentalController';

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
