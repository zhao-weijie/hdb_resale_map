import { describe, it, expect } from 'vitest';
import { haversineDistance } from './geo';

describe('haversineDistance', () => {
    it('returns 0 for identical points', () => {
        const dist = haversineDistance(1.3521, 103.8198, 1.3521, 103.8198);
        expect(dist).toBe(0);
    });

    it('calculates correct distance for known Singapore points', () => {
        // Raffles Place MRT (~1.284, 103.851) to Tanjong Pagar MRT (~1.276, 103.845)
        // Expected distance ~800-900m
        const dist = haversineDistance(1.2840, 103.8515, 1.2764, 103.8465);
        expect(dist).toBeGreaterThan(750);
        expect(dist).toBeLessThan(1100);
    });

    it('calculates correct distance between opposite ends of Singapore', () => {
        // Jurong (~1.34, 103.70) to Changi (~1.36, 104.00)
        // Expected distance ~30km  
        const dist = haversineDistance(1.34, 103.70, 1.36, 104.00);
        expect(dist).toBeGreaterThan(25000);
        expect(dist).toBeLessThan(35000);
    });
});
