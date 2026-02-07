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
        `;
    }

    bindEvents(onFiltersApplied: (filtered: HDBTransaction[]) => void): void {
        // Toggle Filter Section
        const toggle = document.getElementById('filters-toggle');
        toggle?.addEventListener('click', () => {
            const card = document.getElementById('filters-card');
            card?.classList.toggle('collapsed');
        });

        // Apply Filters
        const applyBtn = document.getElementById('apply-filters-btn');
        applyBtn?.addEventListener('click', () => {
            this.applyGlobalFilters(onFiltersApplied);
        });
    }

    private applyGlobalFilters(onFiltersApplied: (filtered: HDBTransaction[]) => void): void {
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

        // 3. Update Map & Callback
        this.mapView.setFilteredData(filtered);
        onFiltersApplied(filtered);
    }
}
