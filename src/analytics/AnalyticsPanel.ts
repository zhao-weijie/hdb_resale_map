/**
 * AnalyticsPanel - UI panel for data analysis and charting
 */

import { Chart, registerables } from 'chart.js';
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { RadialSelection } from '../tools/RadialSelection';

Chart.register(...registerables);

export class AnalyticsPanel {
    private container: HTMLElement;
    private dataLoader: DataLoader;
    private mapView: MapView;
    private radialSelection: RadialSelection;
    private chart: Chart | null = null;

    constructor(containerId: string, dataLoader: DataLoader, mapView: MapView) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Container ${containerId} not found`);
        }
        this.container = container;
        this.dataLoader = dataLoader;
        this.mapView = mapView;
        this.radialSelection = new RadialSelection(dataLoader);
    }

    render(): void {
        this.container.innerHTML = `
      <button id="panel-toggle" class="panel-toggle" aria-label="Toggle Panel">
        <span>›</span>
      </button>
      <div class="panel-content">
        <div class="analytics-header">
            <h2>📊 Analytics</h2>
        </div>
      
      <div class="controls">
        <div class="control-group">
          <label for="color-mode-select">View Mode</label>
          <select id="color-mode-select">
            <option value="price_psf">Price per SqFt</option>
            <option value="price">Resale Price</option>
          </select>
        </div>
        
        <div class="control-group">
          <label for="radius-input">Radial Selection</label>
          <input type="number" id="radius-input" placeholder="Radius (meters)" value="500" min="100" step="100" />
          <button id="clear-selection-btn">Clear Selection</button>
        </div>
        
        <div class="control-group">
          <button id="select-area-btn" class="primary-btn">Select Area on Map</button>
          <button id="analyze-btn" style="display:none">Analyze</button> <!-- Hidden, kept for logic compat -->
        </div>
      </div>
      
      <div class="stats">
        <div id="stats-content"></div>
      </div>
      
      <div class="chart-container">
        <canvas id="trend-chart"></canvas>
      </div>
    `;

        this.attachEventListeners();
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
            this.renderStats();
            this.clearChart();
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
            if (this.radialSelection.isSelectionActive() && selectAreaBtn.textContent === "Cancel Selection") {
                // Cancel mode
                this.setSelectionMode(false);
            } else {
                // Enter selection mode
                this.setSelectionMode(true);
            }
        });

        this.bindMapEvents();
    }

    private startDragLat: number | null = null;
    private startDragLng: number | null = null;
    private isSelecting = false;

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

        // 2. Desktop Drag Selection (Always bind, only active if Selection Mode set)
        this.mapView.setOnDragSelection({
            onStart: (lat, lng) => {
                this.startDragLat = lat;
                this.startDragLng = lng;
                this.mapView.updateSelectionCircle(lat, lng, 0);
            },
            onMove: (lat, lng) => {
                if (this.startDragLat !== null && this.startDragLng !== null) {
                    const radius = this.haversineDistance(this.startDragLat, this.startDragLng, lat, lng);
                    this.mapView.updateSelectionCircle(this.startDragLat, this.startDragLng, radius);
                }
            },
            onEnd: (lat, lng) => {
                if (this.startDragLat !== null && this.startDragLng !== null) {
                    const radius = this.haversineDistance(this.startDragLat, this.startDragLng, lat, lng);

                    this.radialSelection.setSelection(this.startDragLat, this.startDragLng, radius);
                    const selected = this.radialSelection.getSelectedTransactions();

                    this.mapView.setSelectedTransactions(selected);
                    this.renderStats(selected);
                    this.renderChart(selected ? selected : []);

                    this.mapView.setSelectionMode(false);
                    this.setSelectionMode(false);

                    this.startDragLat = null;
                    this.startDragLng = null;

                    const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
                    if (radiusInput) radiusInput.value = Math.round(radius).toString();
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
        const visibleData = allData.filter(t =>
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
        this.isSelecting = active;
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

        const avgPrice = data.reduce((sum, t) => sum + t.resale_price, 0) / data.length;
        const avgPsf = data.reduce((sum, t) => sum + t.price_psf, 0) / data.length;
        let minPrice = Infinity;
        let maxPrice = -Infinity;
        for (const t of data) {
            if (t.resale_price < minPrice) minPrice = t.resale_price;
            if (t.resale_price > maxPrice) maxPrice = t.resale_price;
        }

        statsContent.innerHTML = `
      <div class="stat-item">
        <span class="stat-label">Transactions</span>
        <span class="stat-value">${data.length.toLocaleString()}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Avg Price</span>
        <span class="stat-value">$${Math.floor(avgPrice).toLocaleString()}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Avg PSF</span>
        <span class="stat-value">$${Math.floor(avgPsf)}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Price Range</span>
        <span class="stat-value">$${Math.floor(minPrice / 1000)}k - $${Math.floor(maxPrice / 1000)}k</span>
      </div>
    `;
    }

    private renderChart(transactions: HDBTransaction[]): void {
        const canvas = document.getElementById('trend-chart') as HTMLCanvasElement;
        if (!canvas) return;

        // Prepare time-series data
        const monthlyData = this.aggregateByMonth(transactions);

        if (this.chart) {
            this.chart.destroy();
        }

        this.chart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: monthlyData.map(d => d.month),
                datasets: [{
                    label: 'Avg Price PSF',
                    data: monthlyData.map(d => d.avgPsf),
                    borderColor: 'rgb(59, 130, 246)',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    tension: 0.4,
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
                        text: 'Price Trend Over Time',
                    },
                },
                scales: {
                    y: {
                        beginAtZero: false,
                    },
                },
            },
        });
    }

    private clearChart(): void {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }

    private aggregateByMonth(transactions: HDBTransaction[]): Array<{ month: string; avgPsf: number }> {
        const monthMap = new Map<string, number[]>();

        transactions.forEach(t => {
            if (!monthMap.has(t.month)) {
                monthMap.set(t.month, []);
            }
            monthMap.get(t.month)!.push(t.price_psf);
        });

        const result = Array.from(monthMap.entries())
            .map(([month, prices]) => ({
                month,
                avgPsf: prices.reduce((sum, p) => sum + p, 0) / prices.length,
            }))
            .sort((a, b) => a.month.localeCompare(b.month));

        return result;
    }

    // Helper for distance calc
    private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371e3; // metres
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }
}
