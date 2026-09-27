import { getMetricDefinition, type MapMetric } from '../metrics';

const MAP_METRIC_ORDER: readonly MapMetric[] = [
    'price_psf', 'price', 'rent', 'rent_psf', 'gross_yield', 'monthly_surplus',
];

export const MAP_METRICS: ReadonlyArray<{ value: MapMetric; label: string; unit: string }> =
    MAP_METRIC_ORDER.map((value) => {
        const definition = getMetricDefinition(value);
        return { value, label: definition.label, unit: definition.unit };
    });

export function metricOptionsMarkup(): string {
    return MAP_METRICS.map(({ value, label }) => `<option value="${value}">${label}</option>`).join('');
}
