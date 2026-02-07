/**
 * LocationCard - Handles location search, selection mode, and area selection
 */

import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { RadialSelection } from '../tools/RadialSelection';
import { PostalSearch } from '../tools/PostalSearch';
import { appState } from '../state/AppState';

export class LocationCard {
    private container: HTMLElement;
    private dataLoader: DataLoader;
    private mapView: MapView;
    private radialSelection: RadialSelection;
    private isSelectionModeActive = false;

    constructor(
        container: HTMLElement,
        dataLoader: DataLoader,
        mapView: MapView,
        radialSelection: RadialSelection
    ) {
        this.container = container;
        this.dataLoader = dataLoader;
        this.mapView = mapView;
        this.radialSelection = radialSelection;
    }

    render(): string {
        return `
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
        `;
    }

    bindEvents(onSelectionUpdate: (transactions: HDBTransaction[] | null) => void): void {
        this.bindSearchEvents(onSelectionUpdate);
        this.bindSelectionControls();
        this.bindClearButton(onSelectionUpdate);
        this.bindSelectAreaButton();
    }

    private bindSearchEvents(onSelectionUpdate: (transactions: HDBTransaction[] | null) => void): void {
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
                    onSelectionUpdate(selected);
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
            if (e.key === 'Enter') performSearch();
        });

        // Trigger default initial search ONLY on DESKTOP
        const isMobile = window.innerWidth < 768;
        if (!isMobile) {
            input.value = "085101";
            if (radiusInput) radiusInput.value = "888";
            performSearch();
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
                    appState.set('selectedTransactions', selected);
                }
            }
        });
    }

    private bindClearButton(onSelectionUpdate: (transactions: HDBTransaction[] | null) => void): void {
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
            onSelectionUpdate(null);
        });
    }

    private bindSelectAreaButton(): void {
        const selectAreaBtn = document.getElementById('select-area-btn');
        selectAreaBtn?.addEventListener('click', () => {
            this.setSelectionMode(!this.isSelectionModeActive);
        });
    }

    setSelectionMode(active: boolean): void {
        this.isSelectionModeActive = active;
        appState.set('isSelectionModeActive', active);
        this.mapView.setSelectionMode(active);

        const btn = document.getElementById('select-area-btn');
        if (btn) {
            btn.classList.toggle('active', active);
            btn.innerHTML = active
                ? '<i data-lucide="x"></i> Cancel Selection'
                : '<i data-lucide="mouse-pointer-2"></i> Select Area';
            // @ts-ignore
            if (window.lucide) window.lucide.createIcons();
        }
    }

    private updateRadiusInputVisibility(): void {
        const radiusInputWrapper = document.getElementById('radius-input')?.closest('.input-wrapper');
        if (radiusInputWrapper) {
            (radiusInputWrapper as HTMLElement).style.display = appState.get('selectionMode') === 'radial' ? 'block' : 'none';
        }
    }

    getIsSelectionModeActive(): boolean {
        return this.isSelectionModeActive;
    }
}
