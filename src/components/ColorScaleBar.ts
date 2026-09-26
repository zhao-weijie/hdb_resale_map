import { interpolateViridis, interpolateTurbo } from 'd3-scale-chromatic';
import { rgb as d3rgb } from 'd3-color';
import type { HDBTransaction } from '../data/DataLoader';
import { appState } from '../state/AppState';
import { getTransactionStats, type TransactionStats } from '../utils/transactionStats';

export type ColorScale = 'viridis' | 'turbo';

/**
 * Build a 256-entry RGB lookup table for a given color scale.
 * Uses d3-color's rgb() parser instead of regex so it handles any CSS color
 * format that d3-scale-chromatic may return (rgb, hsl, hex, floats…).
 */
export function buildColorLookup(scale: ColorScale): [number, number, number][] {
    const fn = scale === 'viridis' ? interpolateViridis : interpolateTurbo;
    return Array.from({ length: 256 }, (_, i) => {
        const c = d3rgb(fn(i / 255));
        return [Math.round(c.r), Math.round(c.g), Math.round(c.b)] as [number, number, number];
    });
}

// ─── Stat helpers ────────────────────────────────────────────────────────────

function formatPrice(v: number, mode: 'price' | 'price_psf'): string {
    if (mode === 'price_psf') return `$${Math.round(v).toLocaleString()}/psf`;
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    return `$${Math.round(v / 1000)}K`;
}

function dedupePoints(
    points: Array<{ value: number; label: string }>,
    threshold: number
): Array<{ value: number; label: string }> {
    const result: typeof points = [];
    for (const p of points) {
        if (!result.some((u) => Math.abs(u.value - p.value) < threshold)) {
            result.push(p);
        }
    }
    return result;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * A vertical color-scale bar that lives alongside the Maplibre zoom controls
 * in the top-right corner of the map.
 *
 * - Renders a canvas gradient (viridis or turbo) that mirrors the map's color
 *   encoding (max at top, min at bottom).
 * - On hover: shows price tick-marks for min, −1σ, median, +1σ, max.
 * - On click: cycles between viridis ↔ turbo and broadcasts via appState.
 */
export class ColorScaleBar {
    private outerEl: HTMLElement | null = null;
    private gradientEl: HTMLElement | null = null;
    private canvasEl: HTMLCanvasElement | null = null;
    private overlayEl: HTMLElement | null = null;
    private selectionOverlayEl: HTMLElement | null = null;
    //private labelEl: HTMLElement | null = null;

    private colorScale: ColorScale = 'viridis';
    private colorMode: 'price' | 'price_psf' | 'rent' | 'rent_psf' | 'gross_yield' | 'monthly_surplus' = 'price_psf';
    private stats: TransactionStats | null = null;
    private selectionStats: TransactionStats | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private panelObserver: MutationObserver | null = null;
    private statsSource: HDBTransaction[] | null = null;
    private statsMode: 'price' | 'price_psf' | 'rent' | 'rent_psf' | 'gross_yield' | 'monthly_surplus' | null = null;
    private selectionSource: HDBTransaction[] | null = null;
    private selectionMode: 'price' | 'price_psf' | 'rent' | 'rent_psf' | 'gross_yield' | 'monthly_surplus' | null = null;
    private legendSummaryEl: HTMLElement | null = null;
    private rentalLegend: { label: string; low: string; high: string; midpoint?: string; key?: string; divergent?: boolean } | null = null;

    // IControl interface
    onAdd(_map: any): HTMLElement {
        // ── Outer wrapper (the Maplibre control root) ─────────────────────
        this.outerEl = document.createElement('div');
        this.outerEl.className = 'color-scale-bar maplibregl-ctrl';

        // ── Gradient container (has the border, border-radius, sizing) ────
        this.gradientEl = document.createElement('div');
        this.gradientEl.className = 'color-scale-gradient';

        // ── Canvas for pixel-accurate gradient ────────────────────────────
        this.canvasEl = document.createElement('canvas');
        this.canvasEl.className = 'color-scale-canvas';
        this.canvasEl.setAttribute('aria-hidden', 'true');

        // ── Overlay: tick marks + labels (global stats, always visible) ────
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'color-scale-overlay';

        // ── Selection overlay: tick marks for selection stats ────────────
        this.selectionOverlayEl = document.createElement('div');
        this.selectionOverlayEl.className = 'color-scale-overlay color-scale-overlay--selection';

        // ── Small label beneath the bar showing current scale name ────────
        /*this.labelEl = document.createElement('div');
        this.labelEl.className = 'color-scale-label';
        this.labelEl.textContent = 'Viridis';*/

        this.gradientEl.appendChild(this.canvasEl);
        this.gradientEl.appendChild(this.overlayEl);
        this.gradientEl.appendChild(this.selectionOverlayEl);
        this.legendSummaryEl = document.createElement('div');
        this.legendSummaryEl.className = 'color-scale-summary';
        // Put labels inside the gradient's positioned box so 0%, 50% and
        // 100% always follow its actual (responsive) height.
        this.gradientEl.appendChild(this.legendSummaryEl);
        this.outerEl.appendChild(this.gradientEl);
        //this.outerEl.appendChild(this.labelEl);

        // ── Click: toggle color scale ─────────────────────────────────────
        // Palette is selected in the visible map appearance setting.  The
        // legend should explain values, never behave like an undiscoverable control.

        // ── Hover: show / hide tick markers ───────────────────────────────
        this.gradientEl.addEventListener('mouseenter', () => this.showMarkers());
        this.gradientEl.addEventListener('mouseleave', () => this.hideMarkers());

        // ── State subscriptions ───────────────────────────────────────────
        appState.subscribe('colorScale', (scale) => {
            this.colorScale = scale;
        /*    this.labelEl!.textContent =
                scale === 'viridis' ? 'Viridis' : 'Turbo';
        */    this.renderGradient();
        });

        appState.subscribe('colorMode', (mode) => {
            this.colorMode = mode;
            this.refreshStats();
            this.refreshSelectionStats();
        });

        appState.subscribe('filteredTransactions', () => this.refreshStats());
        appState.subscribe('allTransactions', () => this.refreshStats());
        appState.subscribe('selectedTransactions', () => this.refreshSelectionStats());

        // ── Sync initial values ───────────────────────────────────────────
        this.colorScale = appState.get('colorScale');
        this.colorMode = appState.get('colorMode');
        this.refreshStats();
        this.refreshSelectionStats();
        /*this.labelEl.textContent =
            this.colorScale === 'viridis' ? 'Viridis' : 'Turbo';*/

        // ── ResizeObserver: redraw canvas when bar height changes ─────────
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.renderGradient());
            this.resizeObserver.observe(this.gradientEl);
        }

        // ── MutationObserver: respond to mobile drawer open/close ─────────
        this.watchAnalyticsPanel();

        return this.outerEl;
    }

    onRemove(): void {
        this.resizeObserver?.disconnect();
        this.panelObserver?.disconnect();
        this.outerEl?.remove();
        this.outerEl = null;
        this.selectionOverlayEl = null;
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private refreshStats(): void {
        if (this.colorMode !== 'price' && this.colorMode !== 'price_psf') {
            this.stats = null;
            this.renderGradient();
            this.renderMarkers();
            return;
        }
        const source = appState.get('filteredTransactions');
        if (this.statsSource === source && this.statsMode === this.colorMode) return;
        this.statsSource = source;
        this.statsMode = this.colorMode;
        if (source.length === 0) {
            this.stats = null;
            this.renderMarkers();
            return;
        }
        this.stats = getTransactionStats(source, this.colorMode);
        this.renderGradient();
        this.renderMarkers();
    }

    private refreshSelectionStats(): void {
        if (this.colorMode !== 'price' && this.colorMode !== 'price_psf') {
            this.selectionStats = null;
            this.renderMarkers();
            return;
        }
        const selected = appState.get('selectedTransactions');
        if (this.selectionSource === selected && this.selectionMode === this.colorMode) return;
        this.selectionSource = selected;
        this.selectionMode = this.colorMode;
        if (!selected || selected.length === 0) {
            this.selectionStats = null;
        } else {
            this.selectionStats = getTransactionStats(selected, this.colorMode);
        }
        this.renderMarkers();
    }

    private renderGradient(): void {
        if (!this.canvasEl || !this.gradientEl) return;
        const h = this.gradientEl.clientHeight;
        const w = this.gradientEl.clientWidth;

        // Not yet laid out — retry after browser paint
        if (h <= 0 || w <= 0) {
            requestAnimationFrame(() => this.renderGradient());
            return;
        }

        this.canvasEl.width = w;
        this.canvasEl.height = h;
        const ctx = this.canvasEl.getContext('2d');
        if (!ctx) return;

        const fn = this.colorScale === 'viridis' ? interpolateViridis : interpolateTurbo;

        // Use CSS gradient stops — fn(t) returns a valid CSS color string, so
        // we hand it directly to the browser rather than trying to parse it.
        // Top of bar = max value (t=1), bottom = min value (t=0).
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        const steps = 32;
        for (let i = 0; i <= steps; i++) {
            const stopPos = i / steps;      // 0 = top, 1 = bottom
            const t = 1 - stopPos;          // t=1 at top (max), t=0 at bottom (min)
            if (this.rentalLegend?.divergent) {
                const c = t < .5
                    ? `rgb(${Math.round(224 + 31 * (t * 2))}, ${Math.round(116 + 126 * (t * 2))}, ${Math.round(43 + 192 * (t * 2))})`
                    : `rgb(${Math.round(255 - 197 * ((t - .5) * 2))}, ${Math.round(242 - 112 * ((t - .5) * 2))}, ${Math.round(235 + 15 * ((t - .5) * 2))})`;
                grad.addColorStop(stopPos, c);
            } else grad.addColorStop(stopPos, fn(t));
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    private showMarkers(): void {
        if (this.overlayEl) this.overlayEl.style.display = 'block';
        if (this.selectionOverlayEl && this.selectionStats) {
            this.selectionOverlayEl.style.display = 'block';
        }
    }

    private hideMarkers(): void {
        if (this.overlayEl) this.overlayEl.style.display = 'none';
        if (this.selectionOverlayEl) this.selectionOverlayEl.style.display = 'none';
    }

    /** Rebuild marker HTML for both overlays (but keep them hidden until hover). */
    private renderMarkers(): void {
        if (this.legendSummaryEl) {
            this.legendSummaryEl.innerHTML = this.rentalLegend
                ? `<span class="scale-legend-title">${this.rentalLegend.label}</span><span class="scale-legend-high">${this.rentalLegend.high}</span>${this.rentalLegend.midpoint ? `<span class="scale-legend-mid">${this.rentalLegend.midpoint}</span>` : ''}<span class="scale-legend-low">${this.rentalLegend.low}</span>${this.rentalLegend.key ? `<span class="scale-legend-key">${this.rentalLegend.key}</span>` : ''}`
                : '';
        }
        if (!this.overlayEl || !this.stats) {
            if (this.overlayEl) this.overlayEl.innerHTML = '';
            if (this.selectionOverlayEl) this.selectionOverlayEl.innerHTML = '';
            return;
        }

        const { min, max, median, std } = this.stats;
        if (max === min) {
            this.overlayEl.innerHTML = `<div class="scale-marker" style="top:50%">
                <div class="scale-marker-tick"></div>
                <div class="scale-marker-label">${formatPrice(min, this.colorMode as 'price' | 'price_psf')}</div>
            </div>`;
            if (this.selectionOverlayEl) this.selectionOverlayEl.innerHTML = '';
            return;
        }

        const mode = this.colorMode as 'price' | 'price_psf';
        const clamp = (v: number) => Math.max(min, Math.min(max, v));

        // ── Global markers ──────────────────────────────────────────────
        const globalPoints: Array<{ value: number; label: string }> = [
            { value: max,                label: formatPrice(max, mode) },
            { value: clamp(median + std), label: `+1σ  ${formatPrice(clamp(median + std), mode)}` },
            { value: median,              label: `Med  ${formatPrice(median, mode)}` },
            { value: clamp(median - std), label: `-1σ  ${formatPrice(clamp(median - std), mode)}` },
            { value: min,                label: formatPrice(min, mode) },
        ];

        const threshold = (max - min) * 0.04;
        const deduped = dedupePoints(globalPoints, threshold);

        this.overlayEl.innerHTML = deduped
            .map(({ value, label }) => {
                const pct = (value - min) / (max - min);
                const topPct = (1 - pct) * 100;
                return `<div class="scale-marker" style="top:${topPct.toFixed(2)}%">
                    <div class="scale-marker-tick"></div>
                    <div class="scale-marker-label">${label}</div>
                </div>`;
            })
            .join('');

        // ── Selection markers (positioned on the global scale) ──────────
        if (!this.selectionOverlayEl) return;

        if (!this.selectionStats) {
            this.selectionOverlayEl.innerHTML = '';
            return;
        }

        const sel = this.selectionStats;
        const selPoints: Array<{ value: number; label: string }> = [
            { value: sel.max,                              label: `Max ${formatPrice(sel.max, mode)}` },
            { value: clamp(sel.median + sel.std),          label: `+1σ  ${formatPrice(clamp(sel.median + sel.std), mode)}` },
            { value: sel.median,                           label: `Med  ${formatPrice(sel.median, mode)}` },
            { value: clamp(sel.median - sel.std),          label: `-1σ  ${formatPrice(clamp(sel.median - sel.std), mode)}` },
            { value: sel.min,                              label: `Min ${formatPrice(sel.min, mode)}` },
        ];

        const selDeduped = dedupePoints(selPoints, threshold);

        this.selectionOverlayEl.innerHTML = selDeduped
            .map(({ value, label }) => {
                const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
                const topPct = (1 - pct) * 100;
                return `<div class="scale-marker scale-marker--selection" style="top:${topPct.toFixed(2)}%">
                    <div class="scale-marker-tick"></div>
                    <div class="scale-marker-label">${label}</div>
                </div>`;
            })
            .join('');
    }

    /** Rental domains are global, clipped and supplied by the controller. */
    setRentalLegend(legend: { label: string; low: string; high: string; midpoint?: string; key?: string; divergent?: boolean } | null): void {
        this.rentalLegend = legend;
        this.renderGradient();
        this.renderMarkers();
    }

    /**
     * Watch the analytics panel for class changes (collapsed ↔ open on mobile)
     * and adjust the bar's max-height to stay above the drawer.
     */
    private watchAnalyticsPanel(): void {
        const panel = document.getElementById('analytics-panel');
        if (!panel || !this.gradientEl) return;

        const update = () => {
            const mobile = window.innerWidth < 768;
            const open = mobile && !panel.classList.contains('collapsed');
            if (this.gradientEl) {
                // When the drawer is open on mobile, constrain height so the
                // bar doesn't slide under the panel sheet.
                this.gradientEl.style.maxHeight = open
                    ? 'calc(35vh - 80px)'
                    : '';
            }
        };

        this.panelObserver = new MutationObserver(update);
        this.panelObserver.observe(panel, {
            attributes: true,
            attributeFilter: ['class'],
        });
        window.addEventListener('resize', update);
        update();
    }
}
