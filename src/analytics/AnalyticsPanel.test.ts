import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsPanel } from './AnalyticsPanel';
import { OverviewTab } from '../components/OverviewTab';
import { PostalSearch } from '../tools/PostalSearch';
import { appState } from '../state/AppState';
import * as rentalOverview from './rentalOverview';
import { circleSelection, rectangleSelection } from '../spatial/selection';
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';

// The DOM shell and rendering sinks are stand-ins; panel/card events and state are real.
function element(value = '') {
    const handlers = new Map<string, (event: any) => unknown>();
    return {
        value, checked: true, innerHTML: '', textContent: '', style: {}, dataset: { mode: '' },
        classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        addEventListener: (name: string, handler: (event: any) => unknown) => handlers.set(name, handler),
        querySelector: () => null,
        closest: () => ({ style: {} }),
        fire: (name: string) => handlers.get(name)?.({}),
    };
}

describe('Analytics selection publication', () => {
    const unsubscribe: (() => void)[] = [];
    const transaction = (latitude: number, floor = '07 TO 09'): HDBTransaction => ({
        latitude, longitude: 103.8, flat_type: '4 ROOM', storey_range: floor,
        remaining_lease_years: 70, transaction_date: new Date('2025-06-01'),
    } as HDBTransaction);
    const inside = transaction(1.3001);
    const nearby = transaction(1.305, '01 TO 03');
    const outside = transaction(1.5);
    const all = [inside, nearby, outside];

    beforeEach(() => {
        appState.set('globalFilters', { date: 'all', flatTypes: ['4 ROOM'], leaseMin: 0, leaseMax: 99, floorMin: 1 });
        appState.set('filteredTransactions', all);
        appState.set('colorMode', 'price_psf');
        const subscribeState = appState.subscribe.bind(appState);
        vi.spyOn(appState, 'subscribe').mockImplementation((key, callback) => {
            const stop = subscribeState(key, callback);
            unsubscribe.push(stop);
            return stop;
        });
        const subscribeSource = rentalOverview.subscribeRentalOverviewSource;
        vi.spyOn(rentalOverview, 'subscribeRentalOverviewSource').mockImplementation((callback) => {
            const stop = subscribeSource(callback);
            unsubscribe.push(stop);
            return stop;
        });
    });

    afterEach(() => {
        unsubscribe.splice(0).forEach((stop) => stop());
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    function mount() {
        const elements = new Map([
            ['panel', element()], ['record-count', element()],
            ['postal-input', element()], ['radius-input', element('500')],
            ['search-btn', element()], ['clear-selection-btn', element()], ['select-area-btn', element()],
            ['filter-date', element('all')], ['filter-lease-min', element('0')],
            ['filter-lease-max', element('99')], ['filter-floor-min', element('1')],
            ['apply-filters-btn', element()], ['filter-load-status', element()],
        ]);
        const circleTool = element(); circleTool.dataset.mode = 'radial';
        const boxTool = element(); boxTool.dataset.mode = 'rect';
        const flatType = element('4 ROOM');
        vi.stubGlobal('window', { innerWidth: 375 });
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements.get(id) ?? null,
            querySelectorAll: (selector: string) => selector === '.mode-btn' ? [circleTool, boxTool]
                : selector.startsWith('#filter-flat-type') ? [flatType] : [],
            createElement: () => element(),
            body: { appendChild: vi.fn() },
        });
        const stats = vi.spyOn(OverviewTab.prototype, 'renderStats').mockImplementation(() => {});
        vi.spyOn(OverviewTab.prototype, 'renderChart').mockResolvedValue(undefined);
        vi.spyOn(OverviewTab.prototype, 'renderRentalStats').mockImplementation(() => {});
        vi.spyOn(OverviewTab.prototype, 'renderRentalChart').mockResolvedValue(undefined);
        let move = () => {};
        let drag!: { onStart(lat: number, lng: number): void; onMove(lat: number, lng: number): void; onEnd(lat: number, lng: number): void };
        const loader = {
            queryRectangle: vi.fn(() => [outside]),
            getAllData: vi.fn(() => all),
            ensureDateRange: vi.fn().mockResolvedValue(undefined),
        };
        const map = {
            setOnMapMove: (callback: () => void) => { move = callback; },
            setOnPointClick: vi.fn(),
            setOnDragSelection: (callbacks: typeof drag) => { drag = callbacks; },
            setSelectionMode: vi.fn(), setSelectionType: vi.fn(), flyTo: vi.fn(),
            updateSelectionCircle: (lat: number, lng: number, radius: number) => appState.setSpatialSelection(circleSelection(lat, lng, radius)),
            updateSelectionRect: (a: number, b: number, c: number, d: number) => appState.setSpatialSelection(rectangleSelection(a, b, c, d)),
            setFilteredData: (rows: HDBTransaction[]) => appState.set('filteredTransactions', rows),
            getBounds: () => ({ south: 1.49, west: 103.79, north: 1.51, east: 103.81 }),
        };
        new AnalyticsPanel('panel', loader as unknown as DataLoader, map as unknown as MapView).render();
        return {
            elements, loader, map, drag, circleTool, boxTool, stats,
            move: () => move(),
            rows: () => stats.mock.lastCall?.[0],
        };
    }

    it('updates overview rows during circle creation and radius changes without corrective callbacks', async () => {
        const view = mount();
        view.drag.onStart(1.3, 103.8);
        view.drag.onMove(1.301, 103.8);
        view.drag.onEnd(1.301, 103.8);
        expect(view.rows()).toEqual([inside]);
        const radius = view.elements.get('radius-input')!;
        radius.value = '1000';
        await radius.fire('change');
        expect(view.rows()).toEqual([inside, nearby]);
        radius.value = '1';
        await radius.fire('change');
        expect(view.rows()).toEqual([]);
        expect(appState.get('spatialSelection').kind).toBe('circle');
    });

    it('discards the previous selection when geometry is cleared, including later metric switches', () => {
        const view = mount();
        view.drag.onStart(1.3, 103.8);
        view.drag.onEnd(1.301, 103.8);
        expect(view.rows()).toEqual([inside]);
        appState.clearSpatialSelection();
        expect(view.rows()).toEqual(all);
        appState.set('colorMode', 'price');
        expect(view.rows()).toEqual(all);
        appState.set('colorMode', 'price_psf');
        expect(view.rows()).toEqual(all);
    });

    it('uses one authoritative selection for search, tool switches and the Clear button', async () => {
        const view = mount();
        appState.set('selectionMode', 'radial');
        view.elements.get('postal-input')!.value = '085101';
        vi.spyOn(PostalSearch, 'search').mockResolvedValue({ LATITUDE: '1.3', LONGITUDE: '103.8' } as Awaited<ReturnType<typeof PostalSearch.search>>);
        await view.elements.get('search-btn')!.fire('click');
        const selection = appState.get('spatialSelection');
        expect(view.rows()).toEqual([inside]);
        expect(view.loader.getAllData).not.toHaveBeenCalled();
        await view.boxTool.fire('click');
        await view.circleTool.fire('click');
        expect(appState.get('spatialSelection')).toBe(selection);
        expect(view.rows()).toEqual([inside]);
        await view.elements.get('clear-selection-btn')!.fire('click');
        expect(appState.get('spatialSelection')).toEqual({ kind: 'none' });
        expect(view.rows()).toEqual(all);
        expect(view.elements.get('postal-input')!.value).toBe('');
    });

    it('publishes new filtered rows after clearing a rectangle without a panel repair', async () => {
        const view = mount();
        appState.setSpatialSelection(rectangleSelection(1.29, 103.79, 1.31, 103.81));
        expect(view.rows()).toEqual([inside, nearby]);
        view.elements.get('filter-floor-min')!.value = '7';
        await view.elements.get('apply-filters-btn')!.fire('click');
        await vi.waitFor(() => expect(appState.get('filteredTransactions')).toEqual([inside, outside]));
        expect(appState.get('spatialSelection')).toEqual({ kind: 'none' });
        expect(view.rows()).toEqual([inside, outside]);
        appState.set('colorMode', 'price');
        expect(view.rows()).toEqual([inside, outside]);
    });

    it('retains mobile viewport updates and invalidates their cache on selection transitions', () => {
        vi.useFakeTimers();
        const view = mount();
        view.move();
        vi.advanceTimersByTime(500);
        expect(view.rows()).toEqual([outside]);
        appState.set('colorMode', 'price');
        expect(view.rows()).toEqual([outside]);
        appState.setSpatialSelection(circleSelection(1.3, 103.8, 500));
        expect(view.rows()).toEqual([inside]);
        view.move();
        vi.advanceTimersByTime(500);
        expect(view.rows()).toEqual([outside]);
        appState.set('colorMode', 'price_psf');
        expect(view.rows()).toEqual([inside]);
        appState.clearSpatialSelection();
        expect(view.rows()).toEqual(all);
        appState.set('colorMode', 'price');
        expect(view.rows()).toEqual(all);
    });
});
