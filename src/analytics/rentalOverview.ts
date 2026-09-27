import { normalizeFlatType, summarize } from '../rental/model';
import type { NumericSummary, RentalAnalysisWindow, RentalDataset, RentalRecord } from '../rental/types';
import { containsCoordinate, type SpatialSelection } from '../spatial/selection';

export interface RentalOverviewSource {
    readonly dataset: RentalDataset;
    readonly analysisWindow: RentalAnalysisWindow | null;
}

export interface RentalOverviewModel {
    readonly records: readonly RentalRecord[];
    readonly summary: NumericSummary | null;
    readonly unresolvedExcluded: number;
    readonly selected: boolean;
}

type Listener = (source: RentalOverviewSource | null) => void;

let currentSource: RentalOverviewSource | null = null;
const listeners = new Set<Listener>();

/** Supplies the raw v2 rental asset to read-only analytics consumers. */
export function publishRentalOverviewSource(
    dataset: RentalDataset | null,
    analysisWindow: RentalAnalysisWindow | null,
): void {
    currentSource = dataset ? { dataset, analysisWindow } : null;
    listeners.forEach((listener) => listener(currentSource));
}

export function getRentalOverviewSource(): RentalOverviewSource | null {
    return currentSource;
}

export function subscribeRentalOverviewSource(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Builds the one authoritative row set used by both rental summary and chart.
 * Source rows are never deduplicated and no statistical outlier rule is applied.
 */
export function buildRentalOverviewModel(
    source: RentalOverviewSource | null,
    activeFlatType: string | null,
    selection: SpatialSelection,
): RentalOverviewModel {
    const selected = selection.kind !== 'none';
    if (!source || !activeFlatType) return { records: [], summary: null, unresolvedExcluded: 0, selected };

    const wantedType = normalizeFlatType(activeFlatType);
    const { dataset, analysisWindow } = source;
    const locations = new Map(dataset.locations.map((location) => [location.id, location]));
    const qualifying = dataset.records.filter((record) =>
        isMonth(record.month)
        && (!analysisWindow || (record.month >= analysisWindow.minMonth && record.month <= analysisWindow.maxMonth))
        && normalizeFlatType(record.flat_type) === wantedType
        && Number.isFinite(record.monthly_rent)
        && record.monthly_rent > 0
    );

    let unresolvedExcluded = 0;
    const records = selected ? qualifying.filter((record) => {
        const location = record.locationId === null ? undefined : locations.get(record.locationId);
        if (!location) {
            unresolvedExcluded++;
            return false;
        }
        return containsCoordinate(selection, location);
    }) : qualifying;

    return {
        records,
        summary: summarize(records.map((record) => record.monthly_rent)),
        unresolvedExcluded,
        selected,
    };
}

function isMonth(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
