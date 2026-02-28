/**
 * FiltersCard - Handles global filters for date range, flat types, and lease
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { appState } from '../state/AppState';

export class FiltersCard {
    private dataLoader: DataLoader;
    private mapView: MapView;

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
            this.applyGlobalFilters(onFiltersApplied);
        });

        // Always auto-apply on load — uses saved filters if present, otherwise the defaults
        this.applyGlobalFilters(onFiltersApplied);
    }

    private restoreSavedFilters(): void {
        try {
            const saved = localStorage.getItem('hdb_globalFilters');
            if (!saved) return;
            const filters = JSON.parse(saved);

            const dateInput = document.getElementById('filter-date') as HTMLInputElement;
            if (dateInput && filters.date) dateInput.value = filters.date;

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

    private applyGlobalFilters(onFiltersApplied: (filtered: HDBTransaction[]) => void): void {
        // 1. Gather Filter Values
        const dateSelect = document.getElementById('filter-date') as HTMLSelectElement;
        const flatTypeInputs = document.querySelectorAll('#filter-flat-type input:checked');
        const leaseMin = document.getElementById('filter-lease-min') as HTMLInputElement;
        const leaseMax = document.getElementById('filter-lease-max') as HTMLInputElement;
        const floorMin = document.getElementById('filter-floor-min') as HTMLInputElement;

        const filters = {
            date: dateSelect.value,
            flatTypes: Array.from(flatTypeInputs).map(i => (i as HTMLInputElement).value),
            leaseMin: parseInt(leaseMin.value) || 0,
            leaseMax: parseInt(leaseMax.value) || 99,
            floorMin: parseInt(floorMin.value) || 1
        };
        appState.set('globalFilters', filters);

        // Persist filters to localStorage
        try {
            localStorage.setItem('hdb_globalFilters', JSON.stringify(filters));
        } catch (_) { /* localStorage unavailable */ }

        // 2. Filter Data
        const allData = this.dataLoader.getAllData();

        const filtered = allData.filter(t => {
            // Flat Type
            if (!appState.get('globalFilters').flatTypes.includes(t.flat_type)) return false;

            // Lease
            if (t.remaining_lease_years < appState.get('globalFilters').leaseMin ||
                t.remaining_lease_years > appState.get('globalFilters').leaseMax) return false;

            // Date - filter from selected month onward
            if (appState.get('globalFilters').date) {
                const selectedMonth = appState.get('globalFilters').date; // Format: YYYY-MM
                const txDate = new Date(t.transaction_date);
                const txYearMonth = txDate.getFullYear() + '-' + String(txDate.getMonth() + 1).padStart(2, '0');
                if (txYearMonth < selectedMonth) return false;
            }

            // Floor - compare minimum floor against upper bound of storey range
            if (appState.get('globalFilters').floorMin > 1) {
                const upperBound = parseInt(t.storey_range.split(' TO ')[1]);
                if (upperBound < appState.get('globalFilters').floorMin) return false;
            }

            return true;
        });

        // 3. Update Map & Callback
        this.mapView.setFilteredData(filtered);
        onFiltersApplied(filtered);
    }
}
