/**
 * AnalyticsPanel - Orchestrates analytics components and manages overall panel state
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { RadialSelection } from '../tools/RadialSelection';
import { FairValueAnalysis } from './FairValueAnalysis';
import { appState } from '../state/AppState';

// Import component classes
import { LocationCard } from '../components/LocationCard';
import { FiltersCard } from '../components/FiltersCard';
import { OverviewTab } from '../components/OverviewTab';
import { FairValueTab } from '../components/FairValueTab';

export class AnalyticsPanel {
    private container: HTMLElement;
    private dataLoader: DataLoader;
    private mapView: MapView;
    private radialSelection: RadialSelection;
    private fairValueAnalysis: FairValueAnalysis;
    private geocodeCache: Record<string, { postal?: string; address?: string }> = {};

    // Component instances
    private locationCard: LocationCard;
    private filtersCard: FiltersCard;
    private overviewTab: OverviewTab;
    private fairValueTab: FairValueTab;

    // Local state
    private activeTab: 'overview' | 'fairvalue' = 'overview';
    private currentTransactions: HDBTransaction[] | null = null;
    private startDragLat: number | null = null;
    private startDragLng: number | null = null;

    constructor(containerId: string, dataLoader: DataLoader, mapView: MapView) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Container ${containerId} not found`);
        }
        this.container = container;
        this.dataLoader = dataLoader;
        this.mapView = mapView;
        this.radialSelection = new RadialSelection(dataLoader);
        this.fairValueAnalysis = new FairValueAnalysis();

        // Initialize components
        this.locationCard = new LocationCard(container, dataLoader, mapView, this.radialSelection);
        this.filtersCard = new FiltersCard(container, dataLoader, mapView);
        this.overviewTab = new OverviewTab();
        this.fairValueTab = new FairValueTab(this.fairValueAnalysis);
    }

    async init(): Promise<void> {
        await this.fairValueAnalysis.loadCoefficients();
        await this.loadGeocodeCache();
        this.showDataTreatmentToast();
    }

    private async loadGeocodeCache(): Promise<void> {
        try {
            const response = await fetch('data/addresses_geocoded.json');
            if (response.ok) {
                this.geocodeCache = await response.json();
                console.log(`✓ Loaded ${Object.keys(this.geocodeCache).length} geocoded addresses`);
            }
        } catch (error) {
            console.warn('Failed to load geocode cache:', error);
        }
    }

    private showDataTreatmentToast(): void {
        if (localStorage.getItem('hdb_data_treatment_shown')) return;

        const toast = document.createElement('div');
        toast.className = 'data-treatment-toast';
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-icon">ⓘ</span>
                <div class="toast-text">
                    <strong>Data Note:</strong> Historical prices are adjusted using the HDB Resale Price Index to enable fair comparison across time periods.
                </div>
                <button class="toast-close" aria-label="Dismiss">×</button>
            </div>
        `;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('show'), 100);

        toast.querySelector('.toast-close')?.addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
            localStorage.setItem('hdb_data_treatment_shown', 'true');
        });

        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
                localStorage.setItem('hdb_data_treatment_shown', 'true');
            }
        }, 15000);
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
      
        <!-- Card 4: Stats & Charts (Tabs with Components) -->
        <div class="card" style="flex: 1; display: flex; flex-direction: column;">
            <div class="tab-nav">
                <button class="tab-btn active" data-tab="overview">Overview</button>
                <button class="tab-btn" data-tab="fairvalue">Fair Value Analysis</button>
            </div>
            
            ${this.overviewTab.render()}
            ${this.fairValueTab.render()}
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
        this.attachTabListeners();
        this.renderStats();
    }

    private attachEventListeners(): void {
        // Color mode toggle
        const colorModeSelect = document.getElementById('color-mode-select') as HTMLSelectElement;
        colorModeSelect?.addEventListener('change', () => {
            this.mapView.setColorMode(colorModeSelect.value as any);
        });

        // Panel Toggle
        const toggleBtn = document.getElementById('panel-toggle');
        toggleBtn?.addEventListener('click', () => {
            this.container.classList.toggle('collapsed');
        });

        // Bind component events
        this.locationCard.bindEvents((selected) => this.updateSelectionState(selected));
        this.filtersCard.bindEvents((filtered) => this.onFiltersApplied(filtered));
        this.fairValueTab.bindEvents();

        // Bind remaining panel events
        this.bindMapEvents();
        this.bindResizeEvents();
        this.bindTooltipEvents();
    }

    private onFiltersApplied(filtered: HDBTransaction[]): void {
        // Clear current user selection as it might be invalid now
        this.radialSelection.clearSelection();
        this.mapView.clearSelectionCircle();
        this.mapView.clearSelectionRect();

        // Update stats with filtered overview
        this.renderStats(filtered);
        this.renderChart(filtered);

        // Update status text
        const countSpan = document.getElementById('record-count');
        if (countSpan) countSpan.textContent = `(${filtered.length.toLocaleString()} records)`;
    }

    private attachTabListeners(): void {
        const tabButtons = this.container.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = (btn as HTMLElement).dataset.tab as 'overview' | 'fairvalue';
                this.activeTab = tab;

                // Update UI
                tabButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const allTabs = this.container.querySelectorAll('.tab-content');
                allTabs.forEach(t => t.classList.remove('active'));

                const activeTabContent = document.getElementById(`tab-${tab}`);
                activeTabContent?.classList.add('active');

                // Render appropriate content
                if (tab === 'fairvalue') {
                    const dataToRender = this.currentTransactions || this.getGlobalFilteredData();
                    this.fairValueTab.renderFairValue(dataToRender);
                }
            });
        });
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

        // Always render fair value if active
        if (this.activeTab === 'fairvalue') {
            this.fairValueTab.renderFairValue(dataToRender);
        }
    }

    private applyFiltersToTransactions(transactions: HDBTransaction[]): HDBTransaction[] {
        const now = new Date();
        return transactions.filter(t => {
            if (!appState.get('globalFilters').flatTypes.includes(t.flat_type)) return false;
            if (t.remaining_lease_years < appState.get('globalFilters').leaseMin ||
                t.remaining_lease_years > appState.get('globalFilters').leaseMax) return false;
            if (appState.get('globalFilters').date !== 'all') {
                const txDate = new Date(t.transaction_date);
                const diffTime = Math.abs(now.getTime() - txDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (appState.get('globalFilters').date === '6m' && diffDays > 180) return false;
                if (appState.get('globalFilters').date === '1y' && diffDays > 365) return false;
                if (appState.get('globalFilters').date === '3y' && diffDays > 365 * 3) return false;
                if (appState.get('globalFilters').date === '5y' && diffDays > 365 * 5) return false;
            }
            return true;
        });
    }

    private getGlobalFilteredData(): HDBTransaction[] {
        const allData = this.dataLoader.getAllData();
        const now = new Date();

        return allData.filter(t => {
            if (!appState.get('globalFilters').flatTypes.includes(t.flat_type)) return false;
            if (t.remaining_lease_years < appState.get('globalFilters').leaseMin ||
                t.remaining_lease_years > appState.get('globalFilters').leaseMax) return false;
            if (appState.get('globalFilters').date !== 'all') {
                const txDate = new Date(t.transaction_date);
                const diffTime = Math.abs(now.getTime() - txDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (appState.get('globalFilters').date === '6m' && diffDays > 180) return false;
                if (appState.get('globalFilters').date === '1y' && diffDays > 365) return false;
                if (appState.get('globalFilters').date === '3y' && diffDays > 365 * 3) return false;
                if (appState.get('globalFilters').date === '5y' && diffDays > 365 * 5) return false;
            }
            return true;
        });
    }

    private renderStats(data?: HDBTransaction[]): void {
        const dataToRender = data || this.getGlobalFilteredData();
        this.overviewTab.renderStats(dataToRender);

        const countSpan = document.getElementById('record-count');
        if (countSpan) countSpan.textContent = `(${dataToRender.length.toLocaleString()} records)`;
    }

    private renderChart(data?: HDBTransaction[]): void {
        const dataToRender = data || this.getGlobalFilteredData();
        this.overviewTab.renderChart(dataToRender);
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
        this.mapView.setOnPointClick((lat, lng) => {
            if (this.locationCard.getIsSelectionModeActive()) {
                return;
            }

            const allData = this.dataLoader.getAllData();
            const clicked = allData.find(t =>
                Math.abs(t.latitude - lat) < 0.00001 &&
                Math.abs(t.longitude - lng) < 0.00001
            );

            if (!clicked) return;

            const relevant = allData.filter(t => {
                if (t.block !== clicked.block || t.street_name !== clicked.street_name) return false;
                if (!appState.get('globalFilters').flatTypes.includes(t.flat_type)) return false;
                if (t.remaining_lease_years < appState.get('globalFilters').leaseMin ||
                    t.remaining_lease_years > appState.get('globalFilters').leaseMax) return false;
                if (appState.get('globalFilters').date !== 'all') {
                    const now = new Date();
                    const txDate = new Date(t.transaction_date);
                    const diffTime = Math.abs(now.getTime() - txDate.getTime());
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    if (appState.get('globalFilters').date === '6m' && diffDays > 180) return false;
                    if (appState.get('globalFilters').date === '1y' && diffDays > 365) return false;
                    if (appState.get('globalFilters').date === '3y' && diffDays > 365 * 3) return false;
                    if (appState.get('globalFilters').date === '5y' && diffDays > 365 * 5) return false;
                }
                return true;
            });

            if (relevant.length === 0) return;

            relevant.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());
            const top5 = relevant.slice(0, 5);

            const geocodeKey = `${clicked.block}|${clicked.street_name}`;
            const geocodeData = this.geocodeCache[geocodeKey];
            const postal = geocodeData?.postal || '';
            const title = postal
                ? `Blk ${clicked.block} ${clicked.street_name} • ${postal}`
                : `Blk ${clicked.block} ${clicked.street_name}`;

            const currentYear = new Date().getFullYear();
            const leaseCommenceYear = Number(clicked.lease_commence_date);
            const currentLease = 99 - (currentYear - leaseCommenceYear);
            const mrt = clicked.mrt_distance_m ? `${Math.round(clicked.mrt_distance_m)}m to MRT` : '';

            const rows = top5.map(t => {
                const psf = t.resale_price / (t.floor_area_sqm * 10.7639);
                return `
                    <tr>
                        <td>${new Date(t.transaction_date).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</td>
                        <td>${t.flat_type}</td>
                        <td>${t.storey_range}</td>
                        <td>$${(t.resale_price / 1000).toFixed(0)}k</td>
                        <td>$${Math.round(psf)}</td>
                    </tr>
                `}).join('');

            const html = `
                <div class="popover-header">
                    <div class="popover-title">
                        ${title}
                        ${currentLease > 0 ? `<div class="popover-subtitle">${currentLease} yrs lease • ${mrt}</div>` : ''}
                    </div>
                </div>
                <div class="popover-body">
                    <table class="popover-table">
                        <thead><tr><th>Date</th><th>Type</th><th>Floor</th><th>Price</th><th>PSF</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                    ${relevant.length > 5 ? `<div class="popover-footer">${relevant.length - 5} more transactions</div>` : ''}
                </div>
            `;

            this.mapView.showPopup(lat, lng, html);
        });

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

        const allData = this.dataLoader.getAllData();
        const inView = allData.filter((t: HDBTransaction) =>
            t.latitude >= bounds.south && t.latitude <= bounds.north &&
            t.longitude >= bounds.west && t.longitude <= bounds.east
        );
        const filtered = this.applyFiltersToTransactions(inView);

        this.renderStats(filtered);
        this.renderChart(filtered);

        if (this.activeTab === 'fairvalue') {
            this.fairValueTab.renderFairValue(filtered);
        }
    }
}
