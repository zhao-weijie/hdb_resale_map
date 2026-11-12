import type { SourceFacts } from '../../convex/trackerTypes';

export function floorMeasurement(text: string): NonNullable<SourceFacts['floor']> | undefined {
    const originalText = text.trim();
    const match = /^(\d{1,3})(?:\s*(?:to|[-–—])\s*(\d{1,3}))?$/i.exec(originalText);
    if (!match) return undefined;
    const min = Number(match[1]);
    const max = match[2] ? Number(match[2]) : min;
    if (min > max || max > 250) return undefined;
    return match[2] ? { kind: 'range', min, max, originalText } : { kind: 'exact', value: min, originalText };
}

export function areaMeasurement(originalValue: number, originalUnit: 'sqm' | 'sqft'): NonNullable<SourceFacts['area']> {
    const sqm = originalUnit === 'sqft' ? originalValue / 10.7639104167 : originalValue;
    return { sqm, originalValue, originalUnit };
}
