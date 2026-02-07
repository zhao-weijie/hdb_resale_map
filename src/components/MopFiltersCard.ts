
/**
 * MopFiltersCard - Handles filters for BTO/MOP Expiry layer
 */

import { appState } from '../state/AppState';


export class MopFiltersCard {
    constructor() { }

    render(): string {
        return `
        <div class="card collapsed" id="mop-filters-card">
            <div class="card-header" id="mop-filters-toggle">
                <h3>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="building-2"></i> BTO / MOP Expiries
                    </div>
                    <i data-lucide="chevron-down" class="chevron"></i>
                </h3>
            </div>
            <div class="card-body">
                <div class="filter-grid">
                    <!-- Toggle MOP Layer -->
                     <div class="filter-item full-width">
                        <label class="checkbox-label" style="font-weight: 600; justify-content: space-between; width: 100%;">
                            <span>Show Upcoming MOP Expiries</span>
                            <input type="checkbox" id="display-mop-toggle">
                        </label>
                    </div>

                    <div id="mop-controls-section" style="display: none; grid-column: span 2; border-top: 1px solid var(--color-border); padding-top: 16px; margin-top: 8px;">
                        <div class="filter-grid">
                            <!-- Date Range -->
                            <div class="filter-item full-width">
                                <label>Expiry Date Range</label>
                                <div class="input-row">
                                    <div class="input-wrapper">
                                        <i data-lucide="calendar"></i>
                                        <input type="date" id="mop-date-start">
                                    </div>
                                    <div class="input-wrapper">
                                        <i data-lucide="calendar"></i>
                                        <input type="date" id="mop-date-end">
                                    </div>
                                </div>
                            </div>

                            <!-- Project Type -->
                            <div class="filter-item full-width">
                                 <label>Project Type</label>
                                 <div class="checkbox-grid">
                                    ${['Prime', 'Plus', 'Standard', 'Mature', 'Non-Mature', 'Unknown'].map(type => `
                                        <label class="checkbox-label">
                                            <input type="checkbox" class="mop-type-filter" value="${type}" checked>
                                            ${type}
                                        </label>
                                    `).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    bindEvents(): void {
        const card = document.getElementById('mop-filters-card');
        const toggle = document.getElementById('mop-filters-toggle');

        // Toggle Card
        toggle?.addEventListener('click', () => {
            card?.classList.toggle('collapsed');
        });

        // 1. MOP Toggle
        const mopToggle = document.getElementById('display-mop-toggle') as HTMLInputElement;
        const mopSection = document.getElementById('mop-controls-section');

        if (mopToggle) {
            mopToggle.checked = appState.get('displayMopExpiries');
            if (mopSection) mopSection.style.display = mopToggle.checked ? 'block' : 'none';
            if (!mopToggle.checked && card) card.classList.add('collapsed'); // Auto collapse if disabled
            if (mopToggle.checked && card) card.classList.remove('collapsed'); // Auto expand if enabled

            mopToggle.addEventListener('change', () => {
                appState.set('displayMopExpiries', mopToggle.checked);
                if (mopSection) mopSection.style.display = mopToggle.checked ? 'block' : 'none';
            });
        }

        // 2. Date Range
        const mopStart = document.getElementById('mop-date-start') as HTMLInputElement;
        const mopEnd = document.getElementById('mop-date-end') as HTMLInputElement;

        if (mopStart && mopEnd) {
            const range = appState.get('mopExpiryDateRange');
            mopStart.value = range[0];
            mopEnd.value = range[1];

            const updateDateRange = () => {
                if (mopStart.value && mopEnd.value) {
                    appState.set('mopExpiryDateRange', [mopStart.value, mopEnd.value]);
                }
            };

            mopStart.addEventListener('change', updateDateRange);
            mopEnd.addEventListener('change', updateDateRange);
        }

        // 3. Project Type
        const typeCheckboxes = document.querySelectorAll('.mop-type-filter') as NodeListOf<HTMLInputElement>;

        if (typeCheckboxes.length > 0) {
            const updateProjectTypes = () => {
                const selectedTypes = Array.from(typeCheckboxes)
                    .filter(cb => cb.checked)
                    .map(cb => cb.value);
                appState.set('mopProjectTypes', selectedTypes);
            };

            typeCheckboxes.forEach(cb => {
                // Init state
                cb.checked = appState.get('mopProjectTypes').includes(cb.value);
                // Bind event
                cb.addEventListener('change', updateProjectTypes);
            });
        }
    }
}
