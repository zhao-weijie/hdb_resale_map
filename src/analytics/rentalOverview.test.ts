import { afterEach, describe, expect, it, vi } from 'vitest';
import { circleSelection, NO_SPATIAL_SELECTION, rectangleSelection } from '../spatial/selection';
import type { RentalDataset, RentalRecord } from '../rental/types';
import {
    buildRentalOverviewModel,
    publishRentalOverviewSource,
    subscribeRentalOverviewSource,
} from './rentalOverview';

function record(overrides: Partial<RentalRecord> = {}): RentalRecord {
    return {
        month: '2026-01', town: 'TOWN', block: '1', street_name: 'STREET', flat_type: '4 ROOM',
        monthly_rent: 3_000, locationId: 1, ...overrides,
    };
}

function dataset(records: RentalRecord[]): RentalDataset {
    return {
        version: 2, generatedAt: '2026-09-27T00:00:00Z', minMonth: '2025-01', maxMonth: '2026-08', records,
        locations: [
            { id: 1, addressKey: '1|STREET', latitude: 1.30, longitude: 103.80 },
            { id: 7, addressKey: '7|STREET', latitude: 1.40, longitude: 103.90 },
        ],
    };
}

afterEach(() => publishRentalOverviewSource(null, null));

describe('rental overview model', () => {
    it('keeps duplicate valid source rows and applies only window and active flat type', () => {
        const duplicate = record();
        const source = {
            dataset: dataset([
                duplicate, { ...duplicate },
                record({ monthly_rent: 0 }),
                record({ monthly_rent: Number.NaN }),
                record({ month: 'not-a-month' }),
                record({ month: '2024-12' }),
                record({ flat_type: '5 ROOM' }),
                record({ monthly_rent: 100_000 }),
            ]),
            analysisWindow: { minMonth: '2025-01', maxMonth: '2026-08' },
        };
        const model = buildRentalOverviewModel(source, '4 ROOM', NO_SPATIAL_SELECTION);

        expect(model.records).toHaveLength(3);
        expect(model.summary).toMatchObject({ count: 3, median: 3_000, q1: 3_000, q3: 51_500 });
        expect(model.unresolvedExcluded).toBe(0);
    });

    it('uses each record location once for rectangle selection and reports unresolved rows', () => {
        const source = {
            dataset: dataset([
                record(),
                record({ monthly_rent: 3_200 }),
                record({ monthly_rent: 4_000, locationId: 7 }),
                record({ monthly_rent: 5_000, locationId: null }),
                record({ monthly_rent: 6_000, locationId: 999 }),
            ]),
            analysisWindow: { minMonth: '2025-01', maxMonth: '2026-08' },
        };
        const model = buildRentalOverviewModel(source, '4 room', rectangleSelection(1.29, 103.79, 1.31, 103.81));

        expect(model.records.map((row) => row.monthly_rent)).toEqual([3_000, 3_200]);
        expect(model.summary?.count).toBe(2);
        expect(model.unresolvedExcluded).toBe(2);
        expect(model.selected).toBe(true);
    });

    it('returns rental-specific empty selection data for a circle with no matches', () => {
        const source = { dataset: dataset([record()]), analysisWindow: null };
        const model = buildRentalOverviewModel(source, '4 ROOM', circleSelection(1.5, 104, 10));
        expect(model.records).toEqual([]);
        expect(model.summary).toBeNull();
        expect(model.selected).toBe(true);
    });
});

describe('rental overview source', () => {
    it('notifies subscribers when the dataset or window changes', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeRentalOverviewSource(listener);
        const value = dataset([record()]);
        publishRentalOverviewSource(value, { minMonth: '2026-01', maxMonth: '2026-08' });
        unsubscribe();
        publishRentalOverviewSource(null, null);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toEqual({
            dataset: value,
            analysisWindow: { minMonth: '2026-01', maxMonth: '2026-08' },
        });
    });
});
