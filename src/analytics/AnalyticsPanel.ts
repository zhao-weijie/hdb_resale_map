/**
 * AnalyticsPanel - Orchestrates analytics components and manages overall panel state
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { RadialSelection } from '../tools/RadialSelection';
import { appState } from '../state/AppState';
import { applyFilters } from '../utils/filters';

// Import component classes
import { LocationCard } from '../components/LocationCard';
import { FiltersCard } from '../components/FiltersCard';
import { MopFiltersCard } from '../components/MopFiltersCard';
import { OverviewTab } from '../components/OverviewTab';

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
    private currentTransactions: HDBTransaction[] | null = null;
    private startDragLat: number | null = null;
    private startDragLng: number | null = null;

    // Popup pagination state
    private readonly PAGE_SIZE = 5;
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
        this.radialSelection = new RadialSelection(dataLoader);

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

    render(): void {
        this.container.innerHTML = `
      <div class="resize-handle" title="Drag to resize"></div>
      
      <div class="panel-content">
        <!-- Header -->
        <div class="analytics-header">
            <h2><i data-lucide="bar-chart-2"></i> Analytics <span style="font-size: 14px; font-weight: normal; color: var(--color-text-muted); margin-left: auto;" id="record-count"></span></h2>
        </div>
      
        <!-- Card 1: Location (Component) -->
        ${this.locationCard.render()}

        <!-- Card 2: Global Filters (Component) -->
        ${this.filtersCard.render()}

        <!-- Card 2b: MOP Filters -->
        ${this.mopFiltersCard.render()}

        <!-- Card 3: Color Mode -->
        <div class="card">
             <div class="input-wrapper">
                 <label style="margin-bottom: 4px; display:block;">Color Map By</label>
                 <select id="color-mode-select">
                    <option value="price_psf">Price per SqFt</option>
                    <option value="price">Resale Price</option>
                 </select>
             </div>
        </div>
      
        <!-- Card 4: Stats & Chart -->
        <div class="card" style="flex: 1; display: flex; flex-direction: column;">
            ${this.overviewTab.render()}
        </div>

        <!-- Panel Toggle (Absolute) -->
        <button id="panel-toggle" class="panel-toggle" aria-label="Toggle Panel">
            <i data-lucide="chevron-left"></i>
        </button>

      </div>
    `;

        // Initialize Lucide Icons
        // @ts-ignore
        if (window.lucide) {
            // @ts-ignore
            window.lucide.createIcons();
        }

        this.attachEventListeners();
        const initialData = this.currentTransactions ?? this.getGlobalFilteredData();
        this.renderStats(initialData);
        this.renderChart(initialData);
    }

    private attachEventListeners(): void {
        // Color mode toggle
        const colorModeSelect = document.getElementById('color-mode-select') as HTMLSelectElement;
        // Restore saved color mode
        try {
            const savedColorMode = localStorage.getItem('hdb_colorMode');
            if (savedColorMode && colorModeSelect) {
                colorModeSelect.value = savedColorMode;
                this.mapView.setColorMode(savedColorMode as any);
            }
        } catch (_) { /* localStorage unavailable */ }
        colorModeSelect?.addEventListener('change', () => {
            this.mapView.setColorMode(colorModeSelect.value as any);
            try { localStorage.setItem('hdb_colorMode', colorModeSelect.value); } catch (_) {}
        });

        // Panel Toggle
        const toggleBtn = document.getElementById('panel-toggle');
        toggleBtn?.addEventListener('click', () => {
            this.container.classList.toggle('collapsed');
        });

        // Bind component events
        this.locationCard.bindEvents((selected) => this.updateSelectionState(selected));
        this.filtersCard.bindEvents((filtered) => this.onFiltersApplied(filtered));
        this.mopFiltersCard.bindEvents();

        // Bind remaining panel events
        this.bindMapEvents();
        this.bindResizeEvents();
        this.bindTooltipEvents();
    }

    private onFiltersApplied(filtered: HDBTransaction[]): void {
        // Clear current user selection as it might be invalid now
        this.currentTransactions = null;
        this.radialSelection.clearSelection();

        // Update stats with filtered overview
        this.renderStats(filtered);
        this.renderChart(filtered);

        // Update status text
        const countSpan = document.getElementById('record-count');
        if (countSpan) countSpan.textContent = `(${filtered.length.toLocaleString()} records)`;
    }

    private updateSelectionState(selected: HDBTransaction[] | null): void {
        // Apply global filters to the selection for consistency
        const filteredSelection = selected ? this.applyFiltersToTransactions(selected) : null;
        this.currentTransactions = filteredSelection;
        this.mapView.setSelectedTransactions(filteredSelection);

        let dataToRender = filteredSelection;
        if (!dataToRender) {
            dataToRender = this.getGlobalFilteredData();
        }

        this.renderStats(dataToRender);
        this.renderChart(dataToRender);
    }

    private applyFiltersToTransactions(transactions: HDBTransaction[]): HDBTransaction[] {
        return applyFilters(transactions, appState.get('globalFilters'));
    }

    private getGlobalFilteredData(): HDBTransaction[] {
        return appState.get('filteredTransactions');
    }

    private renderStats(data?: HDBTransaction[]): void {
        const dataToRender = data || this.getGlobalFilteredData();
        this.overviewTab.renderStats(dataToRender);

        const countSpan = document.getElementById('record-count');
        if (countSpan) countSpan.textContent = `(${dataToRender.length.toLocaleString()} records)`;
    }

    private renderChart(data?: HDBTransaction[]): void {
        const dataToRender = data || this.getGlobalFilteredData();
        void this.overviewTab.renderChart(dataToRender);
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
        this.mapView.setOnPointClick((lat, lng, clicked) => {
            if (this.locationCard.getIsSelectionModeActive()) {
                return;
            }

            if (!clicked) return;

            const relevant = applyFilters(
                this.dataLoader.getTransactionsForBlock(clicked.block, clicked.street_name),
                appState.get('globalFilters')
            );

            if (relevant.length === 0) return;

            relevant.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());

            const geocodeKey = `${clicked.block}|${clicked.street_name}`;
            const geocodeData = this.geocodeCache?.[geocodeKey];
            const postal = geocodeData?.postal || '';
            const title = postal
                ? `Blk ${clicked.block} ${clicked.street_name} • ${postal}`
                : `Blk ${clicked.block} ${clicked.street_name}`;

            const currentYear = new Date().getFullYear();
            const leaseCommenceYear = Number(clicked.lease_commence_date);
            const currentLease = 99 - (currentYear - leaseCommenceYear);
            const mrt = clicked.mrt_distance_m ? `${Math.round(clicked.mrt_distance_m)}m to MRT` : '';
            const subtitle = currentLease > 0
                ? [currentLease > 0 ? `${currentLease} yrs lease` : '', mrt].filter(Boolean).join(' • ')
                : '';

            this.popupTransactions = relevant;
            this.popupMeta = { lat, lng, title, subtitle, geocodeKey };
            this.renderTransactionPopup(0);

            if (!this.geocodeCache) {
                void this.ensureGeocodeCache().then(() => {
                    if (this.popupMeta?.geocodeKey !== geocodeKey) return;
                    const loadedPostal = this.geocodeCache?.[geocodeKey]?.postal;
                    if (!loadedPostal) return;
                    this.popupMeta.title = `Blk ${clicked.block} ${clicked.street_name} • ${loadedPostal}`;
                    this.renderTransactionPopup(0);
                });
            }
        });

        // 3. Popup pagination — single delegated listener on document
        document.addEventListener('click', (e: MouseEvent) => {
            const btn = (e.target as HTMLElement).closest('[data-popup-page]') as HTMLElement | null;
            if (!btn) return;
            const page = parseInt(btn.dataset.popupPage!, 10);
            this.renderTransactionPopup(page);
        });

        // 4. Drag Selection
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
                    let selected: HDBTransaction[] | null = null;

                    if (appState.get('selectionMode') === 'radial') {
                        const radius = this.calculateDistance(this.startDragLat, this.startDragLng, lat, lng);
                        this.radialSelection.setSelection(this.startDragLat, this.startDragLng, radius);
                        selected = this.radialSelection.getSelectedTransactions();

                        const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
                        if (radiusInput) radiusInput.value = Math.round(radius).toString();
                    } else {
                        const minLat = Math.min(this.startDragLat, lat);
                        const maxLat = Math.max(this.startDragLat, lat);
                        const minLng = Math.min(this.startDragLng, lng);
                        const maxLng = Math.max(this.startDragLng, lng);
                        selected = this.dataLoader.queryRectangle(minLat, minLng, maxLat, maxLng);
                    }

                    // Clear postal input since user drew a selection manually
                    const postalInput = document.getElementById('postal-input') as HTMLInputElement;
                    if (postalInput) postalInput.value = '';

                    this.updateSelectionState(selected);
                    this.locationCard.setSelectionMode(false);
                }
            }
        });
    }

    private renderTransactionPopup(page: number): void {
        if (!this.popupMeta) return;
        const html = this.buildTransactionPopupHTML(page);
        this.mapView.showPopup(this.popupMeta.lat, this.popupMeta.lng, html);
    }

    private buildTransactionPopupHTML(page: number): string {
        const { title, subtitle } = this.popupMeta!;
        const total = this.popupTransactions.length;
        const totalPages = Math.ceil(total / this.PAGE_SIZE);
        const slice = this.popupTransactions.slice(page * this.PAGE_SIZE, (page + 1) * this.PAGE_SIZE);

        const rows = slice.map(t => {
            const psf = t.resale_price / (t.floor_area_sqm * 10.7639);
            return `<tr>
                <td>${new Date(t.transaction_date).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</td>
                <td>${t.flat_type}</td>
                <td>${t.storey_range}</td>
                <td>$${(t.resale_price / 1000).toFixed(0)}k</td>
                <td>$${Math.round(psf)}</td>
            </tr>`;
        }).join('');

        const nav = totalPages > 1 ? `
            <div class="popup-nav">
                ${page > 0
                    ? `<button class="popup-nav-btn" data-popup-page="${page - 1}">← Prev</button>`
                    : `<span></span>`}
                <span class="popup-nav-info">${page + 1} / ${totalPages}</span>
                ${page < totalPages - 1
                    ? `<button class="popup-nav-btn" data-popup-page="${page + 1}">Next →</button>`
                    : `<span></span>`}
            </div>` : '';

        return `
            <div class="popover-header">
                <div class="popover-title">${title}</div>
                ${subtitle ? `<div class="popover-subtitle">${subtitle}</div>` : ''}
            </div>
            <div class="popover-body">
                <table class="popover-table">
                    <thead><tr><th>Date</th><th>Type</th><th>Floor</th><th>Price</th><th>PSF</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                ${nav}
            </div>`;
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
        this.currentTransactions = filtered;

        this.renderStats(filtered);
        this.renderChart(filtered);
    }
}
