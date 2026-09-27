import type { MapMetric } from '../rental/types';

export const MAP_METRICS: ReadonlyArray<{ value: MapMetric; label: string; unit: string }> = [
    { value: 'price_psf', label: 'Price per sqft', unit: '$/psf' },
    { value: 'price', label: 'Resale price', unit: '$' },
    { value: 'rent', label: 'Monthly rent', unit: '$/month' },
    { value: 'rent_psf', label: 'Estimated rent / sqft', unit: '$/psf/month' },
    { value: 'gross_yield', label: 'Gross yield', unit: '%' },
    { value: 'monthly_surplus', label: 'Monthly surplus', unit: '$/month' },
];

export function metricOptionsMarkup(): string {
    return MAP_METRICS.map(({ value, label }) => `<option value="${value}">${label}</option>`).join('');
}
