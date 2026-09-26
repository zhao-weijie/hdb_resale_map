import { haversineDistance } from '../utils/geo';
import type {
    BlockTypeTarget, EstimationContextInput, EstimationInput, MetricValue, Month, NumericSummary, PaletteDomain,
    MapMetric, ProjectClassification, RentalAnalysisWindow, RentalEligibility, RentalEstimate,
    RentalEvidence, RentalMetric, RentalRecord, RentalScenario, ResaleComparable,
    ResaleEstimate, ResaleFilters, ScenarioAssumptions, ScenarioInput,
} from './types';

export type { RentalEstimate, RentalScenario } from './types';

export const SQM_TO_SQFT = 10.7639104167;
/** Singapore's calendar date, including the hours before midnight UTC. */
export function singaporeToday(now = new Date()): string {
    return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export const DEFAULT_SCENARIO_ASSUMPTIONS: ScenarioAssumptions = {
    purchaseDate: singaporeToday(),
    buyerMopYears: 5,
    ltv: 0.75,
    mortgageYears: 25,
    initialRate: 0.03,
    rentalRate: 0.03,
    annualRentGrowth: 0,
    operatingReserve: 0.10,
};

interface BlockProfile {
    latitude?: number;
    longitude?: number;
    leaseCommencement?: number;
}

/**
 * Preprocessed evidence for a whole map. Build once for a window/filter set,
 * then call `estimateRentForTarget` per rendered block/type.
 */
export interface RentalEstimationContext {
    analysisWindow: RentalAnalysisWindow | null;
    resaleComparables: ResaleComparable[];
    resaleFilters: ResaleFilters;
    classifications: ProjectClassification[];
    filteredRentalRecords: RentalRecord[];
    rentalByBlockType: ReadonlyMap<string, RentalRecord[]>;
    rawRentalByBlockType: ReadonlyMap<string, RentalRecord[]>;
    resaleByBlockType: ReadonlyMap<string, ResaleComparable[]>;
    blockProfiles: ReadonlyMap<string, BlockProfile>;
    nearbyBlockTypes: ReadonlyMap<string, ReadonlyMap<string, RentalRecord[]>>;
    nearbyGrid: ReadonlyMap<string, string[]>;
    classificationByBlock: ReadonlyMap<string, ProjectClassification>;
}

export function normalizeAddressPart(value: string | null | undefined): string {
    return (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/[.,]/g, '');
}

export function normalizeFlatType(value: string | null | undefined): string {
    return normalizeAddressPart(value).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').replace(/\bROOMS?\b/g, 'ROOM').trim();
}

export function blockKey(block: string, streetName: string): string {
    // Official project brochures spell road types out; transaction files abbreviate them.
    const street = normalizeAddressPart(streetName).replace(/\b(ROAD|STREET|AVENUE|DRIVE|CRESCENT|CLOSE|PLACE|BUKIT|JALAN|UPPER)\b/g,
        (part) => ({ ROAD: 'RD', STREET: 'ST', AVENUE: 'AVE', DRIVE: 'DR', CRESCENT: 'CRES', CLOSE: 'CL', PLACE: 'PL', BUKIT: 'BT', JALAN: 'JLN', UPPER: 'UPP' }[part]!));
    return `${normalizeAddressPart(block)}|${street}`;
}

export function getSharedRentalAnalysisWindow(
    rentalRecords: RentalRecord[],
    resaleComparables: ResaleComparable[],
): RentalAnalysisWindow | null {
    const rentalMonths = rentalRecords.map((record) => record.month).filter(isMonth);
    const resaleMonths = resaleComparables.map((record) => record.month).filter(isMonth);
    if (!rentalMonths.length || !resaleMonths.length) return null;
    const sharedLatest = [maxMonth(rentalMonths), maxMonth(resaleMonths)].sort()[0];
    if (!sharedLatest) return null;
    const year = Number(sharedLatest.slice(0, 4));
    return { minMonth: `${year - 1}-01`, maxMonth: sharedLatest };
}

export function summarize(values: number[]): NumericSummary | null {
    const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        median: quantile(sorted, 0.5),
        q1,
        q3,
        iqr: q3 - q1,
    };
}

/** Removes invalid rents and town/type 3-IQR outliers within the supplied analysis window. */
export function filterRentalRecords(records: RentalRecord[], window: RentalAnalysisWindow | null): RentalRecord[] {
    const valid = records.filter((record) => isMonth(record.month) && inWindow(record.month, window) &&
        isFiniteNumber(record.monthly_rent) && record.monthly_rent > 0);
    const grouped = new Map<string, RentalRecord[]>();
    for (const record of valid) {
        const key = `${normalizeAddressPart(record.town)}|${normalizeFlatType(record.flat_type)}`;
        const group = grouped.get(key);
        if (group) group.push(record);
        else grouped.set(key, [record]);
    }
    const keep = new Set<RentalRecord>();
    for (const group of grouped.values()) {
        if (group.length < 20) {
            group.forEach((record) => keep.add(record));
            continue;
        }
        const stats = summarize(group.map((record) => record.monthly_rent));
        if (!stats) continue;
        const lower = stats.q1 - 3 * stats.iqr;
        const upper = stats.q3 + 3 * stats.iqr;
        group.filter((record) => record.monthly_rent >= lower && record.monthly_rent <= upper)
            .forEach((record) => keep.add(record));
    }
    return valid.filter((record) => keep.has(record));
}

export function getResaleEstimate(
    comparables: ResaleComparable[], target: BlockTypeTarget, filters: ResaleFilters = {},
): ResaleEstimate {
    const targetKey = blockKey(target.block, target.streetName);
    const flatType = normalizeFlatType(target.flatType);
    const matching = comparables.filter((record) => blockKey(record.block, record.street_name) === targetKey &&
        normalizeFlatType(record.flat_type) === flatType && validResale(record, filters));
    return resaleEstimateForMatching(matching, target);
}

function getResaleEstimateFromRecords(
    records: ResaleComparable[], target: BlockTypeTarget, filters: ResaleFilters,
): ResaleEstimate {
    return resaleEstimateForMatching(records.filter((record) => validResale(record, filters)), target);
}

function resaleEstimateForMatching(matching: ResaleComparable[], target: BlockTypeTarget): ResaleEstimate {
    const summary = summarize(matching.map((record) => record.resale_price));
    const areaSummary = summarize(matching.map((record) => record.floor_area_sqm));
    const mrt = target.nearestMrtExitMeters ?? summarize(matching.map((record) => record.mrt_distance_m ?? NaN))?.median ?? null;
    return { summary, areaSummary, qualifiedForMap: (summary?.count ?? 0) >= 3, nearestMrtExitMeters: mrt };
}

export function resolveRentalEligibility(
    target: BlockTypeTarget,
    classifications: ProjectClassification[] = [],
): { eligibility: RentalEligibility; classification: ProjectClassification | null; provisional: boolean } {
    const key = blockKey(target.block, target.streetName);
    const classification = classifications.find((candidate) => blockKey(candidate.block, candidate.street_name) === key) ?? null;
    if (!classification) return { eligibility: 'unknown', classification: null, provisional: true };
    if (classification.wholeFlatRental === 'prohibited' ||
        classification.category === 'plus' || classification.category === 'prime' || classification.category === 'plh') {
        return { eligibility: 'prohibited', classification, provisional: false };
    }
    if (classification.wholeFlatRental === 'unknown' || classification.category === 'unknown') {
        return { eligibility: 'unknown', classification, provisional: true };
    }
    return { eligibility: 'allowed', classification, provisional: false };
}

export function estimateRent(input: EstimationInput): RentalEstimate {
    const context = createRentalEstimationContext(input);
    return estimateRentForTarget(context, input.target);
}

export function createRentalEstimationContext(input: EstimationContextInput): RentalEstimationContext {
    const analysisWindow = input.analysisWindow ?? getSharedRentalAnalysisWindow(input.rentalRecords, input.resaleComparables);
    const filteredRentalRecords = filterRentalRecords(input.rentalRecords, analysisWindow);
    const rawInWindow = input.rentalRecords.filter((record) => inWindow(record.month, analysisWindow));
    const rentalByBlockType = indexBy(filteredRentalRecords, (record) => recordBlockTypeKey(record));
    const rawRentalByBlockType = indexBy(rawInWindow, (record) => recordBlockTypeKey(record));
    const resaleByBlockType = indexBy(input.resaleComparables.filter((record) => inWindow(record.month, analysisWindow)), (record) => resaleBlockTypeKey(record));
    const profiles = blockProfiles(input.resaleComparables);
    const nearbyBlockTypes = new Map<string, Map<string, RentalRecord[]>>();
    const nearbyGrid = new Map<string, string[]>();
    for (const records of rentalByBlockType.values()) {
        const first = records[0];
        const profile = profiles.get(blockKey(first.block, first.street_name));
        if (!profile || !isFiniteNumber(profile.latitude) || !isFiniteNumber(profile.longitude)) continue;
        const type = normalizeFlatType(first.flat_type);
        const byBlock = nearbyBlockTypes.get(type) ?? new Map<string, RentalRecord[]>();
        byBlock.set(blockKey(first.block, first.street_name), records);
        nearbyBlockTypes.set(type, byBlock);
        const cell = gridKey(profile.latitude, profile.longitude);
        const grid = `${type}|${cell}`;
        const keys = nearbyGrid.get(grid) ?? [];
        keys.push(blockKey(first.block, first.street_name));
        nearbyGrid.set(grid, keys);
    }
    return {
        analysisWindow, resaleComparables: input.resaleComparables, resaleFilters: input.resaleFilters ?? {},
        classifications: input.classifications ?? [], filteredRentalRecords, rentalByBlockType,
        rawRentalByBlockType, resaleByBlockType, blockProfiles: profiles, nearbyBlockTypes,
        nearbyGrid, classificationByBlock: new Map((input.classifications ?? []).map((item) => [blockKey(item.block, item.street_name), item])),
    };
}

export function estimateRentForTarget(context: RentalEstimationContext, target: BlockTypeTarget): RentalEstimate {
    const window = context.analysisWindow;
    const flatType = normalizeFlatType(target.flatType);
    const typeKey = targetBlockTypeKey(target);
    const rawDirect = context.rawRentalByBlockType.get(typeKey) ?? [];
    const directRecords = context.rentalByBlockType.get(typeKey) ?? [];
    const direct = evidenceFor(directRecords, rawDirect, window);
    const resale = getResaleEstimateFromRecords(context.resaleByBlockType.get(typeKey) ?? [], target, context.resaleFilters);
    const eligibility = resolveRentalEligibility(target, context.classifications);
    if (eligibility.eligibility === 'prohibited') {
        return unavailableEstimate(direct, resale, eligibility, window);
    }
    if ((direct.summary?.count ?? 0) >= 5) {
        return selectedEstimate('same_block', direct, null, resale, eligibility, window);
    }

    const nearbyRecords = nearbyRentalRecordsFromContext(context, target, flatType, false);
    const rawNearby = nearbyRentalRecordsFromContext(context, target, flatType, true);
    const nearby = evidenceFor(nearbyRecords, rawNearby, window);
    if ((nearby.summary?.count ?? 0) >= 10 && nearby.blockCount >= 3) {
        return selectedEstimate('nearby_blocks', direct, nearby, resale, eligibility, window);
    }
    return unavailableEstimate(direct, resale, eligibility, window, nearby);
}

export function calculateScenario(input: ScenarioInput): RentalScenario {
    const assumptions = sanitizedAssumptions(input.assumptions);
    const purchasePrice = nonNegative(input.purchasePrice);
    const marketValue = nonNegative(input.marketValue ?? purchasePrice);
    const currentMonthlyRent = nonNegative(input.currentMonthlyRent);
    // The buyer's occupation period is independent of whether a loan is already paid off.
    const monthsBeforeRental = Math.max(0, Math.round(assumptions.buyerMopYears * 12));
    const rentalStart = addMonths(assumptions.purchaseDate, monthsBeforeRental);
    const rentProjectionMonths = input.evidenceAsOf && isMonth(input.evidenceAsOf)
        ? Math.max(0, monthsBetween(input.evidenceAsOf, rentalStart)) : monthsBeforeRental;
    const projectedMonthlyRent = currentMonthlyRent * Math.pow(1 + assumptions.annualRentGrowth, rentProjectionMonths / 12);
    const loanAmount = purchasePrice * assumptions.ltv;
    const equityContribution = purchasePrice - loanAmount;
    const mortgageMonths = Math.round(assumptions.mortgageYears * 12);
    const initialMonthlyPayment = monthlyPayment(loanAmount, assumptions.initialRate, mortgageMonths);
    const balanceAtRentalStart = remainingBalance(loanAmount, assumptions.initialRate, mortgageMonths, monthsBeforeRental);
    const remainingMortgageMonths = Math.max(0, mortgageMonths - monthsBeforeRental);
    const rentalMonthlyPayment = monthlyPayment(balanceAtRentalStart, assumptions.rentalRate, remainingMortgageMonths);
    const annualValue = input.annualValueOverride === undefined ? projectedMonthlyRent * 12 : nonNegative(input.annualValueOverride);
    const annualPropertyTax = calculateNonOwnerPropertyTax(annualValue);
    const bsd = calculateBSD(Math.max(purchasePrice, marketValue));
    const mortgageDuty = calculateMortgageDuty(loanAmount);
    const upfrontCapital = equityContribution + bsd + mortgageDuty;
    const reserve = projectedMonthlyRent * assumptions.operatingReserve;
    const basicMonthlySurplus = projectedMonthlyRent - rentalMonthlyPayment;
    const reserveAdjustedMonthlySurplus = projectedMonthlyRent - reserve - rentalMonthlyPayment;
    const propertyMonthlySurplus = reserveAdjustedMonthlySurplus - annualPropertyTax / 12;
    const annualPropertyCashSurplus = propertyMonthlySurplus * 12;
    const firstRentalYearPrincipal = principalRepaidOverMonths(
        balanceAtRentalStart, assumptions.rentalRate, remainingMortgageMonths, 12,
    );
    return {
        assumptions,
        rentalStartDate: rentalStart,
        rentProjectionMonths,
        currentMonthlyRent,
        projectedMonthlyRent,
        loanAmount,
        equityContribution,
        bsd,
        mortgageDuty,
        upfrontCapital,
        initialMonthlyPayment,
        balanceAtRentalStart,
        remainingMortgageMonths,
        rentalMonthlyPayment,
        annualValue,
        annualPropertyTax,
        grossYield: purchasePrice > 0 ? (12 * projectedMonthlyRent) / purchasePrice : 0,
        basicMonthlySurplus,
        reserveAdjustedMonthlySurplus,
        propertyMonthlySurplus,
        annualPropertyCashSurplus,
        cashFlowReturnOnInitialCapital: upfrontCapital > 0 ? annualPropertyCashSurplus / upfrontCapital : 0,
        firstRentalYearPrincipal,
    };
}

export function calculateBSD(value: number): number {
    let remaining = nonNegative(value);
    if (remaining === 0) return 0;
    let tax = 0;
    const bands: Array<[number, number]> = [[180_000, 0.01], [180_000, 0.02], [640_000, 0.03], [500_000, 0.04], [1_500_000, 0.05]];
    for (const [amount, rate] of bands) {
        const slice = Math.min(remaining, amount);
        tax += slice * rate;
        remaining -= slice;
        if (remaining <= 0) return Math.max(1, Math.floor(tax));
    }
    return Math.max(1, Math.floor(tax + remaining * 0.06));
}

export function calculateMortgageDuty(loanAmount: number): number {
    const loan = nonNegative(loanAmount);
    if (loan === 0) return 0;
    return Math.min(500, Math.max(1, Math.floor(loan * 0.004)));
}

/** Current non-owner occupied rates: 12% / 20% / 28% / 36% above AV bands. */
export function calculateNonOwnerPropertyTax(annualValue: number): number {
    let remaining = nonNegative(annualValue);
    let tax = 0;
    const bands: Array<[number, number]> = [[30_000, 0.12], [15_000, 0.20], [15_000, 0.28]];
    for (const [amount, rate] of bands) {
        const slice = Math.min(remaining, amount);
        tax += slice * rate;
        remaining -= slice;
        if (remaining <= 0) return tax;
    }
    return tax + remaining * 0.36;
}

export function getRentalMetric(
    metric: RentalMetric, estimate: RentalEstimate, scenario?: RentalScenario | null,
): MetricValue {
    const unavailable = (unit: MetricValue['unit']): MetricValue => ({ value: null, unit, available: false, provisional: estimate.provisional });
    if (estimate.eligibility === 'prohibited') {
        return unavailable(metric === 'gross_yield' ? '%' : metric === 'estimated_rent_psf' ? '$/psf/month' :
            metric === 'monthly_surplus' ? '$/month after reserve and tax' : '$/month');
    }
    switch (metric) {
        case 'monthly_rent':
            return estimate.monthlyRent === null ? unavailable('$/month') :
                { value: estimate.monthlyRent, unit: '$/month', available: true, provisional: estimate.provisional };
        case 'estimated_rent_psf':
            return estimate.rentPsf === null ? unavailable('$/psf/month') :
                { value: estimate.rentPsf, unit: '$/psf/month', available: true, provisional: estimate.provisional };
        case 'gross_yield':
            return !scenario ? unavailable('%') : { value: scenario.grossYield * 100, unit: '%', available: true, provisional: estimate.provisional };
        case 'monthly_surplus':
            return !scenario ? unavailable('$/month after reserve and tax') :
                { value: scenario.propertyMonthlySurplus, unit: '$/month after reserve and tax', available: true, provisional: estimate.provisional };
    }
}

/** Maps UI colour-mode names to the rental-only metric accessor. */
export function getMapRentalMetric(
    metric: Exclude<MapMetric, 'price' | 'price_psf'>, estimate: RentalEstimate, scenario?: RentalScenario | null,
): MetricValue {
    const rentalMetric: RentalMetric = metric === 'rent' ? 'monthly_rent' :
        metric === 'rent_psf' ? 'estimated_rent_psf' : metric;
    return getRentalMetric(rentalMetric, estimate, scenario);
}

export function getPaletteDomain(values: Array<number | null | undefined>): PaletteDomain | null {
    const sorted = values.filter((value): value is number => isFiniteNumber(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const min = quantile(sorted, 0.05);
    const max = quantile(sorted, 0.95);
    return { min, max: max > min ? max : min + 1, lowClipped: sorted[0] < min, highClipped: sorted[sorted.length - 1] > max };
}

export function paletteScalar(value: number | null | undefined, domain: PaletteDomain | null): number | null {
    if (!isFiniteNumber(value) || !domain) return null;
    return Math.max(0, Math.min(1, (value - domain.min) / (domain.max - domain.min)));
}

function selectedEstimate(source: 'same_block' | 'nearby_blocks', direct: RentalEvidence, nearby: RentalEvidence | null,
    resale: ResaleEstimate, eligibility: ReturnType<typeof resolveRentalEligibility>, window: RentalAnalysisWindow | null): RentalEstimate {
    const selected = source === 'same_block' ? direct : nearby;
    const monthlyRent = selected?.summary?.median ?? null;
    const areaSqft = resale.areaSummary?.median ? resale.areaSummary.median * SQM_TO_SQFT : 0;
    return {
        source, monthlyRent, rentPsf: monthlyRent !== null && areaSqft > 0 ? monthlyRent / areaSqft : null,
        direct, nearby, selected: selected ?? null, resale, eligibility: eligibility.eligibility,
        eligibilityClassification: eligibility.classification, provisional: eligibility.provisional, analysisWindow: window,
    };
}

function unavailableEstimate(direct: RentalEvidence, resale: ResaleEstimate, eligibility: ReturnType<typeof resolveRentalEligibility>,
    window: RentalAnalysisWindow | null, nearby: RentalEvidence | null = null): RentalEstimate {
    return {
        source: 'unavailable', monthlyRent: null, rentPsf: null, direct, nearby, selected: null, resale,
        eligibility: eligibility.eligibility, eligibilityClassification: eligibility.classification,
        provisional: eligibility.provisional, analysisWindow: window,
    };
}

function evidenceFor(records: RentalRecord[], raw: RentalRecord[], window: RentalAnalysisWindow | null): RentalEvidence {
    const validRaw = raw.filter((record) => isFiniteNumber(record.monthly_rent) && record.monthly_rent > 0);
    return {
        summary: summarize(records.map((record) => record.monthly_rent)), rawCount: raw.length,
        excludedInvalid: raw.length - validRaw.length,
        excludedOutliers: Math.max(0, validRaw.length - records.length),
        blockCount: new Set(records.map((record) => blockKey(record.block, record.street_name))).size,
        window,
    };
}

function nearbyRentalRecordsFromContext(context: RentalEstimationContext, target: BlockTypeTarget, flatType: string, raw: boolean): RentalRecord[] {
    const targetProfile = context.blockProfiles.get(blockKey(target.block, target.streetName));
    const targetLat = target.latitude ?? targetProfile?.latitude;
    const targetLng = target.longitude ?? targetProfile?.longitude;
    const targetLease = target.leaseCommencement ?? targetProfile?.leaseCommencement;
    if (!isFiniteNumber(targetLat) || !isFiniteNumber(targetLng) || !isFiniteNumber(targetLease)) return [];
    const candidates = new Set<string>();
    const { latCell, lngCell } = gridCoordinates(targetLat, targetLng);
    for (let lat = latCell - 1; lat <= latCell + 1; lat++) {
        for (let lng = lngCell - 1; lng <= lngCell + 1; lng++) {
            for (const key of context.nearbyGrid.get(`${flatType}|${lat}:${lng}`) ?? []) candidates.add(key);
        }
    }
    const targetBlock = blockKey(target.block, target.streetName);
    const output: RentalRecord[] = [];
    for (const candidateBlock of candidates) {
        if (candidateBlock === targetBlock) continue;
        const profile = context.blockProfiles.get(candidateBlock);
        if (!profile || !isFiniteNumber(profile.latitude) || !isFiniteNumber(profile.longitude) || !isFiniteNumber(profile.leaseCommencement) ||
            Math.abs(profile.leaseCommencement - targetLease) > 10 ||
            haversineDistance(targetLat, targetLng, profile.latitude, profile.longitude) > 500) continue;
        const first = context.nearbyBlockTypes.get(flatType)?.get(candidateBlock)?.[0];
        if (!first) continue;
        output.push(...(raw ? context.rawRentalByBlockType.get(recordBlockTypeKey(first)) : context.rentalByBlockType.get(recordBlockTypeKey(first))) ?? []);
    }
    return output;
}

function blockProfiles(resales: ResaleComparable[]): Map<string, BlockProfile> {
    const groups = new Map<string, ResaleComparable[]>();
    for (const resale of resales) {
        const key = blockKey(resale.block, resale.street_name);
        const group = groups.get(key);
        if (group) group.push(resale); else groups.set(key, [resale]);
    }
    const profiles = new Map<string, BlockProfile>();
    for (const [key, group] of groups) {
        profiles.set(key, {
            latitude: summarize(group.map((record) => record.latitude ?? NaN))?.median,
            longitude: summarize(group.map((record) => record.longitude ?? NaN))?.median,
            leaseCommencement: summarize(group.map((record) => record.lease_commence_date))?.median,
        });
    }
    return profiles;
}

function indexBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
    const index = new Map<string, T[]>();
    for (const item of items) {
        const key = keyFor(item);
        const group = index.get(key);
        if (group) group.push(item); else index.set(key, [item]);
    }
    return index;
}

function recordBlockTypeKey(record: RentalRecord): string {
    return `${blockKey(record.block, record.street_name)}|${normalizeFlatType(record.flat_type)}`;
}

function resaleBlockTypeKey(record: ResaleComparable): string {
    return `${blockKey(record.block, record.street_name)}|${normalizeFlatType(record.flat_type)}`;
}

function targetBlockTypeKey(target: BlockTypeTarget): string {
    return `${blockKey(target.block, target.streetName)}|${normalizeFlatType(target.flatType)}`;
}

const GRID_SIZE_DEGREES = 0.005;
function gridCoordinates(latitude: number, longitude: number): { latCell: number; lngCell: number } {
    return { latCell: Math.floor(latitude / GRID_SIZE_DEGREES), lngCell: Math.floor(longitude / GRID_SIZE_DEGREES) };
}
function gridKey(latitude: number, longitude: number): string {
    const { latCell, lngCell } = gridCoordinates(latitude, longitude);
    return `${latCell}:${lngCell}`;
}

function validResale(record: ResaleComparable, filters: ResaleFilters): boolean {
    if (!isFiniteNumber(record.resale_price) || record.resale_price <= 0 || !isFiniteNumber(record.floor_area_sqm) || record.floor_area_sqm <= 0) return false;
    if (filters.leaseMin !== undefined && (!isFiniteNumber(record.remaining_lease_years) || record.remaining_lease_years < filters.leaseMin)) return false;
    if (filters.leaseMax !== undefined && (!isFiniteNumber(record.remaining_lease_years) || record.remaining_lease_years > filters.leaseMax)) return false;
    if (filters.floorMin !== undefined && filters.floorMin > 1) {
        const upper = Number(record.storey_range?.match(/(\d+)\s*$/)?.[1]);
        if (!Number.isFinite(upper) || upper < filters.floorMin) return false;
    }
    return true;
}

function sanitizedAssumptions(overrides: Partial<ScenarioAssumptions> | undefined): ScenarioAssumptions {
    const candidate = { ...DEFAULT_SCENARIO_ASSUMPTIONS, ...overrides };
    return {
        purchaseDate: validDate(candidate.purchaseDate) ? candidate.purchaseDate : DEFAULT_SCENARIO_ASSUMPTIONS.purchaseDate,
        buyerMopYears: clampFinite(candidate.buyerMopYears, 0, 99, 5),
        ltv: clampFinite(candidate.ltv, 0, 1, 0.75),
        mortgageYears: clampFinite(candidate.ltv, 0, 1, 0.75) > 0 && candidate.mortgageYears === 0
            ? 25 : clampFinite(candidate.mortgageYears, 0, 50, 25),
        initialRate: clampFinite(candidate.initialRate, 0, 1, 0.03),
        rentalRate: clampFinite(candidate.rentalRate, 0, 1, 0.03),
        annualRentGrowth: clampFinite(candidate.annualRentGrowth, -0.99, 1, 0),
        operatingReserve: clampFinite(candidate.operatingReserve, 0, 1, 0.10),
    };
}

function monthlyPayment(principal: number, annualRate: number, months: number): number {
    if (principal <= 0 || months <= 0) return 0;
    const rate = annualRate / 12;
    if (rate === 0) return principal / months;
    const factor = Math.pow(1 + rate, months);
    return principal * rate * factor / (factor - 1);
}

function remainingBalance(principal: number, annualRate: number, months: number, paidMonths: number): number {
    if (principal <= 0) return 0;
    if (paidMonths <= 0) return principal;
    if (paidMonths >= months) return 0;
    const payment = monthlyPayment(principal, annualRate, months);
    const rate = annualRate / 12;
    if (rate === 0) return Math.max(0, principal - payment * paidMonths);
    return Math.max(0, principal * Math.pow(1 + rate, paidMonths) - payment * ((Math.pow(1 + rate, paidMonths) - 1) / rate));
}

function principalRepaidOverMonths(principal: number, annualRate: number, months: number, period: number): number {
    if (principal <= 0 || months <= 0 || period <= 0) return 0;
    return Math.max(0, principal - remainingBalance(principal, annualRate, months, Math.min(months, period)));
}

function isMonth(value: string): value is Month { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function inWindow(month: string, window: RentalAnalysisWindow | null): boolean { return isMonth(month) && (!window || (month >= window.minMonth && month <= window.maxMonth)); }
function maxMonth(months: Month[]): Month { return months.reduce((max, month) => month > max ? month : max); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nonNegative(value: unknown): number { return isFiniteNumber(value) && value > 0 ? value : 0; }
function quantile(sorted: number[], p: number): number { const index = (sorted.length - 1) * p; const lower = Math.floor(index); const upper = Math.ceil(index); return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower); }
function clampFinite(value: unknown, min: number, max: number, fallback: number): number { return isFiniteNumber(value) ? Math.max(min, Math.min(max, value)) : fallback; }
function validDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function addMonths(date: string, months: number): string {
    const result = new Date(`${date}T00:00:00Z`);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result.toISOString().slice(0, 10);
}
function monthsBetween(month: Month, date: string): number { const [year, monthNumber] = month.split('-').map(Number); const target = new Date(`${date}T00:00:00Z`); return (target.getUTCFullYear() - year) * 12 + (target.getUTCMonth() + 1 - monthNumber); }
