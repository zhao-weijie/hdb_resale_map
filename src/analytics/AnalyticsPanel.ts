/**
 * AnalyticsPanel - UI panel for data analysis and charting
 */

import { Chart, registerables } from 'chart.js';
import { BoxPlotController, BoxAndWiskers } from '@sgratzl/chartjs-chart-boxplot';
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { RadialSelection } from '../tools/RadialSelection';

import { FairValueAnalysis } from './FairValueAnalysis';
import { PostalSearch } from '../tools/PostalSearch';
import { haversineDistance } from '../utils/geo';
import { applyFilters, type GlobalFilters } from '../utils/filters';
import { appState } from '../state/AppState';


Chart.register(...registerables, BoxPlotController, BoxAndWiskers);

export class AnalyticsPanel {
    private container: HTMLElement;
    private dataLoader: DataLoader;
    private mapView: MapView;
    private radialSelection: RadialSelection;
    private fairValueAnalysis: FairValueAnalysis;
    private chart: Chart | null = null;
    private fairValueChart: Chart | null = null;
    private activeTab: 'overview' | 'fairvalue' = 'overview';
    private currentTransactions: HDBTransaction[] | null = null;
    private isSelectionModeActive = false;
    private selectedFeature: 'storey' | 'lease' | 'mrt' | 'flat_type' = 'storey';
    private geocodeCache: Record<string, { postal?: string; address?: string }> = {};

    // New State for Filters & Selection
    // (now managed via appState)

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
        // Only show once per user
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

        // Animate in
        setTimeout(() => toast.classList.add('show'), 100);

        // Close handler
        toast.querySelector('.toast-close')?.addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
            localStorage.setItem('hdb_data_treatment_shown', 'true');
        });

        // Auto-dismiss after 15 seconds
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
      
        <!-- Card 1: Location -->
        <div class="card">
            <h3 class="card-header"><i data-lucide="map-pin"></i> Location & Selection</h3>
            <div class="card-body">
                <!-- Input Group: Search + Radius -->
                <div class="input-row">
                    <div class="input-wrapper">
                        <button id="search-btn" class="input-icon-btn" title="Search">
                            <i data-lucide="search"></i>
                        </button>
                        <input type="text" id="postal-input" placeholder="Postal Code or Address" />
                    </div>
                    <div class="input-wrapper suffix" data-suffix="m" style="flex: 0 0 100px;">
                        <input type="number" id="radius-input" value="500" min="100" step="100" />
                    </div>
                </div>

                <!-- Selection Mode -->
                <div style="margin-top: 12px;">
                    <div class="segmented-control">
                        <button class="mode-btn active" data-mode="radial" style="flex: 1">Circle Selection</button>
                        <button class="mode-btn" data-mode="rect" style="flex: 1">Box Selection</button>
                    </div>
                </div>

                <!-- Actions -->
                <div class="btn-row">
                    <button id="select-area-btn" class="btn-primary">
                        <i data-lucide="mouse-pointer-2"></i> Select Area
                    </button>
                    <button id="clear-selection-btn" class="btn-ghost" style="flex: 0 0 auto;">
                        Clear
                    </button>
                </div>
            </div>
        </div>

        <!-- Card 2: Global Filters (Collapsible) -->
        <div class="card collapsed" id="filters-card">
            <div class="card-header" id="filters-toggle">
                <h3><i data-lucide="filter"></i> Global Filters <i data-lucide="chevron-down" class="chevron"></i></h3>
            </div>
            <div class="card-body">
                <div class="filter-grid">
                    <!-- Date -->
                    <div class="filter-item full-width">
                        <label>Time Period</label>
                        <select id="filter-date">
                            <option value="all">All Time</option>
                            <option value="6m">Last 6 Months</option>
                            <option value="1y">Last 1 Year</option>
                            <option value="3y">Last 3 Years</option>
                            <option value="5y">Last 5 Years</option>
                        </select>
                    </div>

                    <!-- Flat Type -->
                    <div class="filter-item full-width">
                        <label>Flat Type</label>
                        <div class="checkbox-grid" id="filter-flat-type" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                            <label><input type="checkbox" value="2 ROOM" checked> 2 Rm</label>
                            <label><input type="checkbox" value="3 ROOM" checked> 3 Rm</label>
                            <label><input type="checkbox" value="4 ROOM" checked> 4 Rm</label>
                            <label><input type="checkbox" value="5 ROOM" checked> 5 Rm</label>
                            <label><input type="checkbox" value="EXECUTIVE" checked> Exec</label>
                            <label><input type="checkbox" value="MULTI-GENERATION" checked> Multi-Gen</label>
                        </div>
                    </div>

                    <!-- Lease -->
                    <div class="filter-item full-width">
                        <label>Lease Remaining (Years)</label>
                        <div class="input-row">
                            <input type="number" id="filter-lease-min" placeholder="Min" min="0" max="99" value="0">
                            <input type="number" id="filter-lease-max" placeholder="Max" min="0" max="99" value="99">
                        </div>
                    </div>
                </div>
                
                <div class="btn-row">
                    <button id="apply-filters-btn" class="btn-primary">Apply Filters</button>
                </div>
            </div>
        </div>

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
      
        <!-- Card 4: Stats & Charts -->
        <div class="card" style="flex: 1; display: flex; flex-direction: column;">
            <div class="tab-nav">
                <button class="tab-btn active" data-tab="overview">Overview</button>
                <button class="tab-btn" data-tab="fairvalue">Fair Value Analysis</button>
            </div>
            
            <div class="tab-content active" id="tab-overview">
                <div id="stats-content"></div>
                <div class="chart-container">
                    <canvas id="trend-chart"></canvas>
                    <div id="trend-chart-placeholder" class="chart-placeholder hidden">
                        <div class="placeholder-content">
                            <i data-lucide="bar-chart-2"></i>
                            <p>Select an area on the map<br>to view price trends</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="tab-content" id="tab-fairvalue">
                <div class="fair-value-content">
                    <div id="fv-distribution">
                         <h3 style="font-size: 13px;">Price Distribution 
                            <span class="tooltip-trigger" data-tooltip="Prices adjusted via HDB Resale Price Index">
                                <i data-lucide="info"></i>
                            </span>
                         </h3>
                         <div class="fv-stats" id="fv-stats"></div>
                         
                         <div class="input-wrapper" style="margin: 12px 0;">
                            <select id="fv-feature-select">
                                <option value="storey">Group by Storey Range</option>
                                <option value="lease">Group by Lease Remaining</option>
                                <option value="mrt">Group by MRT Distance</option>
                                <option value="flat_type">Group by Flat Type</option>
                            </select>
                         </div>
                         
                         <div class="chart-container">
                            <canvas id="fv-histogram"></canvas>
                             <div id="fv-chart-placeholder" class="chart-placeholder hidden">
                                <div class="placeholder-content">
                                    <i data-lucide="bar-chart-2"></i>
                                    <p>Select an area to view<br>fair value analysis</p>
                                </div>
                            </div>
                         </div>
                    </div>
                     <div id="fv-factors">
                        <div class="separator-line"></div>
                        <h3 style="margin-top: 16px;">
                            Factor Impact 
                            <span class="tooltip-trigger" data-tooltip="How different features affect price in this area compared to the national average">
                                <i data-lucide="help-circle"></i>
                            </span>
                        </h3>
                        <div id="fv-factors-content"></div>
                     </div>
                </div>
            </div>
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

        // Clear selection
        const clearBtn = document.getElementById('clear-selection-btn');
        clearBtn?.addEventListener('click', () => {
            this.radialSelection.clearSelection();
            this.mapView.setSelectedTransactions(null);
            this.mapView.clearSelectionCircle();
            this.mapView.clearSelectionRect();

            // Clear Postal Input BUT KEEP Radius
            const postalInput = document.getElementById('postal-input') as HTMLInputElement;
            if (postalInput) postalInput.value = '';

            // Update stats to show global data
            this.updateSelectionState(null);

            // Explicitly clear chart? No, updateSelectionState handles it (shows global)
        });

        // Analyze button
        const analyzeBtn = document.getElementById('analyze-btn');
        analyzeBtn?.addEventListener('click', () => {
            this.analyze();
        });

        // Panel Toggle
        const toggleBtn = document.getElementById('panel-toggle');
        toggleBtn?.addEventListener('click', () => {
            this.container.classList.toggle('collapsed');
        });

        // Select Area Button
        const selectAreaBtn = document.getElementById('select-area-btn');
        selectAreaBtn?.addEventListener('click', () => {
            // Toggle selection mode based on tracked state
            this.setSelectionMode(!this.isSelectionModeActive);
        });

        this.bindMapEvents();
        this.bindResizeEvents();
        this.bindTooltipEvents();

        // New Binders
        this.bindSearchEvents();
        this.bindSelectionControls();
        this.bindFilterEvents();
    }

    private bindSearchEvents(): void {
        const input = document.getElementById('postal-input') as HTMLInputElement;
        const btn = document.getElementById('search-btn');

        const performSearch = async () => {
            const query = input.value.trim();
            if (query.length < 3) return;

            // Show loading
            btn!.innerHTML = '<i data-lucide="loader" class="animate-spin"></i>';
            // @ts-ignore
            if (window.lucide) window.lucide.createIcons();

            const result = await PostalSearch.search(query);

            // Restore search icon
            btn!.innerHTML = '<i data-lucide="search"></i>';
            // @ts-ignore
            if (window.lucide) window.lucide.createIcons();

            if (result) {
                const lat = parseFloat(result.LATITUDE);
                const lng = parseFloat(result.LONGITUDE);

                // Fly to location
                this.mapView.flyTo(lat, lng);

                // If in radial mode, update selection circle
                if (appState.get('selectionMode') === 'radial') {
                    const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
                    const radius = parseInt(radiusInput.value) || 500;

                    this.mapView.updateSelectionCircle(lat, lng, radius);
                    this.radialSelection.setSelection(lat, lng, radius);

                    // Update stats
                    const selected = this.radialSelection.getSelectedTransactions();
                    this.updateSelectionState(selected);
                }
            } else {
                alert('Location not found');
            }
        };

        btn?.addEventListener('click', performSearch);
        input?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });

        // Radius Input Visibility
        this.updateRadiusInputVisibility();

        // Adding ENTER support for radius input
        const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
        radiusInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch(); // Reuse same search function
        });

        // Trigger default initial search ONLY on DESKTOP
        const isMobile = window.innerWidth < 768;
        if (!this.currentTransactions && !isMobile) {
            input.value = "085101";
            if (radiusInput) radiusInput.value = "888";
            performSearch();
        }
    }

    private updateRadiusInputVisibility() {
        const radiusInputWrapper = document.getElementById('radius-input')?.closest('.input-wrapper');
        if (radiusInputWrapper) {
            (radiusInputWrapper as HTMLElement).style.display = appState.get('selectionMode') === 'radial' ? 'block' : 'none';
        }
    }

    private bindSelectionControls(): void {
        // Selection Mode Toggle
        const modeBtns = document.querySelectorAll('.mode-btn');
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = (btn as HTMLElement).dataset.mode as 'radial' | 'rect';
                appState.set('selectionMode', mode);

                // Update UI
                modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Update visibility of controls
                this.updateRadiusInputVisibility();

                // Update Map Behavior
                this.mapView.setSelectionType(mode);

                // Reset selection mode if active
                if (this.isSelectionModeActive) {
                    this.setSelectionMode(false);
                }
            });
        });

        // Radius Input Update
        const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
        radiusInput?.addEventListener('change', () => {
            const val = parseInt(radiusInput.value);
            if (val > 0 && this.radialSelection.hasSelection()) {
                const current = this.radialSelection.getCurrentCenter();
                if (current) {
                    this.mapView.updateSelectionCircle(current.lat, current.lng, val);
                    this.radialSelection.setSelection(current.lat, current.lng, val);
                    const selected = this.radialSelection.getSelectedTransactions();
                    this.updateSelectionState(selected);
                }
            }
        });
    }

    private bindFilterEvents(): void {
        // Toggle Filter Section
        const toggle = document.getElementById('filters-toggle');
        toggle?.addEventListener('click', () => {
            const card = document.getElementById('filters-card');
            card?.classList.toggle('collapsed');
        });

        // Apply Filters
        const applyBtn = document.getElementById('apply-filters-btn');
        applyBtn?.addEventListener('click', () => {
            this.applyGlobalFilters();
        });
    }

    private applyGlobalFilters(): void {
        // 1. Gather Filter Values
        const dateSelect = document.getElementById('filter-date') as HTMLSelectElement;
        const flatTypeInputs = document.querySelectorAll('#filter-flat-type input:checked');
        const leaseMin = document.getElementById('filter-lease-min') as HTMLInputElement;
        const leaseMax = document.getElementById('filter-lease-max') as HTMLInputElement;

        appState.set('globalFilters', {
            date: dateSelect.value,
            flatTypes: Array.from(flatTypeInputs).map(i => (i as HTMLInputElement).value),
            leaseMin: parseInt(leaseMin.value) || 0,
            leaseMax: parseInt(leaseMax.value) || 99
        });

        // 2. Filter Data
        const allData = this.dataLoader.getAllData();
        const now = new Date();

        const filtered = allData.filter(t => {
            // Flat Type
            if (!appState.get('globalFilters').flatTypes.includes(t.flat_type)) return false;

            // Lease
            if (t.remaining_lease_years < appState.get('globalFilters').leaseMin ||
                t.remaining_lease_years > appState.get('globalFilters').leaseMax) return false;

            // Date
            if (appState.get('globalFilters').date !== 'all') {
                const txDate = new Date(t.transaction_date); // field name check needed? DataLoader uses transaction_date
                const diffTime = Math.abs(now.getTime() - txDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (appState.get('globalFilters').date === '6m' && diffDays > 180) return false;
                if (appState.get('globalFilters').date === '1y' && diffDays > 365) return false;
                if (appState.get('globalFilters').date === '3y' && diffDays > 365 * 3) return false;
                if (appState.get('globalFilters').date === '5y' && diffDays > 365 * 5) return false;
            }

            return true;
        });

        // 3. Update Map & Stats
        this.mapView.setFilteredData(filtered);

        // Clear current user selection as it might be invalid now
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

        // Always render fair value if active (it handles empty/full data internally now)
        if (this.activeTab === 'fairvalue') {
            this.renderFairValue(dataToRender);
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
        // Re-implement filter logic here or ensure we have it cached.
        // To avoid code duplication, I will refactor applyGlobalFilters to store result.
        // For this patch, I'll just re-run the filter logic helper.
        const allData = this.dataLoader.getAllData();
        const now = new Date(); // Use current time for relative dates

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

            // Bounds checking
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

    private startDragLat: number | null = null;
    private startDragLng: number | null = null;
    // private isSelecting = false; // Unused

    private bindMapEvents(): void {
        // 1. Mobile Viewport Tracking (Always bind, check mode inside)
        let debounceTimer: any = null;
        this.mapView.setOnMapMove(() => {
            // Check dynamic width to support resizing
            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    this.updateMobileViewportStats();
                }, 500);
            }
        });

        // onPointClick
        this.mapView.setOnPointClick((lat, lng) => {
            console.log('AnalyticsPanel onPointClick received:', lat, lng);

            // Only if not in a selection mode
            /* 
              Actually MapView checks for 'selection-active' class on container, 
              but we also have this.isSelectionModeActive state here.
              Let's redundantly check.
            */
            if (this.isSelectionModeActive) {
                console.log('Skipping click: Selection mode active');
                return;
            }

            // Find transactions at this location (block level)
            // Use a small radius or exact coordinate match?
            // Coordinates in data are precise.
            const allData = this.dataLoader.getAllData();

            // Find unique block/postal at this lat/lng
            // Optimization: first find one, then filter? 
            // Or just filter all? (Fast enough for 200k)
            const clicked = allData.find(t =>
                Math.abs(t.latitude - lat) < 0.00001 &&
                Math.abs(t.longitude - lng) < 0.00001
            );

            if (!clicked) {
                console.warn('No transaction found at clicked coordinates');
                return;
            }
            console.log('Clicked Item:', clicked.block, clicked.street_name);

            // Get all transactions for this block/postal, applying GLOBAL filters
            // We use the same filter logic as getGlobalFilteredData, but additionally filter by block/postal
            const relevant = allData.filter(t => {
                // Location Match
                if (t.block !== clicked.block || t.street_name !== clicked.street_name) return false;

                // Global Filters
                if (!appState.get('globalFilters').flatTypes.includes(t.flat_type)) return false;
                if (t.remaining_lease_years < appState.get('globalFilters').leaseMin ||
                    t.remaining_lease_years > appState.get('globalFilters').leaseMax) return false;
                if (appState.get('globalFilters').date !== 'all') {
                    // Start Copy-Paste from getGlobalFilteredData
                    const now = new Date();
                    const txDate = new Date(t.transaction_date);
                    const diffTime = Math.abs(now.getTime() - txDate.getTime());
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    if (appState.get('globalFilters').date === '6m' && diffDays > 180) return false;
                    if (appState.get('globalFilters').date === '1y' && diffDays > 365) return false;
                    if (appState.get('globalFilters').date === '3y' && diffDays > 365 * 3) return false;
                    if (appState.get('globalFilters').date === '5y' && diffDays > 365 * 5) return false;
                    // End Copy-Paste
                }

                return true;
            });

            if (relevant.length === 0) return;

            // Sort by Date Descending
            relevant.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());

            // Take top 5
            const top5 = relevant.slice(0, 5);



            // Construct Content
            // Lookup postal code from geocode cache
            const geocodeKey = `${clicked.block}|${clicked.street_name}`;
            const geocodeData = this.geocodeCache[geocodeKey];
            const postal = geocodeData?.postal || '';
            const title = postal
                ? `Blk ${clicked.block} ${clicked.street_name} • ${postal}`
                : `Blk ${clicked.block} ${clicked.street_name}`;
            // Request says "current lease remaining".
            // Calculate: 99 - (CurrentYear - LeaseStartYear)
            const currentYear = new Date().getFullYear();
            const leaseCommenceYear = Number(clicked.lease_commence_date);
            const currentLease = 99 - (currentYear - leaseCommenceYear);

            const mrt = clicked.mrt_distance_m ? `${Math.round(clicked.mrt_distance_m)}m to MRT` : '';
            // We need MRT Name? Data has 'mrt_distance_m'. Does it have name?
            // DataLoader interface: `mrt_distance_m`. No name field.

            // Generate HTML
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
                        <span class="popover-badge">${Math.max(0, currentLease)}y left</span>
                    </div>
                     <div class="popover-subtitle">
                        <i data-lucide="train" style="width: 12px; height: 12px;"></i> ${mrt}
                    </div>
                </div>
                <table class="popover-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th>Storey</th>
                            <th>Price</th>
                            <th>PSF</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            `;

            this.mapView.showPopup(lat, lng, html);

            // Re-init icons in popup? popups usually strip scripts, but let's try
            // or just use manual SVGs if needed. Lucide won't auto-scan the popup content easily.
            // I'll stick to simple text for MRT if icon fails.
        });

        // 2. Desktop Drag Selection
        this.mapView.setOnDragSelection({
            onStart: (lat, lng) => {
                this.startDragLat = lat;
                this.startDragLng = lng;
                if (appState.get('selectionMode') === 'radial') {
                    this.mapView.updateSelectionCircle(lat, lng, 0);
                }
                // Rect not needed init visual? Maybe just empty.
            },
            onMove: (lat, lng) => {
                if (this.startDragLat !== null && this.startDragLng !== null) {
                    if (appState.get('selectionMode') === 'radial') {
                        const radius = haversineDistance(this.startDragLat, this.startDragLng, lat, lng);
                        this.mapView.updateSelectionCircle(this.startDragLat, this.startDragLng, radius);
                    } else {
                        // Rectangular
                        this.mapView.updateSelectionRect(this.startDragLat, this.startDragLng, lat, lng);
                    }
                }
            },
            onEnd: (lat, lng) => {
                if (this.startDragLat !== null && this.startDragLng !== null) {
                    let selected: HDBTransaction[] | null = null;

                    if (appState.get('selectionMode') === 'radial') {
                        const radius = haversineDistance(this.startDragLat, this.startDragLng, lat, lng);
                        this.radialSelection.setSelection(this.startDragLat, this.startDragLng, radius);
                        selected = this.radialSelection.getSelectedTransactions();

                        const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
                        if (radiusInput) radiusInput.value = Math.round(radius).toString();

                        // We do NOT clear the selection circle, it persists.
                    } else {
                        // Rectangular
                        const minLat = Math.min(this.startDragLat, lat);
                        const maxLat = Math.max(this.startDragLat, lat);
                        const minLng = Math.min(this.startDragLng, lng);
                        const maxLng = Math.max(this.startDragLng, lng);

                        selected = this.dataLoader.queryRectangle(minLat, minLng, maxLat, maxLng);
                        this.mapView.updateSelectionRect(this.startDragLat, this.startDragLng, lat, lng);
                    }

                    // Store for tab switching
                    this.currentTransactions = selected;

                    this.mapView.setSelectedTransactions(selected);
                    this.renderStats(selected);
                    this.renderChart(selected ? selected : []);

                    // Also render fair value if that tab is active
                    if (this.activeTab === 'fairvalue' && selected) {
                        this.renderFairValue(selected);
                    }

                    // Disable the dragging interaction, but keep visuals
                    this.mapView.setSelectionMode(false);
                    this.setSelectionMode(false);

                    this.startDragLat = null;
                    this.startDragLng = null;
                }
            }
        });

        // Trigger initial mobile stats if on mobile
        if (window.innerWidth < 768) {
            setTimeout(() => this.updateMobileViewportStats(), 1000);
        }
    }

    private updateMobileViewportStats(): void {
        const bounds = this.mapView.getBounds();
        if (!bounds) return;

        const allData = this.dataLoader.getAllData();
        const visibleData = allData.filter((t: HDBTransaction) =>
            t.latitude >= bounds.south && t.latitude <= bounds.north &&
            t.longitude >= bounds.west && t.longitude <= bounds.east
        );

        this.renderStats(visibleData);
        // Ensure chart is rendered even if small dataset, but limit points if needed? 
        // For viewport, it's fine.
        this.renderChart(visibleData);

        const header = this.container.querySelector('.analytics-header h2');
        if (header) header.textContent = `📊 Analytics (Viewport)`;
    }

    private setSelectionMode(active: boolean): void {
        this.isSelectionModeActive = active;
        this.mapView.setSelectionMode(active);

        const btn = document.getElementById('select-area-btn');
        if (btn) {
            btn.textContent = active ? "Drag on Map to Select" : "Select Area on Map";
            btn.classList.toggle('primary-btn', !active); // remove primary color when active (cancelling)
            btn.classList.toggle('active-btn', active);

            if (active) {
                btn.style.backgroundColor = '#ef4444'; // Red for cancel
                btn.style.borderColor = '#ef4444';
                btn.style.color = 'white';
            } else {
                btn.style.removeProperty('background-color');
                btn.style.removeProperty('border-color');
                btn.style.removeProperty('color');
                btn.classList.add('primary-btn');
            }
        }
    }

    private analyze(): void {
        // Redundant with interactive selection, but kept for manual radius updates
        const selected = this.radialSelection.getSelectedTransactions();
        if (selected) {
            this.mapView.setSelectedTransactions(selected);
            this.renderStats(selected);
            this.renderChart(selected);
        }
    }

    private renderStats(transactions: HDBTransaction[] | null = null): void {
        const statsContent = document.getElementById('stats-content');
        if (!statsContent) return;

        const data = transactions ?? this.dataLoader.getAllData();

        if (data.length === 0) {
            statsContent.innerHTML = '<p>No data selected</p>';
            return;
        }

        const avgPrice = data.reduce((sum: number, t: HDBTransaction) => sum + t.resale_price, 0) / data.length;
        const avgPsf = data.reduce((sum: number, t: HDBTransaction) => sum + t.price_psf, 0) / data.length;
        let minPrice = Infinity;
        let maxPrice = -Infinity;
        for (const t of data) {
            if (t.resale_price < minPrice) minPrice = t.resale_price;
            if (t.resale_price > maxPrice) maxPrice = t.resale_price;
        }

        statsContent.innerHTML = `
        <table class="stats-table">
            <tr>
                <td class="stats-label">Transactions</td>
                <td class="stats-value">${data.length.toLocaleString()}</td>
            </tr>
            <tr>
                <td class="stats-label">Avg Price</td>
                <td class="stats-value">$${Math.floor(avgPrice).toLocaleString()}</td>
            </tr>
            <tr>
                <td class="stats-label">Avg PSF</td>
                <td class="stats-value">$${Math.floor(avgPsf)}</td>
            </tr>
            <tr>
                <td class="stats-label">Price Range</td>
                <td class="stats-value">$${Math.floor(minPrice / 1000)}k - $${Math.floor(maxPrice / 1000)}k</td>
            </tr>
        </table>
    `;
    }

    private renderChart(transactions: HDBTransaction[]): void {
        const canvas = document.getElementById('trend-chart') as HTMLCanvasElement;
        const placeholder = document.getElementById('trend-chart-placeholder');
        if (!canvas || !placeholder) return;

        if (transactions.length === 0) {
            canvas.classList.add('hidden');
            placeholder.classList.remove('hidden');
            if (this.chart) this.chart.destroy();
            return;
        }

        canvas.classList.remove('hidden');
        placeholder.classList.add('hidden');

        // Prepare time-series data
        const monthlyData = this.aggregateByMonth(transactions);

        if (this.chart) {
            this.chart.destroy();
        }

        this.chart = new Chart(canvas, {
            type: 'boxplot',
            data: {
                labels: monthlyData.map(d => d.month),
                datasets: [{
                    label: 'Price PSF',
                    data: monthlyData.map(d => ({
                        min: d.min,
                        q1: d.q1,
                        median: d.median,
                        q3: d.q3,
                        max: d.max,
                        mean: d.mean,
                        outliers: d.outliers,
                    })),
                    backgroundColor: 'rgba(59, 130, 246, 0.3)',
                    borderColor: 'rgb(59, 130, 246)',
                    borderWidth: 1,
                    outlierBackgroundColor: 'rgba(59, 130, 246, 0.6)',
                    outlierBorderColor: 'rgb(59, 130, 246)',
                    outlierRadius: 3,
                    medianColor: 'rgb(37, 99, 235)',
                    meanBackgroundColor: 'rgba(16, 185, 129, 0.6)',
                    meanBorderColor: 'rgb(16, 185, 129)',
                    meanRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false,
                    },
                    title: {
                        display: true,
                        text: 'Price Distribution Over Time (PSF)',
                    },
                    tooltip: {
                        boxPadding: 4,
                        callbacks: {
                            title: (items: any[]) => {
                                const item = items[0];
                                return item ? `Month: ${item.label}` : '';
                            },
                            label: (context: any) => {
                                const d = context.raw;
                                if (!d) return '';
                                return [
                                    `Median: $${Math.round(d.median)}`,
                                    `Mean: $${Math.round(d.mean)}`,
                                    `Q1: $${Math.round(d.q1)}  Q3: $${Math.round(d.q3)}`,
                                    `Min: $${Math.round(d.min)}  Max: $${Math.round(d.max)}`,
                                    d.outliers && d.outliers.length > 0 ? `Outliers: ${d.outliers.length}` : ''
                                ].filter(s => s !== '');
                            }
                        },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        grace: '5%',
                        title: { display: true, text: 'Price PSF ($)' },
                    },
                    x: {
                        title: { display: true, text: 'Month' },
                    },
                },
            },
        } as any);
    }



    private aggregateByMonth(transactions: HDBTransaction[]): Array<{
        month: string;
        min: number;
        q1: number;
        median: number;
        mean: number;
        q3: number;
        max: number;
        outliers: number[];
    }> {
        const monthMap = new Map<string, number[]>();

        transactions.forEach(t => {
            if (!monthMap.has(t.month)) {
                monthMap.set(t.month, []);
            }
            monthMap.get(t.month)!.push(t.price_psf);
        });

        const result = Array.from(monthMap.entries())
            .map(([month, prices]) => {
                const sorted = prices.slice().sort((a, b) => a - b);
                const n = sorted.length;
                const q1 = sorted[Math.floor(n * 0.25)];
                const q3 = sorted[Math.floor(n * 0.75)];
                const iqr = q3 - q1;
                const lowerFence = q1 - 1.5 * iqr;
                const upperFence = q3 + 1.5 * iqr;

                // Separate outliers from whisker range
                const outliers = sorted.filter(p => p < lowerFence || p > upperFence);
                const inRange = sorted.filter(p => p >= lowerFence && p <= upperFence);

                return {
                    month,
                    min: inRange.length > 0 ? inRange[0] : sorted[0],
                    q1,
                    median: sorted[Math.floor(n * 0.5)],
                    mean: sorted.reduce((sum, p) => sum + p, 0) / n,
                    q3,
                    max: inRange.length > 0 ? inRange[inRange.length - 1] : sorted[n - 1],
                    outliers,
                };
            })
            .sort((a, b) => a.month.localeCompare(b.month));

        return result;
    }

    private attachTabListeners(): void {
        const tabButtons = this.container.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = (btn as HTMLElement).dataset.tab;
                if (!tabId) return;

                // Update active tab button
                tabButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Update active tab content
                this.container.querySelectorAll('.tab-content').forEach(content => {
                    content.classList.remove('active');
                });
                const tabContent = this.container.querySelector(`#tab-${tabId}`);
                tabContent?.classList.add('active');

                this.activeTab = tabId as 'overview' | 'fairvalue';

                // Re-render fair value if switching to that tab
                if (tabId === 'fairvalue') {
                    // Use current selection OR global filtered data
                    const data = this.currentTransactions || this.getGlobalFilteredData();
                    this.renderFairValue(data);
                }
            });
        });

        // Feature dropdown listener
        const featureSelect = document.getElementById('fv-feature-select') as HTMLSelectElement;
        featureSelect?.addEventListener('change', () => {
            this.selectedFeature = featureSelect.value as any;
            if (this.currentTransactions) {
                this.renderFairValueChart(this.currentTransactions);
            }
        });
    }

    private renderFairValue(transactions: HDBTransaction[]): void {
        if (!this.fairValueAnalysis.isReady()) {
            const fvStatsEl = document.getElementById('fv-stats');
            if (fvStatsEl) fvStatsEl.innerHTML = '<p>Loading analysis data...</p>';
            return;
        }

        // Render distribution stats
        const distribution = this.fairValueAnalysis.getPriceDistribution(transactions);
        const fvStatsEl = document.getElementById('fv-stats');
        if (fvStatsEl) {
            fvStatsEl.innerHTML = `
                <table class="stats-table">
                    <tr>
                        <td class="stats-label">Median PSF</td>
                        <td class="stats-value">$${Math.round(distribution.median).toLocaleString()}</td>
                    </tr>
                    <tr>
                        <td class="stats-label">25th - 75th %</td>
                        <td class="stats-value">$${Math.round(distribution.q1).toLocaleString()} - $${Math.round(distribution.q3).toLocaleString()}</td>
                    </tr>
                    <tr>
                        <td class="stats-label">Range</td>
                        <td class="stats-value">$${Math.round(distribution.min).toLocaleString()} - $${Math.round(distribution.max).toLocaleString()}</td>
                    </tr>
                    <tr>
                        <td class="stats-label">Transactions</td>
                        <td class="stats-value">${transactions.length.toLocaleString()}</td>
                    </tr>
                </table>
            `;
            // @ts-ignore
            if (window.lucide) window.lucide.createIcons();
        }

        // Render box plot chart
        this.renderFairValueChart(transactions);

        // Render factor impact analysis
        this.renderFactorImpact(transactions);
    }

    private renderFairValueChart(transactions: HDBTransaction[]): void {
        const canvas = document.getElementById('fv-histogram') as HTMLCanvasElement;
        const placeholder = document.getElementById('fv-chart-placeholder');
        if (!canvas || !placeholder) return;

        if (transactions.length === 0) {
            canvas.classList.add('hidden');
            placeholder.classList.remove('hidden');
            if (this.fairValueChart) this.fairValueChart.destroy();
            return;
        }

        canvas.classList.remove('hidden');
        placeholder.classList.add('hidden');

        // Group transactions by selected feature
        const groupedData = this.aggregateByFeature(transactions, this.selectedFeature);

        if (this.fairValueChart) {
            this.fairValueChart.destroy();
        }

        const featureLabels: Record<string, string> = {
            storey: 'Storey Range',
            lease: 'Lease Remaining (Years)',
            mrt: 'MRT Distance (m)',
            flat_type: 'Flat Type',
        };

        this.fairValueChart = new Chart(canvas, {
            type: 'boxplot',
            data: {
                labels: groupedData.map(d => d.label),
                datasets: [{
                    label: 'Price PSF',
                    data: groupedData.map(d => ({
                        min: d.min,
                        q1: d.q1,
                        median: d.median,
                        q3: d.q3,
                        max: d.max,
                        mean: d.mean,
                        outliers: d.outliers,
                    })),
                    backgroundColor: 'rgba(59, 130, 246, 0.3)',
                    borderColor: 'rgb(59, 130, 246)',
                    borderWidth: 1,
                    outlierBackgroundColor: 'rgba(59, 130, 246, 0.6)',
                    outlierBorderColor: 'rgb(59, 130, 246)',
                    outlierRadius: 3,
                    medianColor: 'rgb(37, 99, 235)',
                    meanBackgroundColor: 'rgba(16, 185, 129, 0.6)',
                    meanBorderColor: 'rgb(16, 185, 129)',
                    meanRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true,
                        text: `Price PSF by ${featureLabels[this.selectedFeature]} ⓘ`,
                    },
                    tooltip: {
                        boxPadding: 4,
                        callbacks: {
                            title: (items: any[]) => {
                                const item = items[0];
                                return item ? `${featureLabels[this.selectedFeature]}: ${item.label}` : '';
                            },
                            label: (context: any) => {
                                const d = context.raw;
                                if (!d) return '';
                                return [
                                    `Median: $${Math.round(d.median)}`,
                                    `Mean: $${Math.round(d.mean)}`,
                                    `Q1: $${Math.round(d.q1)}  Q3: $${Math.round(d.q3)}`,
                                    `Min: $${Math.round(d.min)}  Max: $${Math.round(d.max)}`,
                                    `Count: ${groupedData[context.dataIndex].count}`,
                                    d.outliers && d.outliers.length > 0 ? `Outliers: ${d.outliers.length}` : ''
                                ].filter(s => s !== '');
                            }
                        },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        grace: '5%',
                        title: { display: true, text: 'Price PSF ($)' },
                    },
                    x: {
                        title: { display: true, text: featureLabels[this.selectedFeature] },
                    },
                },
            },
        } as any);
    }

    private aggregateByFeature(transactions: HDBTransaction[], feature: string): Array<{
        label: string;
        min: number;
        q1: number;
        median: number;
        mean: number;
        q3: number;
        max: number;
        count: number;
        outliers: number[];
    }> {
        const groups = new Map<string, number[]>();

        transactions.forEach(t => {
            let key: string;
            switch (feature) {
                case 'storey':
                    const storey = t.storey_midpoint;
                    if (storey <= 3) key = '1-3';
                    else if (storey <= 6) key = '4-6';
                    else if (storey <= 9) key = '7-9';
                    else if (storey <= 12) key = '10-12';
                    else if (storey <= 15) key = '13-15';
                    else if (storey <= 20) key = '16-20';
                    else key = '21+';
                    break;
                case 'lease':
                    const lease = t.remaining_lease_years;
                    if (lease < 50) key = '<50';
                    else if (lease < 60) key = '50-59';
                    else if (lease < 70) key = '60-69';
                    else if (lease < 80) key = '70-79';
                    else if (lease < 90) key = '80-89';
                    else key = '90+';
                    break;
                case 'mrt':
                    const mrt = t.mrt_distance_m;
                    if (mrt < 300) key = '<300m';
                    else if (mrt < 500) key = '300-500m';
                    else if (mrt < 750) key = '500-750m';
                    else if (mrt < 1000) key = '750m-1km';
                    else key = '>1km';
                    break;
                case 'flat_type':
                default:
                    key = t.flat_type;
                    break;
            }
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(this.fairValueAnalysis.getAdjustedPricePsf(t));
        });

        const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
            if (feature === 'storey') {
                const order = ['1-3', '4-6', '7-9', '10-12', '13-15', '16-20', '21+'];
                return order.indexOf(a) - order.indexOf(b);
            } else if (feature === 'lease') {
                const order = ['<50', '50-59', '60-69', '70-79', '80-89', '90+'];
                return order.indexOf(a) - order.indexOf(b);
            } else if (feature === 'mrt') {
                const order = ['<300m', '300-500m', '500-750m', '750m-1km', '>1km'];
                return order.indexOf(a) - order.indexOf(b);
            } else {
                return a.localeCompare(b);
            }
        });

        return sortedKeys.map(key => {
            const prices = groups.get(key)!.sort((a, b) => a - b);
            const n = prices.length;
            const q1 = prices[Math.floor(n * 0.25)];
            const q3 = prices[Math.floor(n * 0.75)];
            const iqr = q3 - q1;
            const lowerFence = q1 - 1.5 * iqr;
            const upperFence = q3 + 1.5 * iqr;

            const outliers = prices.filter(p => p < lowerFence || p > upperFence);
            const inRange = prices.filter(p => p >= lowerFence && p <= upperFence);

            return {
                label: key,
                min: inRange.length > 0 ? inRange[0] : prices[0],
                q1,
                median: prices[Math.floor(n * 0.5)],
                mean: prices.reduce((sum, p) => sum + p, 0) / n,
                q3,
                max: inRange.length > 0 ? inRange[inRange.length - 1] : prices[n - 1],
                count: n,
                outliers,
            };
        });
    }

    private renderFactorImpact(transactions: HDBTransaction[]): void {
        const container = document.getElementById('fv-factors-content');
        if (!container) return;

        if (transactions.length === 0) {
            container.innerHTML = '<p>Select an area to see factor analysis.</p>';
            return;
        }

        // Calculate average factor impacts across selections
        const coef = this.fairValueAnalysis.getCoefficients();
        if (!coef) {
            container.innerHTML = '<p>Loading model coefficients...</p>';
            return;
        }

        // Calculate averages for the selection
        // Calculate averages for the selection
        const avgStorey = transactions.reduce((sum, t) => sum + Number(t.storey_midpoint), 0) / transactions.length;
        const avgLease = transactions.reduce((sum, t) => sum + Number(t.remaining_lease_years), 0) / transactions.length;
        const avgMrt = transactions.reduce((sum, t) => sum + Number(t.mrt_distance_m), 0) / transactions.length / 1000;
        const avgArea = transactions.reduce((sum, t) => sum + Number(t.floor_area_sqm), 0) / transactions.length;

        container.innerHTML = `
            <table class="factor-table">
                <thead>
                    <tr>
                        <th>Factor</th>
                        <th>Selection Avg</th>
                        <th>Dataset Avg</th>
                        <th>Impact per Unit</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>Storey</td>
                        <td>${avgStorey.toFixed(1)}</td>
                        <td>${coef.summary_stats.storey_midpoint.mean.toFixed(1)}</td>
                        <td class="positive">+${((Math.exp(coef.features.storey_midpoint) - 1) * 100).toFixed(2)}% / floor</td>
                    </tr>
                    <tr>
                        <td>Lease Remaining</td>
                        <td>${avgLease.toFixed(1)} yrs</td>
                        <td>${coef.summary_stats.remaining_lease_years.mean.toFixed(1)} yrs</td>
                        <td class="positive">+${((Math.exp(coef.features.remaining_lease_years) - 1) * 100).toFixed(2)}% / year</td>
                    </tr>
                    <tr>
                        <td>MRT Distance</td>
                        <td>${(avgMrt * 1000).toFixed(0)}m</td>
                        <td>${(coef.summary_stats.mrt_distance_km.mean * 1000).toFixed(0)}m</td>
                        <td class="negative">${((Math.exp(coef.features.mrt_distance_km) - 1) * 100).toFixed(2)}% / km</td>
                    </tr>
                    <tr>
                        <td>Floor Area</td>
                        <td>${avgArea.toFixed(1)} sqm</td>
                        <td>${coef.summary_stats.floor_area_sqm.mean.toFixed(1)} sqm</td>
                        <td class="negative">${((Math.exp(coef.features.floor_area_sqm) - 1) * 100).toFixed(2)}% / sqm</td>
                    </tr>
                </tbody>
            </table>
            <p class="model-note">Model R² = ${(coef.r_squared * 100).toFixed(1)}% (based on ${coef.n_samples.toLocaleString()} transactions)</p>
        `;
    }
}

