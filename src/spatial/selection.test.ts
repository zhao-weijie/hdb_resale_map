import { describe, expect, it } from 'vitest';
import {
    NO_SPATIAL_SELECTION,
    circleSelection,
    containsCoordinate,
    filterBySpatialSelection,
    haversineDistanceMeters,
    isValidCoordinate,
    rectangleSelection
} from './selection';

describe('spatial selection', () => {
    it('validates coordinate ranges and finite values', () => {
        expect(isValidCoordinate({ latitude: 1.3, longitude: 103.8 })).toBe(true);
        expect(isValidCoordinate({ latitude: 91, longitude: 103.8 })).toBe(false);
        expect(isValidCoordinate({ latitude: 1.3, longitude: Number.NaN })).toBe(false);
    });

    it('includes a circle boundary and excludes points beyond it', () => {
        const center = { latitude: 1.3, longitude: 103.8 };
        const boundary = { latitude: 1.3, longitude: 103.81 };
        const radiusMeters = haversineDistanceMeters(center, boundary);
        const selection = circleSelection(center.latitude, center.longitude, radiusMeters);
        expect(containsCoordinate(selection, boundary)).toBe(true);
        expect(containsCoordinate(selection, { latitude: 1.3, longitude: 103.811 })).toBe(false);
    });

    it('normalizes rectangle corners and includes every boundary', () => {
        const selection = rectangleSelection(1.4, 103.9, 1.2, 103.7);
        expect(selection).toEqual({ kind: 'rectangle', south: 1.2, west: 103.7, north: 1.4, east: 103.9 });
        expect(containsCoordinate(selection, { latitude: 1.2, longitude: 103.7 })).toBe(true);
        expect(containsCoordinate(selection, { latitude: 1.4, longitude: 103.9 })).toBe(true);
        expect(containsCoordinate(selection, { latitude: 1.401, longitude: 103.8 })).toBe(false);
    });

    it('rejects invalid shapes and coordinates', () => {
        expect(circleSelection(95, 103.8, 500)).toEqual(NO_SPATIAL_SELECTION);
        expect(circleSelection(1.3, 103.8, -1)).toEqual(NO_SPATIAL_SELECTION);
        expect(rectangleSelection(1.3, 103.8, Number.NaN, 103.9)).toEqual(NO_SPATIAL_SELECTION);
        expect(containsCoordinate(circleSelection(1.3, 103.8, 500), { latitude: Infinity, longitude: 103.8 })).toBe(false);
    });

    it('filters generic records and distinguishes no selection from an empty selection', () => {
        const items = [
            { id: 1, latitude: 1.3, longitude: 103.8 },
            { id: 2, latitude: 1.5, longitude: 104 }
        ];
        expect(filterBySpatialSelection(items, NO_SPATIAL_SELECTION, (item) => item)).toBeNull();
        expect(filterBySpatialSelection(items, rectangleSelection(1.29, 103.79, 1.31, 103.81), (item) => item))
            .toEqual([items[0]]);
        expect(filterBySpatialSelection(items, rectangleSelection(1.0, 103.0, 1.1, 103.1), (item) => item))
            .toEqual([]);
    });
});
