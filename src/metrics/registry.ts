import type {
    MapMetric,
    MapMetricDatum,
    MetricDefinition,
    MetricDomainPolicy,
} from './types';

const robustDomain = (constantPadding: number): MetricDomainPolicy => ({
    kind: 'percentile',
    lower: 0.02,
    upper: 0.98,
    constantPadding,
});

const valueFrom = (datum: MapMetricDatum, ...keys: Array<keyof MapMetricDatum>): number | null => {
    for (const key of keys) {
        const value = datum[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
};

const integerCurrency = new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 0,
});

const decimalCurrency = new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const formatIntegerCurrency = (value: number): string => integerCurrency.format(value);
const formatPsf = (value: number): string => `${integerCurrency.format(value)}/psf`;
const formatRentPsf = (value: number): string => `${decimalCurrency.format(value)}/psf`;
const formatYield = (value: number): string => `${value.toFixed(1)}%`;

export const METRIC_REGISTRY: Readonly<Record<MapMetric, MetricDefinition>> = {
    price: {
        id: 'price',
        label: 'Resale price',
        unit: '$',
        palette: 'sequential',
        domainPolicy: robustDomain(1),
        valueAccessor: (datum) => valueFrom(datum, 'resale_price', 'price'),
        formatter: formatIntegerCurrency,
    },
    price_psf: {
        id: 'price_psf',
        label: 'Price per sqft',
        unit: '$/psf',
        palette: 'sequential',
        domainPolicy: robustDomain(1),
        valueAccessor: (datum) => valueFrom(datum, 'price_psf', 'pricePsf'),
        formatter: formatPsf,
    },
    rent: {
        id: 'rent',
        label: 'Monthly rent',
        unit: '$/month',
        palette: 'sequential',
        domainPolicy: robustDomain(1),
        valueAccessor: (datum) => valueFrom(datum, 'rent', 'monthlyRent'),
        formatter: formatIntegerCurrency,
    },
    rent_psf: {
        id: 'rent_psf',
        label: 'Estimated rent / sqft',
        unit: '$/psf/month',
        palette: 'sequential',
        domainPolicy: robustDomain(0.01),
        valueAccessor: (datum) => valueFrom(datum, 'rent_psf', 'rentPsf'),
        formatter: formatRentPsf,
    },
    gross_yield: {
        id: 'gross_yield',
        label: 'Gross yield',
        unit: '%',
        palette: 'sequential',
        domainPolicy: robustDomain(0.1),
        valueAccessor: (datum) => valueFrom(datum, 'gross_yield', 'grossYield'),
        formatter: formatYield,
    },
    monthly_surplus: {
        id: 'monthly_surplus',
        label: 'Monthly surplus',
        unit: '$/month',
        palette: 'diverging',
        domainPolicy: { kind: 'symmetric-percentile', percentile: 0.95, minimumExtent: 1 },
        valueAccessor: (datum) => valueFrom(datum, 'monthly_surplus', 'monthlySurplus'),
        formatter: formatIntegerCurrency,
    },
};

export const getMetricDefinition = (metric: MapMetric): MetricDefinition => METRIC_REGISTRY[metric];

export function metricValue(metric: MapMetric, datum: MapMetricDatum): number | null {
    return METRIC_REGISTRY[metric].valueAccessor(datum);
}

export function metricValues(metric: MapMetric, data: Iterable<MapMetricDatum>): number[] {
    const accessor = METRIC_REGISTRY[metric].valueAccessor;
    const values: number[] = [];
    for (const datum of data) {
        const value = accessor(datum);
        if (value !== null) values.push(value);
    }
    return values;
}
