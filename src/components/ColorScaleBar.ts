import { interpolateViridis, interpolateTurbo } from 'd3-scale-chromatic';
import type { HDBTransaction } from '../data/DataLoader';
import { appState } from '../state/AppState';

export type ColorScale = 'viridis' | 'turbo';

/**
 * Build a 256-entry RGB lookup table for a given color scale.
 * Avoids repeated regex parsing inside the hot getFillColor path.
 */
export function buildColorLookup(scale: ColorScale): [number, number, number][] {
    const fn = scale === 'viridis' ? interpolateViridis : interpolateTurbo;
    return Array.from({ length: 256 }, (_, i) => {
        const t = i / 255;
        const s = fn(t);
        const m = s.match(/\d+/g)!;
        return [+m[0], +m[1], +m[2]] as [number, number, number];
    });
}

// ─── Stat helpers ────────────────────────────────────────────────────────────

interface Stats {
    min: number;
    max: number;
    median: number;
    std: number;
}

function computeStats(values: number[]): Stats | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const min = sorted[0];
    const max = sorted[n - 1];
    const median =
        n % 2 === 0
            ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
            : sorted[Math.floor(n / 2)];
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    return { min, max, median, std };
}

function formatPrice(v: number, mode: 'price' | 'price_psf'): string {
    if (mode === 'price_psf') return `$${Math.round(v).toLocaleString()}/psf`;
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    return `$${Math.round(v / 1000)}K`;
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
    private labelEl: HTMLElement | null = null;

    private colorScale: ColorScale = 'viridis';
    private colorMode: 'price' | 'price_psf' = 'price_psf';
    private stats: Stats | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private panelObserver: MutationObserver | null = null;

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

        // ── Overlay: tick marks + labels shown on hover ───────────────────
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'color-scale-overlay';

        // ── Small label beneath the bar showing current scale name ────────
        this.labelEl = document.createElement('div');
        this.labelEl.className = 'color-scale-label';
        this.labelEl.textContent = 'Viridis';

        this.gradientEl.appendChild(this.canvasEl);
        this.gradientEl.appendChild(this.overlayEl);
        this.outerEl.appendChild(this.gradientEl);
        this.outerEl.appendChild(this.labelEl);

        // ── Click: toggle color scale ─────────────────────────────────────
        this.gradientEl.addEventListener('click', () => {
            const next: ColorScale =
                this.colorScale === 'viridis' ? 'turbo' : 'viridis';
            appState.set('colorScale', next);
        });

        // ── Hover: show / hide tick markers ───────────────────────────────
        this.gradientEl.addEventListener('mouseenter', () => this.showMarkers());
        this.gradientEl.addEventListener('mouseleave', () => this.hideMarkers());

        // ── State subscriptions ───────────────────────────────────────────
        appState.subscribe('colorScale', (scale) => {
            this.colorScale = scale;
            this.labelEl!.textContent =
                scale === 'viridis' ? 'Viridis' : 'Turbo';
            this.renderGradient();
        });

        appState.subscribe('colorMode', (mode) => {
            this.colorMode = mode;
            this.refreshStats();
        });

        appState.subscribe('filteredTransactions', () => this.refreshStats());
        appState.subscribe('allTransactions', () => this.refreshStats());

        // ── Sync initial values ───────────────────────────────────────────
        this.colorScale = appState.get('colorScale');
        this.colorMode = appState.get('colorMode');
        this.labelEl.textContent =
            this.colorScale === 'viridis' ? 'Viridis' : 'Turbo';

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
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private refreshStats(): void {
        const filtered = appState.get('filteredTransactions');
        const all = appState.get('allTransactions');
        const source = filtered.length > 0 ? filtered : all;
        if (source.length === 0) return;
        const values = source.map((t: HDBTransaction) =>
            this.colorMode === 'price' ? t.resale_price : t.price_psf
        );
        this.stats = computeStats(values);
        this.renderGradient();
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

        const imageData = ctx.createImageData(w, h);
        const fn =
            this.colorScale === 'viridis' ? interpolateViridis : interpolateTurbo;

        for (let y = 0; y < h; y++) {
            // t=1 at top (max), t=0 at bottom (min)
            const t = 1 - y / Math.max(1, h - 1);
            const s = fn(t);
            const m = s.match(/\d+/g)!;
            const r = +m[0], g = +m[1], b = +m[2];
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                imageData.data[idx] = r;
                imageData.data[idx + 1] = g;
                imageData.data[idx + 2] = b;
                imageData.data[idx + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    private showMarkers(): void {
        if (!this.overlayEl || !this.stats) return;
        const { min, max, median, std } = this.stats;
        if (max === min) return; // Degenerate range

        const mode = this.colorMode;
        const clamp = (v: number) => Math.max(min, Math.min(max, v));

        const points: Array<{ value: number; label: string }> = [
            { value: max,                label: formatPrice(max, mode) },
            { value: clamp(median + std), label: `+1σ  ${formatPrice(clamp(median + std), mode)}` },
            { value: median,              label: `Med  ${formatPrice(median, mode)}` },
            { value: clamp(median - std), label: `-1σ  ${formatPrice(clamp(median - std), mode)}` },
            { value: min,                label: formatPrice(min, mode) },
        ];

        // Remove points that overlap (within 4% of the range)
        const threshold = (max - min) * 0.04;
        const deduped: typeof points = [];
        for (const p of points) {
            if (!deduped.some((u) => Math.abs(u.value - p.value) < threshold)) {
                deduped.push(p);
            }
        }

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

        this.overlayEl.style.display = 'block';
    }

    private hideMarkers(): void {
        if (this.overlayEl) this.overlayEl.style.display = 'none';
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
