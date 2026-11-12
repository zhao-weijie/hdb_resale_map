/**
 * AnalyticsPanel - Orchestrates analytics components and manages overall panel state
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { RadialSelection } from '../tools/RadialSelection';
import { appState } from '../state/AppState';
import { applyFilters } from '../utils/filters';
import { rectangleSelection } from '../spatial/selection';
import {
    buildRentalOverviewModel,
    getRentalOverviewSource,
    subscribeRentalOverviewSource,
} from './rentalOverview';

// Import component classes
import { LocationCard } from '../components/LocationCard';
import { FiltersCard } from '../components/FiltersCard';
import { MopFiltersCard } from '../components/MopFiltersCard';
import { OverviewTab } from '../components/OverviewTab';
import { TransactionTable } from '../components/TransactionTable';

export class AnalyticsPanel {
    private container: HTMLElement;
    private dataLoader: DataLoader;
    private mapView: MapView;
    private radialSelection: RadialSelection;
    private geocodeCache: Record<string, { postal?: string; address?: string }> | null = null;
    private geocodeCachePromise: Promise<void> | null = null;

    // Component instances
    private locationCard: LocationCard;
    private filtersCard: FiltersCard;
    private mopFiltersCard: MopFiltersCard;
    private overviewTab: OverviewTab;

    // Local state
    private viewportTransactions: HDBTransaction[] | null = null;
    private startDragLat: number | null = null;
    private startDragLng: number | null = null;

    // Popup pagination state
    private popupTransactions: HDBTransaction[] = [];
    private popupMeta: { lat: number; lng: number; title: string; subtitle: string; geocodeKey: string } | null = null;

    constructor(containerId: string, dataLoader: DataLoader, mapView: MapView) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Container ${containerId} not found`);
        }
        this.container = container;
        this.dataLoader = dataLoader;
        this.mapView = mapView;
        this.radialSelection = new RadialSelection();

        // Initialize components
        this.locationCard = new LocationCard(mapView, this.radialSelection);
        this.filtersCard = new FiltersCard(dataLoader, mapView);
        this.mopFiltersCard = new MopFiltersCard();
        this.overviewTab = new OverviewTab();
    }

    private async loadGeocodeCache(): Promise<void> {
        try {
            const response = await fetch('data/addresses_geocoded.json');
            if (response.ok) {
                const cache = await response.json() as Record<string, { postal?: string; address?: string }>;
                this.geocodeCache = cache;
                console.log(`✓ Loaded ${Object.keys(cache).length} geocoded addresses`);
            } else {
                throw new Error(`Failed to load geocode cache: ${response.status}`);
            }
        } catch (error) {
            console.warn('Failed to load geocode cache:', error);
            this.geocodeCache = {};
        }
    }

    private ensureGeocodeCache(): Promise<void> {
        if (!this.geocodeCachePromise) {
            this.geocodeCachePromise = this.loadGeocodeCache();
        }
        return this.geocodeCachePromise;
    }

    render(openTracker?: () => void): void {
        this.container.innerHTML = `
      <div class="resize-handle" title="Drag to resize"></div>

      <!-- Keep the toggle outside the scrolling panel content. -->
      <button type="button" id="panel-toggle" class="panel-toggle" aria-label="Toggle map panel" aria-expanded="true" aria-controls="analytics-panel-content">
          <span class="panel-toggle-chevron" aria-hidden="true"><i data-lucide="chevron-left"></i></span>
      </button>
      
      <div id="analytics-panel-content" class="drawer-content">
        <nav class="drawer-destinations" aria-label="Map views"${openTracker ? '' : ' hidden'}>
          <button type="button" data-destination="analytics" aria-current="page">Analytics</button>
          <button type="button" data-destination="tracker"><i data-lucide="bookmark"></i> Saved homes</button>
        </nav>
        <div id="public-analytics" class="panel-content">
        <!-- Header -->
        <div class="analytics-header">
            <h2><i data-lucide="bar-chart-2"></i> Analytics <span style="font-size: 14px; font-weight: normal; color: var(--color-text-muted); margin-left: auto;" id="record-count"></span></h2>
        </div>
      
        <!-- Location (Component) -->
        ${this.locationCard.render()}

        <!-- Global Filters (Component) -->
        ${this.filtersCard.render()}

        <!-- MOP Filters -->
        ${this.mopFiltersCard.render()}
      
        <div id="rental-analysis-slot"></div>
        <div id="tracker-layer-setting" hidden></div>

        <!-- Stats & Chart -->
        <div class="card" style="flex: 1; display: flex; flex-direction: column;">
            ${this.overviewTab.render()}
        </div>
        </div>
        <div id="tracker-panel" class="panel-content" hidden></div>
        <div id="tracker-comparison" class="panel-content" hidden></div>
      </div>

    `;

        // Initialize Lucide Icons
        // @ts-ignore
        if (window.lucide) {
            // @ts-ignore
            window.lucide.createIcons();
        }

        this.attachEventListeners();
        this.container.querySelector('[data-destination="analytics"]')?.addEventListener('click', () => this.showDestination('analytics'));
        this.container.querySelector('[data-destination="tracker"]')?.addEventListener('click', () => {
            this.showDestination('tracker');
            openTracker?.();
        });
        this.renderOverview();
    }

    showDestination(destination: 'analytics' | 'tracker' | 'comparison'): void {
        const content = this.container.querySelector<HTMLElement>('.drawer-content');
        if (!content) return;
        for (const [id, active] of [
            ['public-analytics', destination === 'analytics'],
            ['tracker-panel', destination === 'tracker'],
            ['tracker-comparison', destination === 'comparison']
        ] as const) {
            const view = content.querySelector<HTMLElement>(`#${id}`);
            if (view) view.hidden = !active;
        }
        const navigation = content.querySelector('nav');
        if (navigation) navigation.hidden = destination === 'comparison';
        for (const button of navigation?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
            if (button.dataset.destination === destination) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        }
        this.setCollapsed(false);
    }

    private setCollapsed(collapsed: boolean): void {
        this.container.classList.toggle('collapsed', collapsed);
        this.container.querySelector('#panel-toggle')?.setAttribute('aria-expanded', String(!collapsed));
        const content = this.container.querySelector<HTMLElement>('.drawer-content');
        if (content) content.inert = collapsed;
    }

    private attachEventListeners(): void {
        // Color mode toggle
        const colorModeSelect = document.getElementById('color-mode-select') as HTMLSelectElement;
        // Restore saved color mode
        try {
            const savedColorMode = localStorage.getItem('hdb_colorMode');
            if (savedColorMode && colorModeSelect && [...colorModeSelect.options].some((option) => option.value === savedColorMode)) {
                colorModeSelect.value = savedColorMode;
                this.mapView.setColorMode(savedColorMode as any);
            }
        } catch (_) { /* localStorage unavailable */ }
        colorModeSelect?.addEventListener('change', () => {
            this.mapView.setColorMode(colorModeSelect.value as any);
            try { localStorage.setItem('hdb_colorMode', colorModeSelect.value); } catch (_) {}
        });
        appState.subscribe('colorMode', (mode) => {
            if (colorModeSelect && colorModeSelect.value !== mode) colorModeSelect.value = mode;
            this.renderOverview();
        });
        appState.subscribe('rentalActiveFlatType', () => this.renderOverview());
        appState.subscribe('selectedTransactions', () => {
            // Selection and filter transitions invalidate the mobile viewport cache.
            this.viewportTransactions = null;
            this.renderOverview();
        });
        subscribeRentalOverviewSource(() => this.renderOverview());

        // Panel Toggle
        const toggleBtn = document.getElementById('panel-toggle');
        toggleBtn?.addEventListener('click', () => {
            this.setCollapsed(!this.container.classList.contains('collapsed'));
        });

        // Bind component events
        this.locationCard.bindEvents();
        this.filtersCard.bindEvents();
        this.mopFiltersCard.bindEvents();

        // Bind remaining panel events
        this.bindMapEvents();
        this.bindResizeEvents();
        this.bindTooltipEvents();
    }

    private applyFiltersToTransactions(transactions: HDBTransaction[]): HDBTransaction[] {
        return applyFilters(transactions, appState.get('globalFilters'));
    }

    private getGlobalFilteredData(): HDBTransaction[] {
        return appState.get('filteredTransactions');
    }

    private renderOverview(data?: HDBTransaction[]): void {
        const mode = appState.get('colorMode');
        if (mode !== 'price' && mode !== 'price_psf') {
            const model = buildRentalOverviewModel(
                getRentalOverviewSource(),
                appState.get('rentalActiveFlatType'),
                appState.get('spatialSelection'),
            );
            this.overviewTab.renderRentalStats(model);
            void this.overviewTab.renderRentalChart(model);
            this.updateRecordCount(model.records.length);
            return;
        }
        const dataToRender = data
            ?? appState.get('selectedTransactions')
            ?? this.viewportTransactions
            ?? this.getGlobalFilteredData();
        this.overviewTab.renderStats(dataToRender);
        void this.overviewTab.renderChart(dataToRender);
        this.updateRecordCount(dataToRender.length);
    }

    private updateRecordCount(count: number): void {
        const countSpan = document.getElementById('record-count');
        if (countSpan) countSpan.textContent = `(${count.toLocaleString()} records)`;
    }

    private bindTooltipEvents(): void {
        const tooltip = document.createElement('div');
        tooltip.className = 'js-fixed-tooltip';
        document.body.appendChild(tooltip);

        const showTooltip = (e: MouseEvent, text: string) => {
            tooltip.textContent = text;
            tooltip.style.display = 'block';

            const rect = (e.target as HTMLElement).getBoundingClientRect();
            let top = rect.top - tooltip.offsetHeight - 8;
            let left = rect.left + (rect.width / 2) - (tooltip.offsetWidth / 2);

            if (top < 10) top = rect.bottom + 8;
            if (left < 10) left = 10;
            if (left + tooltip.offsetWidth > window.innerWidth - 10) {
                left = window.innerWidth - tooltip.offsetWidth - 10;
            }

            tooltip.style.top = `${top}px`;
            tooltip.style.left = `${left}px`;
            tooltip.classList.add('visible');
        };

        const hideTooltip = () => {
            tooltip.classList.remove('visible');
            tooltip.style.display = 'none';
        };

        this.container.addEventListener('mouseover', (e: Event) => {
            const target = e.target as HTMLElement;
            const tooltipTarget = target.closest('[data-tooltip]');
            if (tooltipTarget) {
                const text = tooltipTarget.getAttribute('data-tooltip');
                if (text) showTooltip(e as MouseEvent, text);
            }
        });

        this.container.addEventListener('mouseout', (e: Event) => {
            const target = e.target as HTMLElement;
            if (target.closest('[data-tooltip]')) {
                hideTooltip();
            }
        });
    }

    private bindResizeEvents(): void {
        const handle = this.container.querySelector('.resize-handle') as HTMLElement;
        if (!handle) return;

        let startX: number;
        let startWidth: number;

        const onMouseMove = (e: MouseEvent) => {
            const newWidth = startWidth + (e.clientX - startX);
            if (newWidth >= 300 && newWidth <= 800) {
                this.container.style.width = `${newWidth}px`;
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            startX = e.clientX;
            startWidth = this.container.getBoundingClientRect().width;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
    }

    private bindMapEvents(): void {
        // 1. Mobile Viewport Tracking
        let debounceTimer: any = null;
        this.mapView.setOnMapMove(() => {
            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    this.updateMobileViewportStats();
                }, 500);
            }
        });

        // 2. Point Click Handler
        this.mapView.setOnPointClick((lat, lng, clicked) => this.openBlockSales(lat, lng, clicked));

        // 3. Drag Selection
        this.mapView.setOnDragSelection({
            onStart: (lat, lng) => {
                this.startDragLat = lat;
                this.startDragLng = lng;

                if (appState.get('selectionMode') === 'radial') {
                    this.mapView.updateSelectionCircle(lat, lng, 0);
                }
            },
            onMove: (lat, lng) => {
                if (this.startDragLat !== null && this.startDragLng !== null) {
                    if (appState.get('selectionMode') === 'radial') {
                        const radius = this.calculateDistance(this.startDragLat, this.startDragLng, lat, lng);
                        this.mapView.updateSelectionCircle(this.startDragLat, this.startDragLng, radius);
                    } else {
                        this.mapView.updateSelectionRect(this.startDragLat, this.startDragLng, lat, lng);
                    }
                }
            },
            onEnd: (lat, lng) => {
                if (this.startDragLat !== null && this.startDragLng !== null) {
                    if (appState.get('selectionMode') === 'radial') {
                        const radius = this.calculateDistance(this.startDragLat, this.startDragLng, lat, lng);
                        this.radialSelection.setSelection(this.startDragLat, this.startDragLng, radius);

                        const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
                        if (radiusInput) radiusInput.value = Math.round(radius).toString();
                    } else {
                        appState.setSpatialSelection(rectangleSelection(
                            this.startDragLat,
                            this.startDragLng,
                            lat,
                            lng
                        ));
                    }

                    // Clear postal input since user drew a selection manually
                    const postalInput = document.getElementById('postal-input') as HTMLInputElement;
                    if (postalInput) postalInput.value = '';

                    this.locationCard.setSelectionMode(false);
                }
            }
        });
    }

    openBlockSales(lat: number, lng: number, clicked: HDBTransaction): void {
        if (this.locationCard.getIsSelectionModeActive() || !clicked) return;
        const relevant = this.applyFiltersToTransactions(
            this.dataLoader.getTransactionsForBlock(clicked.block, clicked.street_name));
        if (!relevant.length) return;
        relevant.sort((a, b) => b.transaction_date.getTime() - a.transaction_date.getTime());

        const geocodeKey = `${clicked.block}|${clicked.street_name}`;
        const title = `Blk ${clicked.block} ${clicked.street_name}`;
        const postal = this.geocodeCache?.[geocodeKey]?.postal;
        const lease = 99 - (new Date().getFullYear() - Number(clicked.lease_commence_date));
        const mrt = clicked.mrt_distance_m ? `${Math.round(clicked.mrt_distance_m)}m to MRT` : '';
        const subtitle = lease > 0 ? [`${lease} yrs lease`, mrt].filter(Boolean).join(' • ') : '';
        this.popupTransactions = relevant;
        this.popupMeta = { lat, lng, title: postal ? `${title} • ${postal}` : title, subtitle, geocodeKey };
        this.renderTransactionPopup();

        if (!this.geocodeCache) {
            const popup = this.popupMeta;
            void this.ensureGeocodeCache().then(() => {
                if (this.popupMeta !== popup) return;
                const loadedPostal = this.geocodeCache?.[geocodeKey]?.postal;
                if (!loadedPostal) return;
                popup.title = `${title} • ${loadedPostal}`;
                this.renderTransactionPopup();
            });
        }
    }

    private renderTransactionPopup(): void {
        if (!this.popupMeta) return;
        const table = new TransactionTable(this.popupTransactions, { pageSize: 5 });
        const { title, subtitle } = this.popupMeta;
        const html = `<div class="popover-header"><div class="popover-title">${title}</div>${subtitle ? `<div class="popover-subtitle">${subtitle}</div>` : ''}</div><div class="popover-body">${table.markup()}</div>`;
        this.mapView.showPopup(this.popupMeta.lat, this.popupMeta.lng, html);
        requestAnimationFrame(() => table.mount(document.body));
    }

    private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lng2 - lng1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    private updateMobileViewportStats(): void {
        const bounds = this.mapView.getBounds();
        if (!bounds) return;

        const inView = this.dataLoader.queryRectangle(bounds.south, bounds.west, bounds.north, bounds.east);
        const filtered = this.applyFiltersToTransactions(inView);
        this.viewportTransactions = filtered;

        this.renderOverview(filtered);
    }
}
