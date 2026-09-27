/** Every value that can colour the map. */
export const MAP_METRIC_IDS = [
    'price',
    'price_psf',
    'rent',
    'rent_psf',
    'gross_yield',
    'monthly_surplus',
] as const;

export type MapMetric = typeof MAP_METRIC_IDS[number];

export type MetricUnit = '$' | '$/psf' | '$/month' | '$/psf/month' | '%';
export type MetricPalette = 'sequential' | 'diverging';

export interface PercentileDomainPolicy {
    kind: 'percentile';
    lower: number;
    upper: number;
    /** Minimum half-width used when every usable value is identical. */
    constantPadding: number;
}

export interface SymmetricPercentileDomainPolicy {
    kind: 'symmetric-percentile';
    percentile: number;
    /** Minimum extent used when every usable value is zero. */
    minimumExtent: number;
}

export type MetricDomainPolicy = PercentileDomainPolicy | SymmetricPercentileDomainPolicy;

/**
 * Structural input accepted by metric accessors during the migration to the
 * canonical registry. Both source-data and map-facing property names are
 * supported; consumers do not need to reshape an entire collection first.
 */
export interface MapMetricDatum {
    resale_price?: number | null;
    price?: number | null;
    price_psf?: number | null;
    pricePsf?: number | null;
    rent?: number | null;
    monthlyRent?: number | null;
    rent_psf?: number | null;
    rentPsf?: number | null;
    gross_yield?: number | null;
    grossYield?: number | null;
    monthly_surplus?: number | null;
    monthlySurplus?: number | null;
}

export interface MetricDefinition {
    id: MapMetric;
    label: string;
    unit: MetricUnit;
    palette: MetricPalette;
    domainPolicy: MetricDomainPolicy;
    valueAccessor: (datum: MapMetricDatum) => number | null;
    formatter: (value: number) => string;
}

export interface NumericSummary {
    count: number;
    min: number;
    q1: number;
    median: number;
    q3: number;
    max: number;
    iqr: number;
}

export interface ScaleDomain {
    min: number;
    max: number;
    rawMin: number;
    rawMax: number;
    lowClipped: boolean;
    highClipped: boolean;
    constant: boolean;
}

export interface ScalePopulation {
    summary: NumericSummary | null;
}

export interface ScalePresentation {
    metric: MapMetric;
    domain: ScaleDomain | null;
    all: ScalePopulation;
    /** Null means that no spatial selection is active. */
    selected: ScalePopulation | null;
}
