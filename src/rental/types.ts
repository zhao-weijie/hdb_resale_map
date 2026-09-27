/** Domain types for whole-flat rental evidence and post-MOP scenarios. */

import type { NumericSummary } from '../metrics';
export type { NumericSummary } from '../metrics';

export type Month = `${number}-${string}` | string;

/** The raw shape published by data.gov.sg's HDB rental transactions dataset. */
export interface RentalRecord {
    month: Month;
    town: string;
    block: string;
    street_name: string;
    flat_type: string;
    monthly_rent: number;
    /** Index into RentalDataset.locations; null when the source address is unresolved. */
    locationId: number | null;
}

export interface RentalLocation {
    id: number;
    addressKey: string;
    latitude: number;
    longitude: number;
}

export interface RentalDataset {
    version: 2;
    generatedAt: string;
    minMonth: Month;
    maxMonth: Month;
    records: RentalRecord[];
    locations: RentalLocation[];
}

/** The resale fields used by the rental estimator.  They intentionally mirror HDBTransaction. */
export interface ResaleComparable {
    month: Month;
    town: string;
    block: string;
    street_name: string;
    flat_type: string;
    resale_price: number;
    floor_area_sqm: number;
    lease_commence_date: number;
    remaining_lease_years?: number;
    storey_range?: string;
    latitude?: number;
    longitude?: number;
    /** Straight-line metres to the nearest MRT exit, when available. */
    mrt_distance_m?: number;
}

export interface BlockTypeTarget {
    block: string;
    streetName: string;
    flatType: string;
    town?: string;
    latitude?: number;
    longitude?: number;
    leaseCommencement?: number;
    nearestMrtExitMeters?: number;
}

export interface RentalAnalysisWindow {
    minMonth: Month;
    maxMonth: Month;
}

export interface RentalEvidence {
    summary: NumericSummary | null;
    /** Observation count before invalid values and outliers were removed. */
    rawCount: number;
    excludedInvalid: number;
    excludedOutliers: number;
    blockCount: number;
    window: RentalAnalysisWindow | null;
    /** Exact source records exposed for plots; record objects retain source identity. */
    records: readonly RentalRecord[];
    includedRecords: readonly RentalRecord[];
}

export type RentalEstimateSource = 'same_block' | 'nearby_blocks' | 'unavailable';

export interface ResaleFilters {
    floorMin?: number;
    leaseMin?: number;
    leaseMax?: number;
}

export interface ResaleEstimate {
    summary: NumericSummary | null;
    areaSummary: NumericSummary | null;
    qualifiedForMap: boolean;
    nearestMrtExitMeters: number | null;
    records: readonly ResaleComparable[];
}

export interface RentalEstimate {
    source: RentalEstimateSource;
    monthlyRent: number | null;
    rentPsf: number | null;
    /** Thin direct evidence remains visible even if nearby evidence was selected. */
    direct: RentalEvidence;
    nearby: RentalEvidence | null;
    selected: RentalEvidence | null;
    resale: ResaleEstimate;
    analysisWindow: RentalAnalysisWindow | null;
}

export interface EstimationInput {
    target: BlockTypeTarget;
    rentalRecords: RentalRecord[];
    rentalLocations?: readonly RentalLocation[];
    resaleComparables: ResaleComparable[];
    analysisWindow?: RentalAnalysisWindow;
    resaleFilters?: ResaleFilters;
}

/** Shared immutable inputs for building a bulk rental estimation context. */
export interface EstimationContextInput {
    rentalRecords: RentalRecord[];
    rentalLocations?: readonly RentalLocation[];
    resaleComparables: ResaleComparable[];
    analysisWindow?: RentalAnalysisWindow;
    resaleFilters?: ResaleFilters;
}

export interface ScenarioAssumptions {
    purchaseDate: string;
    buyerMopYears: number;
    ltv: number;
    mortgageYears: number;
    initialRate: number;
    rentalRate: number;
    annualRentGrowth: number;
    operatingReserve: number;
}

export interface ScenarioInput {
    purchasePrice: number;
    /** BSD uses the higher of purchase price and market value when supplied. */
    marketValue?: number;
    currentMonthlyRent: number;
    /** The latest evidence month. Used to compound rent until the rental start date. */
    evidenceAsOf?: Month;
    annualValueOverride?: number;
    assumptions?: Partial<ScenarioAssumptions>;
}

export interface RentalScenario {
    assumptions: ScenarioAssumptions;
    rentalStartDate: string;
    rentProjectionMonths: number;
    currentMonthlyRent: number;
    projectedMonthlyRent: number;
    loanAmount: number;
    equityContribution: number;
    bsd: number;
    mortgageDuty: number;
    upfrontCapital: number;
    initialMonthlyPayment: number;
    balanceAtRentalStart: number;
    remainingMortgageMonths: number;
    rentalMonthlyPayment: number;
    annualValue: number;
    annualPropertyTax: number;
    grossYield: number;
    basicMonthlySurplus: number;
    reserveAdjustedMonthlySurplus: number;
    propertyMonthlySurplus: number;
    annualPropertyCashSurplus: number;
    cashFlowReturnOnInitialCapital: number;
    firstRentalYearPrincipal: number;
}

export type RentalMetric = 'monthly_rent' | 'estimated_rent_psf' | 'gross_yield' | 'monthly_surplus';
/** Map-facing names, including the existing resale colour modes. */
export interface MetricValue {
    value: number | null;
    unit: '$/month' | '$/psf/month' | '%' | '$/month after reserve and tax';
    available: boolean;
}
