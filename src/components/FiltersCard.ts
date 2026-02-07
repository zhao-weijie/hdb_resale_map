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

                    <!-- MOP Expiry (New) -->
                    <div class="filter-item full-width" style="border-top: 1px solid var(--color-border); padding-top: 16px; margin-top: 8px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                            <label style="margin:0; font-weight: 500;">Show Upcoming MOP Expiries</label>
                            <input type="checkbox" id="display-mop-toggle" style="width: 20px; height: 20px;">
                        </div>
                        <div id="mop-date-section" style="display: none; margin-top: 8px;">
                             <label style="font-size: 13px; color: var(--color-text-muted); margin-bottom: 6px; display: block;">Expiry Date Range</label>
                             <div class="input-row" style="display: flex; gap: 8px;">
                                <input type="date" id="mop-date-start" style="flex: 1;">
                                <input type="date" id="mop-date-end" style="flex: 1;">
                            </div>
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
        // MOP Filter Logic
        const mopToggle = document.getElementById('display-mop-toggle') as HTMLInputElement;
        const mopSection = document.getElementById('mop-date-section');
        const mopStart = document.getElementById('mop-date-start') as HTMLInputElement;
        const mopEnd = document.getElementById('mop-date-end') as HTMLInputElement;

        if (mopToggle && mopStart && mopEnd) {
            // Init state
            mopToggle.checked = appState.get('displayMopExpiries');
            if (mopSection) mopSection.style.display = mopToggle.checked ? 'block' : 'none';

            const range = appState.get('mopExpiryDateRange');
            mopStart.value = range[0];
            mopEnd.value = range[1];

            // Bind events
            mopToggle.addEventListener('change', () => {
                appState.set('displayMopExpiries', mopToggle.checked);
                if (mopSection) mopSection.style.display = mopToggle.checked ? 'block' : 'none';
            });

            const updateDateRange = () => {
                if (mopStart.value && mopEnd.value) {
                    appState.set('mopExpiryDateRange', [mopStart.value, mopEnd.value]);
                }
            };

            mopStart.addEventListener('change', updateDateRange);
            mopEnd.addEventListener('change', updateDateRange);
        }

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
