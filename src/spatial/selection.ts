export interface Coordinate {
    latitude: number;
    longitude: number;
}

export type SpatialSelection =
    | { kind: 'none' }
    | { kind: 'circle'; center: Coordinate; radiusMeters: number }
    | { kind: 'rectangle'; south: number; west: number; north: number; east: number };

export const NO_SPATIAL_SELECTION: SpatialSelection = Object.freeze({ kind: 'none' });

export function isValidCoordinate(coordinate: Coordinate): boolean {
    return Number.isFinite(coordinate.latitude)
        && Number.isFinite(coordinate.longitude)
        && coordinate.latitude >= -90
        && coordinate.latitude <= 90
        && coordinate.longitude >= -180
        && coordinate.longitude <= 180;
}

export function circleSelection(
    latitude: number,
    longitude: number,
    radiusMeters: number
): SpatialSelection {
    const center = { latitude, longitude };
    if (!isValidCoordinate(center) || !Number.isFinite(radiusMeters) || radiusMeters < 0) {
        return NO_SPATIAL_SELECTION;
    }
    return { kind: 'circle', center, radiusMeters };
}

export function rectangleSelection(
    latitudeA: number,
    longitudeA: number,
    latitudeB: number,
    longitudeB: number
): SpatialSelection {
    const first = { latitude: latitudeA, longitude: longitudeA };
    const second = { latitude: latitudeB, longitude: longitudeB };
    if (!isValidCoordinate(first) || !isValidCoordinate(second)) return NO_SPATIAL_SELECTION;
    return {
        kind: 'rectangle',
        south: Math.min(latitudeA, latitudeB),
        west: Math.min(longitudeA, longitudeB),
        north: Math.max(latitudeA, latitudeB),
        east: Math.max(longitudeA, longitudeB)
    };
}

export function haversineDistanceMeters(a: Coordinate, b: Coordinate): number {
    if (!isValidCoordinate(a) || !isValidCoordinate(b)) return Number.POSITIVE_INFINITY;
    const radians = Math.PI / 180;
    const latitudeDelta = (b.latitude - a.latitude) * radians;
    const longitudeDelta = (b.longitude - a.longitude) * radians;
    const latitudeA = a.latitude * radians;
    const latitudeB = b.latitude * radians;
    const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
    return 6371e3 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function containsCoordinate(selection: SpatialSelection, coordinate: Coordinate): boolean {
    if (!isValidCoordinate(coordinate) || selection.kind === 'none') return false;
    if (selection.kind === 'circle') {
        return isValidCoordinate(selection.center)
            && Number.isFinite(selection.radiusMeters)
            && selection.radiusMeters >= 0
            && haversineDistanceMeters(selection.center, coordinate) <= selection.radiusMeters;
    }
    return Number.isFinite(selection.south)
        && Number.isFinite(selection.west)
        && Number.isFinite(selection.north)
        && Number.isFinite(selection.east)
        && selection.south <= selection.north
        && selection.west <= selection.east
        && coordinate.latitude >= selection.south
        && coordinate.latitude <= selection.north
        && coordinate.longitude >= selection.west
        && coordinate.longitude <= selection.east;
}

export function filterBySpatialSelection<T>(
    items: readonly T[],
    selection: SpatialSelection,
    coordinateOf: (item: T) => Coordinate
): T[] | null {
    if (selection.kind === 'none') return null;
    return items.filter((item) => containsCoordinate(selection, coordinateOf(item)));
}
