/** Domain types for whole-flat rental evidence and post-MOP scenarios. */

export type Month = `${number}-${string}` | string;

/** The raw shape published by data.gov.sg's HDB rental transactions dataset. */
export interface RentalRecord {
    month: Month;
    town: string;
    block: string;
    street_name: string;
    flat_type: string;
    monthly_rent: number;
}

export type ProjectCategory = 'legacy' | 'standard' | 'plus' | 'prime' | 'plh' | 'unknown';
export type RentalEligibility = 'allowed' | 'prohibited' | 'unknown';

/**
 * A deliberately source-backed classification.  `unknown` means the source did
 * not establish an eligibility decision; it must not be inferred from rentals.
 */
export interface ProjectClassification {
    block: string;
    street_name: string;
    projectName?: string;
    category: ProjectCategory;
    wholeFlatRental: RentalEligibility;
    mopDate?: string;
    sourceUrl: string;
    reviewedAt: string;
}

export interface RentalDataset {
    version: 1;
    generatedAt: string;
    minMonth: Month;
    maxMonth: Month;
    records: RentalRecord[];
    classifications: ProjectClassification[];
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

export interface NumericSummary {
    count: number;
    min: number;
    max: number;
    median: number;
    q1: number;
    q3: number;
    iqr: number;
}

export interface RentalEvidence {
    summary: NumericSummary | null;
    /** Observation count before invalid values and outliers were removed. */
    rawCount: number;
    excludedInvalid: number;
    excludedOutliers: number;
    blockCount: number;
    window: RentalAnalysisWindow | null;
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
    eligibility: RentalEligibility;
    eligibilityClassification: ProjectClassification | null;
    /** True only for a source-backed unknown classification. */
    provisional: boolean;
    analysisWindow: RentalAnalysisWindow | null;
}

export interface EstimationInput {
    target: BlockTypeTarget;
    rentalRecords: RentalRecord[];
    resaleComparables: ResaleComparable[];
    classifications?: ProjectClassification[];
    analysisWindow?: RentalAnalysisWindow;
    resaleFilters?: ResaleFilters;
}

/** Shared immutable inputs for building a bulk rental estimation context. */
export interface EstimationContextInput {
    rentalRecords: RentalRecord[];
    resaleComparables: ResaleComparable[];
    classifications?: ProjectClassification[];
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
export type MapMetric = 'price' | 'price_psf' | 'rent' | 'rent_psf' | 'gross_yield' | 'monthly_surplus';

export interface MetricValue {
    value: number | null;
    unit: '$/month' | '$/psf/month' | '%' | '$/month after reserve and tax';
    available: boolean;
    provisional: boolean;
}

export interface PaletteDomain {
    min: number;
    max: number;
    lowClipped: boolean;
    highClipped: boolean;
}
