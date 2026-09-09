/**
 * FiltersCard - Handles global filters for date range, flat types, and lease
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { appState } from '../state/AppState';
import { applyFilters, type GlobalFilters } from '../utils/filters';

export class FiltersCard {
    private dataLoader: DataLoader;
    private mapView: MapView;
    private requestId = 0;

    constructor(
        dataLoader: DataLoader,
        mapView: MapView
    ) {
        this.dataLoader = dataLoader;
        this.mapView = mapView;
    }

    render(): string {
        return `
        <div class="card collapsed" id="filters-card">
            <div class="card-header" id="filters-toggle">
                <h3><i data-lucide="filter"></i> Global Filters <i data-lucide="chevron-down" class="chevron"></i></h3>
            </div>
            <div class="card-body">
                <div class="filter-grid">
                    <!-- Date -->
                    <div class="filter-item full-width">
                        <label>From Month</label>
                        <div class="input-wrapper">
                            <i data-lucide="calendar"></i>
                            <input type="month" id="filter-date" value="2024-01">
                        </div>
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

                    <!-- Floor -->
                    <div class="filter-item full-width">
                        <label>Min Floor</label>
                        <input type="number" id="filter-floor-min" placeholder="e.g. 10" min="1" value="1">
                    </div>
                </div>
                
                <div class="btn-row">
                    <button id="apply-filters-btn" class="btn-primary">Apply Filters</button>
                </div>
                <p id="filter-load-status" class="filter-load-status" role="status" aria-live="polite"></p>
            </div>
        </div>
        `;
    }

    bindEvents(onFiltersApplied: (filtered: HDBTransaction[]) => void): void {

        // Toggle Filter Section
        const toggle = document.getElementById('filters-toggle');
        toggle?.addEventListener('click', () => {
            const card = document.getElementById('filters-card');
            card?.classList.toggle('collapsed');
        });

        // Restore saved filters from localStorage into form inputs
        this.restoreSavedFilters();

        // Apply Filters
        const applyBtn = document.getElementById('apply-filters-btn');
        applyBtn?.addEventListener('click', () => {
            void this.applyGlobalFilters(onFiltersApplied);
        });

        // Startup already loaded and applied these filters before rendering the panel.
    }

    private restoreSavedFilters(): void {
        try {
            const filters = appState.get('globalFilters');

            const dateInput = document.getElementById('filter-date') as HTMLInputElement;
            if (dateInput) dateInput.value = filters.date === 'all' ? '' : filters.date;

            const flatCheckboxes = document.querySelectorAll('#filter-flat-type input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
            flatCheckboxes.forEach(cb => {
                cb.checked = filters.flatTypes?.includes(cb.value) ?? true;
            });

            const leaseMin = document.getElementById('filter-lease-min') as HTMLInputElement;
            const leaseMax = document.getElementById('filter-lease-max') as HTMLInputElement;
            if (leaseMin && filters.leaseMin != null) leaseMin.value = String(filters.leaseMin);
            if (leaseMax && filters.leaseMax != null) leaseMax.value = String(filters.leaseMax);

            const floorMin = document.getElementById('filter-floor-min') as HTMLInputElement;
            if (floorMin && filters.floorMin != null) floorMin.value = String(filters.floorMin);
        } catch (_) { /* localStorage unavailable or invalid */ }
    }

    private async applyGlobalFilters(onFiltersApplied: (filtered: HDBTransaction[]) => void): Promise<void> {
        // 1. Gather Filter Values
        const dateInput = document.getElementById('filter-date') as HTMLInputElement;
        const flatTypeInputs = document.querySelectorAll('#filter-flat-type input:checked');
        const leaseMin = document.getElementById('filter-lease-min') as HTMLInputElement;
        const leaseMax = document.getElementById('filter-lease-max') as HTMLInputElement;
        const floorMin = document.getElementById('filter-floor-min') as HTMLInputElement;

        const filters: GlobalFilters = {
            date: dateInput.value,
            flatTypes: Array.from(flatTypeInputs).map(i => (i as HTMLInputElement).value),
            leaseMin: parseInt(leaseMin.value) || 0,
            leaseMax: leaseMax.value === '' ? 99 : parseInt(leaseMax.value),
            floorMin: parseInt(floorMin.value) || 1
        };
        const requestId = ++this.requestId;
        const button = document.getElementById('apply-filters-btn') as HTMLButtonElement;
        const status = document.getElementById('filter-load-status');
        button.disabled = true;
        button.textContent = 'Loading history…';
        if (status) status.textContent = 'Loading required history. Previous results remain displayed until complete.';
        try {
            await this.dataLoader.ensureDateRange(filters.date);
            if (requestId !== this.requestId) return;
            const allData = this.dataLoader.getAllData();
            const filtered = applyFilters(allData, filters);
            // Commit filters and results only after every required year is available.
            appState.set('allTransactions', allData);
            appState.set('globalFilters', filters);
            this.mapView.setFilteredData(filtered);
            onFiltersApplied(filtered);
            try { localStorage.setItem('hdb_globalFilters', JSON.stringify(filters)); } catch { /* unavailable */ }
            if (status) status.textContent = filtered.length === 0 ? 'No transactions match these filters.' : '';
        } catch (error) {
            if (requestId !== this.requestId) return;
            console.error('Could not load requested history:', error);
            if (status) status.textContent = 'Could not load all requested history. Previous results are unchanged. Apply filters to retry.';
        } finally {
            if (requestId === this.requestId) {
                button.disabled = false;
                button.textContent = 'Apply Filters';
            }
        }
    }
}
