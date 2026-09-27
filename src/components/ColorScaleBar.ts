import { rgb as d3rgb } from 'd3-color';
import { interpolateTurbo, interpolateViridis } from 'd3-scale-chromatic';
import { refreshIcons } from '../icons';
import {
    createScalePresentation,
    getMetricDefinition,
    metricValues,
    scaleScalar,
    type MapMetric,
    type NumericSummary,
    type ScalePresentation,
} from '../metrics';
import { appState } from '../state/AppState';

export type ColorScale = 'viridis' | 'turbo';

const STATS_OPEN_KEY = 'hdb-scale-stats-open';
const PALETTE_HINT_KEY = 'hdb-palette-hint-seen';
const PALETTE_HINT = 'Tip: select the color scale to change its palette.';

/** Build the map's 256-entry RGB lookup table. */
export function buildColorLookup(scale: ColorScale): [number, number, number][] {
    const fn = scale === 'viridis' ? interpolateViridis : interpolateTurbo;
    return Array.from({ length: 256 }, (_, index) => {
        const color = d3rgb(fn(index / 255));
        return [Math.round(color.r), Math.round(color.g), Math.round(color.b)];
    });
}

function readStatsOpen(): boolean {
    try { return sessionStorage.getItem(STATS_OPEN_KEY) === 'true'; } catch (_) { return false; }
}

function hasSeenPaletteHint(): boolean {
    try { return localStorage.getItem(PALETTE_HINT_KEY) === 'true'; } catch (_) { return false; }
}

/** A model-driven color scale control shared by resale and rental metrics. */
export class ColorScaleBar {
    private outerEl: HTMLElement | null = null;
    private gradientEl: HTMLElement | null = null;
    private canvasEl: HTMLCanvasElement | null = null;
    private domainEl: HTMLElement | null = null;
    private statsEl: HTMLElement | null = null;
    private allPlotEl: HTMLElement | null = null;
    private selectedPlotEl: HTMLElement | null = null;
    private zeroTickEl: HTMLElement | null = null;
    private statsButtonEl: HTMLButtonElement | null = null;
    private hintEl: HTMLElement | null = null;
    private hintTimer: ReturnType<typeof setTimeout> | null = null;
    private colorScale: ColorScale = 'viridis';
    private colorMode: MapMetric = 'price_psf';
    private presentation: ScalePresentation = createScalePresentation('price_psf', []);
    private statsOpen = false;
    private resizeObserver: ResizeObserver | null = null;
    private panelObserver: MutationObserver | null = null;
    private unsubscribe: Array<() => void> = [];

    private readonly onWindowResize = () => this.updateResponsiveLayout();
    private readonly onMetricControlInteraction = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const isMetricInteraction =
            (event.type === 'change' && target.matches('#color-mode-select')) ||
            (event.type === 'click' && !!target.closest('[data-rental-mode]'));
        if (isMetricInteraction) this.showPaletteHintOnce();
    };

    onAdd(_map: unknown): HTMLElement {
        this.outerEl = document.createElement('div');
        this.outerEl.className = 'color-scale-bar maplibregl-ctrl';

        this.gradientEl = document.createElement('div');
        this.gradientEl.className = 'color-scale-gradient';
        this.gradientEl.tabIndex = 0;
        this.gradientEl.setAttribute('role', 'button');
        this.gradientEl.title = 'Change color palette';

        this.canvasEl = document.createElement('canvas');
        this.canvasEl.className = 'color-scale-canvas';
        this.canvasEl.setAttribute('aria-hidden', 'true');

        this.allPlotEl = this.populationPlot('all');
        this.selectedPlotEl = this.populationPlot('selected');

        this.zeroTickEl = document.createElement('span');
        this.zeroTickEl.className = 'color-scale-zero-tick';
        this.zeroTickEl.setAttribute('aria-hidden', 'true');

        this.domainEl = document.createElement('div');
        this.domainEl.className = 'color-scale-domain';
        this.domainEl.setAttribute('aria-hidden', 'true');

        this.statsEl = document.createElement('div');
        this.statsEl.className = 'color-scale-stats';
        this.statsEl.setAttribute('aria-live', 'polite');
        this.gradientEl.append(
            this.allPlotEl,
            this.selectedPlotEl,
            this.canvasEl,
            this.zeroTickEl,
            this.domainEl,
            this.statsEl,
        );
        this.outerEl.appendChild(this.gradientEl);

        this.statsButtonEl = document.createElement('button');
        this.statsButtonEl.type = 'button';
        this.statsButtonEl.className = 'color-scale-stats-toggle';
        this.statsButtonEl.title = 'Toggle scale statistics';
        this.statsButtonEl.setAttribute('aria-label', 'Toggle scale statistics');
        this.statsButtonEl.innerHTML = '<i data-lucide="chart-no-axes-column" aria-hidden="true"></i>';
        this.outerEl.appendChild(this.statsButtonEl);
        refreshIcons();

        this.hintEl = document.createElement('div');
        this.hintEl.className = 'color-scale-palette-hint';
        this.hintEl.textContent = PALETTE_HINT;
        this.hintEl.setAttribute('role', 'status');
        this.hintEl.hidden = true;
        this.outerEl.appendChild(this.hintEl);

        this.statsOpen = readStatsOpen();
        this.statsButtonEl.addEventListener('click', () => this.setStatsOpen(!this.statsOpen));
        const togglePalette = () => {
            this.dismissPaletteHint();
            if (getMetricDefinition(this.colorMode).palette === 'diverging') return;
            appState.set('colorScale', this.colorScale === 'viridis' ? 'turbo' : 'viridis');
        };
        this.gradientEl.addEventListener('click', togglePalette);
        this.gradientEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                togglePalette();
            }
        });

        document.addEventListener('change', this.onMetricControlInteraction);
        document.addEventListener('click', this.onMetricControlInteraction);
        this.unsubscribe.push(
            appState.subscribe('colorScale', (scale) => {
                this.colorScale = scale;
                this.syncPaletteAccessibility();
                this.renderGradient();
            }),
            appState.subscribe('colorMode', (mode) => {
                this.colorMode = mode;
                this.presentation = createScalePresentation(mode, []);
                this.syncPaletteAccessibility();
                if (mode === 'price' || mode === 'price_psf') this.refreshResalePresentation();
                else this.renderPresentation();
            }),
            appState.subscribe('filteredTransactions', () => this.refreshResalePresentation()),
            appState.subscribe('selectedTransactions', () => this.refreshResalePresentation()),
        );

        this.colorScale = appState.get('colorScale');
        this.colorMode = appState.get('colorMode');
        this.syncPaletteAccessibility();
        this.refreshResalePresentation();
        this.setStatsOpen(this.statsOpen);

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.renderGradient());
            this.resizeObserver.observe(this.gradientEl);
        }
        this.watchAnalyticsPanel();
        return this.outerEl;
    }

    onRemove(): void {
        this.resizeObserver?.disconnect();
        this.panelObserver?.disconnect();
        this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
        document.removeEventListener('change', this.onMetricControlInteraction);
        document.removeEventListener('click', this.onMetricControlInteraction);
        window.removeEventListener('resize', this.onWindowResize);
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.outerEl?.remove();
        this.outerEl = null;
    }

    /** Canonical update path for rental and any future metric populations. */
    setPresentation(presentation: ScalePresentation): void {
        if (presentation.metric !== this.colorMode) return;
        this.presentation = presentation;
        this.renderPresentation();
    }

    private refreshResalePresentation(): void {
        if (this.colorMode !== 'price' && this.colorMode !== 'price_psf') return;
        const allValues = metricValues(this.colorMode, appState.get('filteredTransactions'));
        const selected = appState.get('selectedTransactions');
        const selectedValues = selected === null ? undefined : metricValues(this.colorMode, selected);
        this.presentation = createScalePresentation(this.colorMode, allValues, selectedValues);
        this.renderPresentation();
    }

    private setStatsOpen(open: boolean): void {
        this.statsOpen = open;
        try { sessionStorage.setItem(STATS_OPEN_KEY, String(open)); } catch (_) { /* optional preference */ }
        if (this.statsEl) this.statsEl.hidden = !open;
        if (this.statsButtonEl) this.statsButtonEl.setAttribute('aria-pressed', String(open));
        this.renderStats();
        this.renderPopulationPlots();
    }

    private renderPresentation(): void {
        this.renderGradient();
        this.renderDomain();
        this.renderStats();
        this.renderPopulationPlots();
    }

    private renderDomain(): void {
        if (!this.domainEl) return;
        this.domainEl.replaceChildren();
        const formatter = getMetricDefinition(this.colorMode).formatter;
        const domain = this.presentation.domain;
        const high = domain ? formatter(domain.max) : undefined;
        const low = domain ? formatter(domain.min) : undefined;
        if (!high || !low) return;
        this.domainEl.append(
            this.domainLabel('color-scale-domain-high', high),
            this.domainLabel('color-scale-domain-low', low),
        );
    }

    private domainLabel(className: string, value: string): HTMLElement {
        const label = document.createElement('span');
        label.className = className;
        label.textContent = value;
        return label;
    }

    private renderStats(): void {
        if (!this.statsEl || !this.statsOpen) return;
        const selected = this.presentation.selected?.summary ?? null;
        const all = this.presentation.all.summary;
        const value = (summary: NumericSummary | null, key: 'q3' | 'median' | 'q1' | 'count'): string => {
            if (!summary) return '—';
            return key === 'count' ? summary.count.toLocaleString() : this.formatStatValue(summary[key]);
        };
        const table = document.createElement('table');
        table.className = 'color-scale-stats-table';
        table.setAttribute('aria-label', 'Scale statistics');
        const head = table.createTHead().insertRow();
        head.append(document.createElement('th'));
        for (const label of ['Selected', 'All']) {
            const header = document.createElement('th');
            header.scope = 'col';
            header.textContent = label;
            head.appendChild(header);
        }
        const body = table.createTBody();
        const rows: Array<['Q3' | 'Median' | 'Q1' | 'n', 'q3' | 'median' | 'q1' | 'count']> = [
            ['Q3', 'q3'],
            ['Median', 'median'],
            ['Q1', 'q1'],
            ['n', 'count'],
        ];
        for (const [label, key] of rows) {
            const row = body.insertRow();
            const header = document.createElement('th');
            header.scope = 'row';
            header.textContent = label;
            row.append(header, this.statCell(value(selected, key)), this.statCell(value(all, key)));
        }
        this.statsEl.replaceChildren(table);
    }

    private formatStatValue(value: number): string {
        if (this.colorMode === 'price') {
            const magnitude = Math.abs(value);
            const divisor = magnitude >= 1_000_000 ? 1_000_000 : 1_000;
            const suffix = magnitude >= 1_000_000 ? 'm' : 'k';
            const compact = (value / divisor).toFixed(1).replace(/\.0$/, '');
            return `$${compact}${suffix}`;
        }
        const formatted = getMetricDefinition(this.colorMode).formatter(value);
        return this.colorMode === 'price_psf' || this.colorMode === 'rent_psf'
            ? formatted.replace('/psf', '')
            : formatted;
    }

    private statCell(value: string): HTMLTableCellElement {
        const cell = document.createElement('td');
        cell.textContent = value;
        return cell;
    }

    private populationPlot(population: 'all' | 'selected'): HTMLElement {
        const plot = document.createElement('div');
        plot.className = `color-scale-population color-scale-population--${population}`;
        plot.setAttribute('aria-hidden', 'true');
        plot.hidden = true;
        const box = document.createElement('span');
        box.className = 'color-scale-iqr-box';
        const median = document.createElement('span');
        median.className = 'color-scale-median-tick';
        plot.append(box, median);
        return plot;
    }

    private renderPopulationPlots(): void {
        this.renderPopulationPlot(this.allPlotEl, this.presentation.all.summary);
        this.renderPopulationPlot(this.selectedPlotEl, this.presentation.selected?.summary ?? null);
        if (this.zeroTickEl) {
            this.zeroTickEl.hidden = getMetricDefinition(this.colorMode).palette !== 'diverging' || !this.presentation.domain;
        }
    }

    private renderPopulationPlot(plot: HTMLElement | null, summary: NumericSummary | null): void {
        const domain = this.presentation.domain;
        if (!plot || !this.statsOpen || !summary || !domain) {
            if (plot) plot.hidden = true;
            return;
        }
        const q3 = scaleScalar(summary.q3, domain);
        const q1 = scaleScalar(summary.q1, domain);
        const median = scaleScalar(summary.median, domain);
        if (q3 === null || q1 === null || median === null) {
            plot.hidden = true;
            return;
        }
        plot.hidden = false;
        const box = plot.querySelector<HTMLElement>('.color-scale-iqr-box')!;
        const medianTick = plot.querySelector<HTMLElement>('.color-scale-median-tick')!;
        box.style.top = `${((1 - q3) * 100).toFixed(3)}%`;
        box.style.bottom = `${(q1 * 100).toFixed(3)}%`;
        medianTick.style.top = `${((1 - median) * 100).toFixed(3)}%`;
        plot.classList.toggle('is-clipped-high', summary.q3 > domain.max);
        plot.classList.toggle('is-clipped-low', summary.q1 < domain.min);
    }

    private syncPaletteAccessibility(): void {
        if (!this.gradientEl) return;
        const disabled = getMetricDefinition(this.colorMode).palette === 'diverging';
        this.gradientEl.setAttribute('aria-disabled', String(disabled));
        this.gradientEl.title = disabled ? 'Monthly surplus color scale' : 'Change color palette';
        this.gradientEl.setAttribute(
            'aria-label',
            disabled ? 'Monthly surplus color scale' : `${this.colorScale} color palette. Activate to change palette.`,
        );
    }

    private renderGradient(): void {
        if (!this.canvasEl || !this.gradientEl) return;
        const height = this.gradientEl.clientHeight;
        const width = this.gradientEl.clientWidth;
        if (height <= 0 || width <= 0) {
            requestAnimationFrame(() => this.renderGradient());
            return;
        }
        this.canvasEl.width = width;
        this.canvasEl.height = height;
        const context = this.canvasEl.getContext('2d');
        if (!context) return;
        const color = this.colorScale === 'viridis' ? interpolateViridis : interpolateTurbo;
        const gradient = context.createLinearGradient(0, 0, 0, height);
        for (let index = 0; index <= 32; index++) {
            const stop = index / 32;
            const scalar = 1 - stop;
            if (getMetricDefinition(this.colorMode).palette === 'diverging') {
                const divergent = scalar < .5
                    ? `rgb(${Math.round(224 + 31 * (scalar * 2))}, ${Math.round(116 + 126 * (scalar * 2))}, ${Math.round(43 + 192 * (scalar * 2))})`
                    : `rgb(${Math.round(255 - 197 * ((scalar - .5) * 2))}, ${Math.round(242 - 112 * ((scalar - .5) * 2))}, ${Math.round(235 + 15 * ((scalar - .5) * 2))})`;
                gradient.addColorStop(stop, divergent);
            } else {
                gradient.addColorStop(stop, color(scalar));
            }
        }
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
    }

    private showPaletteHintOnce(): void {
        if (!this.hintEl || hasSeenPaletteHint()) return;
        try { localStorage.setItem(PALETTE_HINT_KEY, 'true'); } catch (_) { /* storage unavailable */ }
        this.hintEl.hidden = false;
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => this.dismissPaletteHint(), 7000);
    }

    private dismissPaletteHint(): void {
        if (this.hintEl) this.hintEl.hidden = true;
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = null;
    }

    private watchAnalyticsPanel(): void {
        const panel = document.getElementById('analytics-panel');
        if (!panel) return;
        this.panelObserver = new MutationObserver(() => this.updateResponsiveLayout());
        this.panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', this.onWindowResize);
        this.updateResponsiveLayout();
    }

    private updateResponsiveLayout(): void {
        if (!this.gradientEl) return;
        const panel = document.getElementById('analytics-panel');
        const mobile = window.innerWidth < 768;
        const panelExpanded = Boolean(mobile && panel && !panel.classList.contains('collapsed'));
        const panelHeight = mobile && panel
            ? (panelExpanded ? panel.getBoundingClientRect().height : 60)
            : 0;
        const panelToggleClearance = mobile ? 36 : 12;
        document.documentElement.style.setProperty('--map-control-bottom', `${panelHeight + panelToggleClearance}px`);
        this.outerEl?.classList.toggle('panel-expanded', panelExpanded);
        if (panelExpanded) {
            const controlSize = Number.parseFloat(
                getComputedStyle(document.documentElement).getPropertyValue('--map-control-size'),
            ) || 36;
            const fixedRailHeight = (controlSize * 3) + 12;
            const availableScaleHeight = Math.max(
                48,
                window.innerHeight - panelHeight - panelToggleClearance - fixedRailHeight - 12,
            );
            this.gradientEl.style.minHeight = `${availableScaleHeight}px`;
            this.gradientEl.style.maxHeight = `${availableScaleHeight}px`;
        } else {
            this.gradientEl.style.minHeight = '';
            this.gradientEl.style.maxHeight = '';
        }
    }
}
