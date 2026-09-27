import { METRIC_REGISTRY } from './registry';
import type {
    MapMetric,
    MetricDomainPolicy,
    NumericSummary,
    ScaleDomain,
    ScalePresentation,
} from './types';

function sortedFinite(values: Iterable<number | null | undefined>): number[] {
    const finite: number[] = [];
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) finite.push(value);
    }
    return finite.sort((a, b) => a - b);
}

/** Linear interpolation using the same (n - 1) index convention as d3 quantile. */
export function quantileSorted(sortedValues: readonly number[], probability: number): number {
    if (sortedValues.length === 0) return Number.NaN;
    const p = Math.max(0, Math.min(1, probability));
    const index = (sortedValues.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

export function summarizeNumbers(values: Iterable<number | null | undefined>): NumericSummary | null {
    const sorted = sortedFinite(values);
    if (sorted.length === 0) return null;
    const q1 = quantileSorted(sorted, 0.25);
    const q3 = quantileSorted(sorted, 0.75);
    return {
        count: sorted.length,
        min: sorted[0],
        q1,
        median: quantileSorted(sorted, 0.5),
        q3,
        max: sorted[sorted.length - 1],
        iqr: q3 - q1,
    };
}

export function calculateScaleDomain(
    values: Iterable<number | null | undefined>,
    policy: MetricDomainPolicy,
): ScaleDomain | null {
    const sorted = sortedFinite(values);
    if (sorted.length === 0) return null;

    const rawMin = sorted[0];
    const rawMax = sorted[sorted.length - 1];
    const constant = rawMin === rawMax;

    if (policy.kind === 'symmetric-percentile') {
        const magnitudes = sorted.map(Math.abs).sort((a, b) => a - b);
        const percentileExtent = quantileSorted(magnitudes, policy.percentile);
        const extent = Math.max(percentileExtent, policy.minimumExtent);
        return {
            min: -extent,
            max: extent,
            rawMin,
            rawMax,
            lowClipped: rawMin < -extent,
            highClipped: rawMax > extent,
            constant,
        };
    }

    let min = quantileSorted(sorted, policy.lower);
    let max = quantileSorted(sorted, policy.upper);
    if (min === max) {
        min -= policy.constantPadding;
        max += policy.constantPadding;
    }
    return {
        min,
        max,
        rawMin,
        rawMax,
        lowClipped: rawMin < min,
        highClipped: rawMax > max,
        constant,
    };
}

export function calculateMetricDomain(
    metric: MapMetric,
    values: Iterable<number | null | undefined>,
): ScaleDomain | null {
    return calculateScaleDomain(values, METRIC_REGISTRY[metric].domainPolicy);
}

/**
 * Produces the complete, UI-neutral scale model. The domain is deliberately
 * derived only from `allValues`; a selection can never recolour the map.
 * Passing `undefined` means no active selection, while an empty iterable means
 * an active selection with no usable values.
 */
export function createScalePresentation(
    metric: MapMetric,
    allValues: Iterable<number | null | undefined>,
    selectedValues?: Iterable<number | null | undefined>,
): ScalePresentation {
    const all = [...allValues];
    return {
        metric,
        domain: calculateMetricDomain(metric, all),
        all: { summary: summarizeNumbers(all) },
        selected: selectedValues === undefined
            ? null
            : { summary: summarizeNumbers(selectedValues) },
    };
}

export function scaleScalar(value: number | null | undefined, domain: ScaleDomain | null): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || !domain) return null;
    const range = domain.max - domain.min;
    if (!(range > 0)) return 0.5;
    return Math.max(0, Math.min(1, (value - domain.min) / range));
}
