import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import { RentalDataLoader } from '../data/RentalDataLoader';
import type { ColorScaleBar } from '../components/ColorScaleBar';
import type { MapView, RentalMapPoint } from '../map/MapView';
import { appState } from '../state/AppState';
import {
    calculateScenario, createRentalEstimationContext, estimateRentForTarget, getMapRentalMetric, getPaletteDomain, singaporeToday,
    type RentalEstimate, type RentalScenario, type RentalEstimationContext,
} from './model';
import type { MapMetric, RentalAnalysisWindow, RentalDataset, ScenarioAssumptions } from './types';

type RentalMode = Exclude<MapMetric, 'price' | 'price_psf'>;
const RENTAL_MODES: Array<{ value: MapMetric; label: string; unit: string }> = [
    { value: 'price_psf', label: 'Price per sqft', unit: '$/psf' },
    { value: 'price', label: 'Resale price', unit: '$' },
    { value: 'rent', label: 'Monthly rent', unit: '$/month' },
    { value: 'rent_psf', label: 'Estimated rent / sqft', unit: '$/psf/month' },
    { value: 'gross_yield', label: 'Gross yield', unit: '%' },
    { value: 'monthly_surplus', label: 'Monthly surplus', unit: '$/month' },
];

interface EstimateRow { point: RentalMapPoint; estimate: RentalEstimate; scenario: RentalScenario | null; transaction: HDBTransaction; }

/** Owns rental-only UI and keeps it lazy: a failed rental fetch never blocks resale. */
export class RentalController {
    private readonly dataLoader: DataLoader;
    private readonly mapView: MapView;
    private readonly colorScale: ColorScaleBar;
    private dataset: RentalDataset | null = null;
    private readonly rentalDataLoader = new RentalDataLoader();
    private rows: EstimateRow[] = [];
    private loadPromise: Promise<void> | null = null;
    private requestVersion = 0;
    private windowRequestVersion = 0;
    private status = '';
    private estimationContext: RentalEstimationContext | null = null;
    private estimationContextKey = '';
    private analysisWindow: RentalAnalysisWindow | null = null;
    private overrides = new Map<string, { price?: number; marketValue?: number; rent?: number; area?: number; annualValue?: number }>();

    constructor(dataLoader: DataLoader, mapView: MapView, colorScale: ColorScaleBar) {
        this.dataLoader = dataLoader;
        this.mapView = mapView;
        this.colorScale = colorScale;
        this.renderControls();
        this.mapView.setOnRentalPointClick((point) => this.openDetails(point));
        try {
            const saved = JSON.parse(localStorage.getItem('hdb_rentalScenario') ?? '{}') as Record<string, unknown>;
            appState.set('rentalScenario', sanitizeScenario(saved));
        } catch (_) { /* absent or corrupt saved settings are ignored */ }
        try {
            const savedType = localStorage.getItem('hdb_rentalActiveFlatType');
            if (savedType && appState.get('globalFilters').flatTypes.includes(savedType)) appState.set('rentalActiveFlatType', savedType);
        } catch (_) { /* optional preference */ }
        appState.subscribe('colorMode', (mode) => {
            this.syncControls();
            if (this.isRentalMode(mode)) void this.loadAndRender();
            else this.colorScale.setRentalLegend(null);
        });
        appState.subscribe('globalFilters', () => {
            this.ensureActiveType();
            if (this.isRentalMode(appState.get('colorMode'))) void this.loadAndRender();
        });
        appState.subscribe('rentalScenario', () => {
            if (this.isRentalMode(appState.get('colorMode'))) this.renderRentalPoints();
        });
        appState.subscribe('rentalActiveFlatType', () => {
            this.syncControls();
            try {
                const type = appState.get('rentalActiveFlatType');
                if (type) localStorage.setItem('hdb_rentalActiveFlatType', type);
            } catch (_) { /* optional preference */ }
            if (this.isRentalMode(appState.get('colorMode'))) this.updateLegend();
        });
        this.ensureActiveType();
        this.syncControls();
        if (this.isRentalMode(appState.get('colorMode') as MapMetric)) void this.loadAndRender();
    }

    private isRentalMode(mode: MapMetric): mode is RentalMode { return mode !== 'price' && mode !== 'price_psf'; }

    private renderControls(): void {
        const shell = document.createElement('section');
        shell.id = 'rental-map-controls';
        shell.className = 'rental-map-controls';
        shell.innerHTML = `<button type="button" class="rental-metric-trigger" aria-haspopup="dialog" aria-expanded="false">
            <span class="rental-metric-label">Colour by: Price per sqft</span><span class="rental-active-type" hidden></span><span aria-hidden="true">▾</span>
          </button>
          <div class="rental-controls-menu" hidden>
            <p class="rental-control-title">Map colour</p>
            <div class="rental-mode-options"></div>
            <div class="rental-type-row" hidden><label>Flat type <select class="rental-type-select"></select></label></div>
            <fieldset class="rental-window-row" hidden>
              <legend>Rental evidence window</legend>
              <span class="rental-window-inputs">
                <label>From<input type="month" class="rental-window-min" aria-describedby="rental-window-hint"></label>
                <span aria-hidden="true">to</span>
                <label>To<input type="month" class="rental-window-max" aria-describedby="rental-window-hint"></label>
              </span>
              <small id="rental-window-hint">Choose the start month, then the end month. Independent of the resale history view.</small>
            </fieldset>
            <label class="rental-palette-row">Appearance <select class="rental-palette"><option value="viridis">Viridis</option><option value="turbo">Turbo</option></select></label>
            <button type="button" class="rental-assumptions-open">Edit assumptions</button>
            <p class="rental-status" aria-live="polite"></p>
            <button type="button" class="rental-retry" hidden>Retry rental data</button>
          </div>`;
        document.body.appendChild(shell);
        const closeMenu = () => {
            shell.querySelector<HTMLElement>('.rental-controls-menu')!.hidden = true;
            shell.querySelector('.rental-metric-trigger')!.setAttribute('aria-expanded', 'false');
        };
        shell.querySelector<HTMLButtonElement>('.rental-metric-trigger')!.addEventListener('click', () => {
            const menu = shell.querySelector<HTMLElement>('.rental-controls-menu')!;
            menu.hidden = !menu.hidden;
            shell.querySelector<HTMLButtonElement>('.rental-metric-trigger')!.setAttribute('aria-expanded', String(!menu.hidden));
        });
        shell.querySelector('.rental-mode-options')!.innerHTML = RENTAL_MODES.map((mode) =>
            `<button type="button" data-rental-mode="${mode.value}"><span>${mode.label}</span><small>${mode.unit}</small></button>`).join('');
        shell.querySelectorAll<HTMLButtonElement>('[data-rental-mode]').forEach((button) => button.addEventListener('click', () => {
            const mode = button.dataset.rentalMode as MapMetric;
            appState.set('colorMode', mode);
            try { localStorage.setItem('hdb_colorMode', mode); } catch (_) { /* local storage optional */ }
            if (!this.isRentalMode(mode)) closeMenu();
        }));
        shell.querySelector<HTMLSelectElement>('.rental-type-select')!.addEventListener('change', (event) => {
            appState.set('rentalActiveFlatType', (event.target as HTMLSelectElement).value);
        });
        shell.querySelector<HTMLSelectElement>('.rental-palette')!.addEventListener('change', (event) =>
            appState.set('colorScale', (event.target as HTMLSelectElement).value as 'viridis' | 'turbo'));
        const minInput = shell.querySelector<HTMLInputElement>('.rental-window-min')!;
        const maxInput = shell.querySelector<HTMLInputElement>('.rental-window-max')!;
        const updateWindow = () => {
            const min = minInput.value;
            const max = maxInput.value;
            const resaleLatest = this.dataLoader.getAllData().reduce((latest, row) => row.month > latest ? row.month : latest, '');
            const latest = this.dataset && resaleLatest > this.dataset.maxMonth ? this.dataset.maxMonth : resaleLatest;
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(min) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(max) || min > max ||
                !this.dataset || min < this.dataset.minMonth || max > latest) {
                this.status = `Choose an evidence window between ${this.dataset?.minMonth ?? 'the first available month'} and ${latest}, with the start before the end.`;
                shell.querySelector('.rental-status')!.textContent = this.status; return;
            }
            const requestedWindow = { minMonth: min, maxMonth: max };
            const version = ++this.windowRequestVersion;
            void this.dataLoader.ensureDateRange(min, max).then(() => {
                if (version !== this.windowRequestVersion) return;
                this.analysisWindow = requestedWindow; this.estimationContext = null;
                this.status = `Rental evidence: ${this.dataset!.minMonth}–${this.dataset!.maxMonth}`;
                this.syncControls();
                if (this.isRentalMode(appState.get('colorMode') as MapMetric)) this.renderRentalPoints();
            }).catch(() => { if (version === this.windowRequestVersion) { this.status = 'Could not load resale comparables for that evidence window.'; this.syncControls(); } });
        };
        minInput.addEventListener('change', () => {
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(minInput.value)) { updateWindow(); return; }
            this.status = `Start month: ${minInput.value}. Now choose the end month.`;
            shell.querySelector('.rental-status')!.textContent = this.status;
            maxInput.focus({ preventScroll: true });
            // Native month controls close after one value. Advance to the end
            // control so the next picker interaction completes the range.
            try { maxInput.showPicker(); } catch (_) { /* keyboard and unsupported browsers keep focus on the end control */ }
        });
        maxInput.addEventListener('change', updateWindow);
        shell.querySelector<HTMLButtonElement>('.rental-assumptions-open')!.addEventListener('click', () => this.openScenarioEditor());
        shell.querySelector<HTMLButtonElement>('.rental-retry')!.addEventListener('click', () => void this.loadAndRender());
        document.addEventListener('click', (event) => {
            if (!shell.contains(event.target as Node)) closeMenu();
        });
        shell.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { closeMenu(); shell.querySelector<HTMLButtonElement>('.rental-metric-trigger')!.focus(); }
        });
    }

    private ensureActiveType(): void {
        const types = appState.get('globalFilters').flatTypes;
        const current = appState.get('rentalActiveFlatType');
        if (current && types.includes(current)) return;
        appState.set('rentalActiveFlatType', types.includes('4 ROOM') ? '4 ROOM' : types[0] ?? null);
    }

    private syncControls(): void {
        const shell = document.getElementById('rental-map-controls');
        if (!shell) return;
        const mode = appState.get('colorMode') as MapMetric;
        const descriptor = RENTAL_MODES.find((item) => item.value === mode) ?? RENTAL_MODES[0];
        shell.querySelector('.rental-metric-label')!.textContent = `Colour by: ${descriptor.label}`;
        const visibleType = shell.querySelector<HTMLElement>('.rental-active-type')!;
        visibleType.textContent = appState.get('rentalActiveFlatType') ?? '';
        visibleType.hidden = !this.isRentalMode(mode);
        shell.querySelectorAll<HTMLButtonElement>('[data-rental-mode]').forEach((button) =>
            button.classList.toggle('active', button.dataset.rentalMode === mode));
        const typeRow = shell.querySelector<HTMLElement>('.rental-type-row')!;
        typeRow.hidden = !this.isRentalMode(mode);
        const windowRow = shell.querySelector<HTMLElement>('.rental-window-row')!;
        windowRow.hidden = !this.isRentalMode(mode);
        const typeSelect = shell.querySelector<HTMLSelectElement>('.rental-type-select')!;
        const types = appState.get('globalFilters').flatTypes;
        typeSelect.innerHTML = types.map((type) => `<option>${escapeHtml(type)}</option>`).join('');
        typeSelect.value = appState.get('rentalActiveFlatType') ?? '';
        shell.querySelector<HTMLSelectElement>('.rental-palette')!.value = appState.get('colorScale');
        const resaleLatest = this.dataLoader.getAllData().reduce((latest, row) => row.month > latest ? row.month : latest, '');
        const latest = this.dataset && resaleLatest > this.dataset.maxMonth ? this.dataset.maxMonth : resaleLatest;
        const minInput = shell.querySelector<HTMLInputElement>('.rental-window-min')!;
        const maxInput = shell.querySelector<HTMLInputElement>('.rental-window-max')!;
        if (this.dataset) {
            minInput.min = this.dataset.minMonth;
            maxInput.min = this.dataset.minMonth;
        }
        minInput.max = latest;
        maxInput.max = latest;
        if (this.analysisWindow) {
            minInput.value = this.analysisWindow.minMonth;
            maxInput.value = this.analysisWindow.maxMonth;
        }
        const status = shell.querySelector('.rental-status')!;
        status.textContent = this.status;
        shell.querySelector<HTMLButtonElement>('.rental-retry')!.hidden = !this.status.startsWith('Rental data unavailable');
    }

    private async loadAndRender(): Promise<void> {
        if (this.dataset) { this.renderRentalPoints(); return; }
        if (!this.loadPromise) {
            this.status = 'Loading whole-flat rental evidence…'; this.syncControls();
            const version = ++this.requestVersion;
            this.loadPromise = (async () => {
                // The default resale filter may begin before 2025, but rental analysis
                // needs shared recent comparables regardless of the visual history filter.
                await this.dataLoader.ensureDateRange('2025-01');
                const dataset = await this.rentalDataLoader.load();
                if (version !== this.requestVersion) return;
                this.dataset = dataset;
                if (!this.analysisWindow) {
                    const resaleLatest = this.dataLoader.getAllData().map((transaction) => transaction.month).sort().at(-1) ?? dataset.maxMonth;
                    const sharedLatest = resaleLatest < dataset.maxMonth ? resaleLatest : dataset.maxMonth;
                    const year = Number(sharedLatest.slice(0, 4));
                    this.analysisWindow = { minMonth: `${year - 1}-01`, maxMonth: sharedLatest };
                }
                this.status = `Rental evidence: ${dataset.minMonth}–${dataset.maxMonth}`;
            })().catch((error: unknown) => {
                this.status = `Rental data unavailable. Retry: ${error instanceof Error ? error.message : 'request failed'}`;
                this.dataset = null;
            }).finally(() => { this.loadPromise = null; this.syncControls(); });
        }
        await this.loadPromise;
        this.renderRentalPoints();
    }

    private renderRentalPoints(): void {
        if (!this.dataset || !this.isRentalMode(appState.get('colorMode') as MapMetric)) return;
        const request = ++this.requestVersion;
        const all = this.dataLoader.getAllData();
        const filters = appState.get('globalFilters');
        const selectedTypes = filters.flatTypes;
        const minMonth = this.analysisWindow?.minMonth ?? '2025-01';
        const maxMonth = this.analysisWindow?.maxMonth ?? '9999-12';
        const recent = all.filter((transaction) => transaction.month >= minMonth && transaction.month <= maxMonth && selectedTypes.includes(transaction.flat_type));
        const targets = new Map<string, HDBTransaction>();
        for (const transaction of recent) {
            const key = `${transaction.block}|${transaction.street_name}|${transaction.flat_type}`;
            const existing = targets.get(key);
            if (!existing || transaction.month > existing.month) targets.set(key, transaction);
        }
        const scenarioInputs = appState.get('rentalScenario') as Partial<ScenarioAssumptions>;
        const resaleFilters = { floorMin: filters.floorMin, leaseMin: filters.leaseMin, leaseMax: filters.leaseMax };
        const contextKey = `${this.dataset.generatedAt}|${all.length}|${resaleFilters.floorMin}|${resaleFilters.leaseMin}|${resaleFilters.leaseMax}|${this.analysisWindow?.minMonth}|${this.analysisWindow?.maxMonth}`;
        if (!this.estimationContext || this.estimationContextKey !== contextKey) {
            this.estimationContext = createRentalEstimationContext({ rentalRecords: this.dataset.records, resaleComparables: all,
                classifications: this.dataset.classifications, resaleFilters, analysisWindow: this.analysisWindow ?? undefined });
            this.estimationContextKey = contextKey;
        }
        const context = this.estimationContext;
        this.rows = [...targets.values()].map((transaction) => {
            const key = this.overrideKey(transaction);
            const override = this.overrides.get(key);
            const estimate = estimateRentForTarget(context, { block: transaction.block, streetName: transaction.street_name, flatType: transaction.flat_type, town: transaction.town,
                latitude: transaction.latitude, longitude: transaction.longitude, leaseCommencement: transaction.lease_commence_date, nearestMrtExitMeters: transaction.mrt_distance_m });
            const effectiveRent = override?.rent ?? estimate.monthlyRent;
            const effectiveArea = override?.area ?? estimate.resale.areaSummary?.median;
            if (effectiveArea && effectiveRent) {
                // Rent source lacks area. This is the explicit area proxy the user supplied.
                estimate.rentPsf = effectiveRent / (effectiveArea * 10.7639104167);
            }
            if (override?.rent !== undefined) estimate.monthlyRent = override.rent;
            const purchasePrice = override?.price ?? estimate.resale.summary?.median ?? 0;
            const currentMonthlyRent = effectiveRent ?? 0;
            const canModelPurchase = override?.price !== undefined || estimate.resale.qualifiedForMap;
            const scenario = estimate.eligibility !== 'prohibited' && canModelPurchase && purchasePrice > 0 && currentMonthlyRent > 0
                ? calculateScenario({ purchasePrice, currentMonthlyRent, evidenceAsOf: estimate.analysisWindow?.maxMonth,
                    marketValue: override?.marketValue, annualValueOverride: override?.annualValue, assumptions: scenarioInputs }) : null;
            const metric = getMapRentalMetric(appState.get('colorMode') as RentalMode, estimate, scenario);
            const point: RentalMapPoint = { block: transaction.block, streetName: transaction.street_name, flatType: transaction.flat_type,
                latitude: transaction.latitude, longitude: transaction.longitude,
                rent: getMapRentalMetric('rent', estimate, scenario).value, rentPsf: getMapRentalMetric('rent_psf', estimate, scenario).value,
                grossYield: getMapRentalMetric('gross_yield', estimate, scenario).value, monthlySurplus: getMapRentalMetric('monthly_surplus', estimate, scenario).value,
                provenance: estimate.source === 'nearby_blocks' ? 'nearby' : estimate.source === 'same_block' ? 'same_block' : 'insufficient',
                eligibility: estimate.eligibility === 'prohibited' ? 'restricted' : estimate.eligibility === 'unknown' ? 'unknown' : 'eligible',
                metricValue: metric.value, estimate, scenario };
            return { point, estimate, scenario, transaction };
        });
        if (request !== this.requestVersion) return;
        this.mapView.setRentalPoints(this.rows.map((row) => row.point));
        this.updateLegend();
    }

    private updateLegend(): void {
        const mode = appState.get('colorMode') as RentalMode;
        const descriptor = RENTAL_MODES.find((item) => item.value === mode)!;
        const values = this.rows.filter((row) => row.point.flatType === appState.get('rentalActiveFlatType'))
            .map((row) => row.point.metricValue as number | null);
        const domain = getPaletteDomain(values);
        const format = (value: number) => mode === 'gross_yield' ? `${value.toFixed(1)}%` :
            mode === 'rent_psf' ? `$${value.toFixed(2)}/psf` : money(value);
        if (!domain) { this.mapView.setRentalDomain(null); this.colorScale.setRentalLegend(null); return; }
        const extent = mode === 'monthly_surplus' ? Math.max(Math.abs(domain.min), Math.abs(domain.max), 1) : 0;
        this.mapView.setRentalDomain(mode === 'monthly_surplus' ? { min: -extent, max: extent, extent } : { min: domain.min, max: domain.max });
        this.colorScale.setRentalLegend({ label: `${descriptor.label}${domain.lowClipped || domain.highClipped ? ' (5–95%)' : ''}`,
            low: format(mode === 'monthly_surplus' ? -extent : domain.min), high: format(mode === 'monthly_surplus' ? extent : domain.max),
            midpoint: mode === 'monthly_surplus' ? '$0' : undefined,
            key: 'Solid: same block · outlined: nearby · grey: insufficient · ?: eligibility unverified · ⚠: restricted', divergent: mode === 'monthly_surplus' });
    }

    private openDetails(point: RentalMapPoint): void {
        const matching = this.rows
            .filter((row) => row.point.block === point.block && row.point.streetName === point.streetName)
            .sort((a, b) => a.point.flatType.localeCompare(b.point.flatType, undefined, { numeric: true }));
        const active = matching.find((row) => row.point.flatType === point.flatType) ?? matching[0];
        if (!active) return;
        const modal = this.modal('rental-detail-modal', `Blk ${escapeHtml(point.block)} ${escapeHtml(point.streetName)}`);

        const summaries = matching.map((row) => row.estimate.selected?.summary).filter((summary) => summary !== null && summary !== undefined);
        let scaleMin = summaries.length ? Math.min(...summaries.map((summary) => summary.min)) : 0;
        let scaleMax = summaries.length ? Math.max(...summaries.map((summary) => summary.max)) : 1;
        if (scaleMin === scaleMax) {
            const padding = Math.max(100, scaleMin * .05);
            scaleMin -= padding; scaleMax += padding;
        }
        const position = (value: number) => Math.max(0, Math.min(100, ((value - scaleMin) / (scaleMax - scaleMin)) * 100));
        const distributionRows = matching.map((row) => {
            const selected = row.point.flatType === point.flatType;
            const override = this.overrides.get(this.overrideKey(row.transaction));
            const evidence = row.estimate.selected?.summary;
            const source = row.estimate.source === 'same_block' ? 'same block' : row.estimate.source === 'nearby_blocks' ? 'nearby' : 'insufficient';
            const plot = evidence ? `<div class="rental-boxplot" role="img" aria-label="${escapeAttribute(`${row.point.flatType}: ${evidence.count} rents, ${money(evidence.min)} to ${money(evidence.max)}, median ${money(evidence.median)}`)}"
                style="--plot-min:${position(evidence.min)}%;--plot-q1:${position(evidence.q1)}%;--plot-median:${position(evidence.median)}%;--plot-q3:${position(evidence.q3)}%;--plot-max:${position(evidence.max)}%">
                <span class="rental-boxplot-whisker"></span><span class="rental-boxplot-cap rental-boxplot-cap--min"></span><span class="rental-boxplot-cap rental-boxplot-cap--max"></span><span class="rental-boxplot-box"></span><span class="rental-boxplot-median"></span>
              </div>` : '<span class="rental-distribution-empty">Insufficient evidence</span>';
            return `<div class="rental-distribution-row${selected ? ' active' : ''}" role="listitem">
              <div class="rental-distribution-type"><strong>${escapeHtml(row.point.flatType)}</strong>${selected ? '<span>Selected</span>' : ''}${override ? '<small>Adjusted</small>' : ''}</div>
              <div class="rental-distribution-plot">${plot}<small>${evidence ? `${evidence.count} rents · ${source}` : source}</small></div>
              <div class="rental-distribution-value"><strong>${row.estimate.monthlyRent === null ? '—' : money(row.estimate.monthlyRent)}</strong><small>estimate</small></div>
            </div>`;
        }).join('');
        const s = active.scenario;
        const activeOverride = this.overrides.get(this.overrideKey(active.transaction));
        const evidenceCount = active.estimate.selected?.summary?.count;
        const evidenceSource = active.estimate.source === 'same_block' ? 'Same-block evidence' : active.estimate.source === 'nearby_blocks' ? 'Nearby-block estimate' : 'Insufficient rental evidence';
        const eligibility = active.estimate.eligibility === 'prohibited' ? 'Whole-flat rental prohibited' : active.estimate.provisional ? 'Eligibility unverified' : 'Rental eligibility verified';
        const purchaseEstimate = activeOverride?.price ?? active.estimate.resale.summary?.median ?? null;
        const surplusTone = s ? (s.propertyMonthlySurplus < 0 ? ' negative' : ' positive') : '';
        modal.querySelector('.rental-modal-body')!.innerHTML = `<div class="rental-detail-meta">
            <span class="rental-type-chip">${escapeHtml(active.point.flatType)}</span>
            <span>${evidenceSource}${evidenceCount ? ` · ${evidenceCount} rents` : ''}</span>
            <span class="rental-eligibility${active.estimate.eligibility === 'prohibited' ? ' restricted' : ''}">${eligibility}</span>
          </div>
          <section class="rental-outcome" aria-labelledby="rental-outcome-title">
            <div class="rental-section-heading"><h3 id="rental-outcome-title">Rental outcome</h3>${s ? `<span>Rental starts ${formatMonth(s.rentalStartDate.slice(0, 7))}</span>` : ''}</div>
            ${s ? `<div class="rental-outcome-layout">
              <div class="rental-outcome-primary"><span>Monthly surplus</span><strong class="${surplusTone}">${money(s.propertyMonthlySurplus)}</strong><small>after reserve and property tax</small></div>
              <dl class="rental-outcome-metrics">
                <div><dt>Projected rent</dt><dd>${money(s.projectedMonthlyRent)}<small>/month at MOP</small></dd></div>
                <div><dt>Gross yield</dt><dd>${percent(s.grossYield)}<small>on purchase cost</small></dd></div>
                <div><dt>Purchase estimate</dt><dd>${purchaseEstimate === null ? '—' : money(purchaseEstimate)}<small>${activeOverride?.price !== undefined ? 'adjusted input' : 'resale median'}</small></dd></div>
              </dl>
            </div>` : `<p class="rental-outcome-unavailable">${missingScenarioText(active.estimate, activeOverride?.price !== undefined)}</p>`}
          </section>
          <section class="rental-distribution" aria-labelledby="rental-distribution-title">
            <div class="rental-section-heading"><h3 id="rental-distribution-title">Rental range by flat type</h3><span>Box shows the middle 50%</span></div>
            <div class="rental-distribution-list" role="list">${distributionRows}</div>
            ${summaries.length ? `<div class="rental-distribution-axis"><span>${money(scaleMin)}</span><span>${money(scaleMax)}</span></div>` : ''}
          </section>
          <div class="rental-disclosures">
            <details class="rental-disclosure">
              <summary><i data-lucide="chevron-down" aria-hidden="true"></i><span>Scenario details</span><small>Financing, tax and upfront capital</small></summary>
              ${s ? `<dl class="rental-detail-stats">
                <div><dt>Current rent</dt><dd>${money(s.currentMonthlyRent)}</dd></div><div><dt>Basic surplus</dt><dd>${money(s.basicMonthlySurplus)}/mo</dd></div>
                <div><dt>Reserve-adjusted surplus</dt><dd>${money(s.reserveAdjustedMonthlySurplus)}/mo</dd></div><div><dt>Mortgage after MOP</dt><dd>${money(s.rentalMonthlyPayment)}/mo</dd></div>
                <div><dt>Loan balance at rental</dt><dd>${money(s.balanceAtRentalStart)}</dd></div><div><dt>Remaining mortgage</dt><dd>${s.remainingMortgageMonths / 12} years</dd></div>
                <div><dt>Annual Value ${activeOverride?.annualValue !== undefined ? '(adjusted)' : '(rent proxy)'}</dt><dd>${money(s.annualValue)}</dd></div><div><dt>Annual property tax</dt><dd>${money(s.annualPropertyTax)}</dd></div>
                <div><dt>Upfront capital</dt><dd>${money(s.upfrontCapital)}</dd></div><div><dt>Cash-flow return</dt><dd>${percent(s.cashFlowReturnOnInitialCapital)}</dd></div>
                <div><dt>Equity / BSD / mortgage duty</dt><dd>${money(s.equityContribution)} / ${money(s.bsd)} / ${money(s.mortgageDuty)}</dd></div><div><dt>First-year principal</dt><dd>${money(s.firstRentalYearPrincipal)}</dd></div>
              </dl>` : `<p>${missingScenarioText(active.estimate, activeOverride?.price !== undefined)}</p>`}
            </details>
            <details class="rental-disclosure">
              <summary><i data-lucide="chevron-down" aria-hidden="true"></i><span>Evidence &amp; methodology</span><small>Sources, filters and model boundaries</small></summary>
              <dl class="rental-evidence-list">
                <div><dt>Evidence window</dt><dd>${active.estimate.analysisWindow?.minMonth ?? '—'}–${active.estimate.analysisWindow?.maxMonth ?? '—'}</dd></div>
                <div><dt>Same block</dt><dd>${summaryText(active.estimate.direct.summary)} (raw ${active.estimate.direct.rawCount}; excluded ${active.estimate.direct.excludedInvalid} invalid and ${active.estimate.direct.excludedOutliers} outliers)</dd></div>
                ${active.estimate.source === 'nearby_blocks' ? `<div><dt>Nearby fallback</dt><dd>${summaryText(active.estimate.nearby?.summary)} across ${active.estimate.nearby?.blockCount ?? 0} blocks</dd></div>` : ''}
                <div><dt>Resale comparables</dt><dd>${summaryText(active.estimate.resale.summary)}; area ${areaSummaryText(active.estimate.resale.areaSummary)}</dd></div>
                <div><dt>Nearest MRT exit</dt><dd>${active.estimate.resale.nearestMrtExitMeters === null ? 'Unavailable' : `${Math.round(active.estimate.resale.nearestMrtExitMeters)} m straight-line`}</dd></div>
                <div><dt>Classification</dt><dd>${active.estimate.eligibilityClassification ? `${escapeHtml(active.estimate.eligibilityClassification.category)} / ${escapeHtml(active.estimate.eligibilityClassification.projectName ?? 'unnamed project')} (${escapeHtml(active.estimate.eligibilityClassification.reviewedAt)}) · <a href="${escapeHtml(active.estimate.eligibilityClassification.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>` : 'Unknown; rental eligibility unverified'}</dd></div>
              </dl>
              <p class="rental-method-note">Rental records are whole-flat figures. Floor and lease filters apply only to resale comparables. Cash flow includes the operating reserve, mortgage payment and estimated non-owner property tax. It excludes income tax, CPF funding, ABSD, renovation, legal costs and the five-year holding period. Principal repayment is equity accumulation, not an expense.</p>
            </details>
            <details class="rental-disclosure">
              <summary><i data-lucide="chevron-down" aria-hidden="true"></i><span>Adjust inputs</span><small>Price, rent, area and Annual Value</small></summary>
              <form class="rental-overrides"><p>Changes apply only to this block and flat type.</p>
          ${numberField('price', 'Target price', this.overrides.get(this.overrideKey(active.transaction))?.price ?? active.estimate.resale.summary?.median ?? null)}
          ${numberField('marketValue', 'Market value for BSD (optional)', this.overrides.get(this.overrideKey(active.transaction))?.marketValue ?? null)}
          ${numberField('rent', 'Current rent', this.overrides.get(this.overrideKey(active.transaction))?.rent ?? active.estimate.monthlyRent)}
          ${numberField('area', 'Area (sqm)', this.overrides.get(this.overrideKey(active.transaction))?.area ?? active.estimate.resale.areaSummary?.median ?? null)}
          ${numberField('annualValue', 'Annual Value', this.overrides.get(this.overrideKey(active.transaction))?.annualValue ?? null)}
                <div class="rental-override-actions"><button>Apply changes</button><button type="button" class="rental-reset" ${activeOverride ? '' : 'disabled'}>Reset</button></div>
              </form>
            </details>
          </div>`;
        // @ts-ignore - lucide is installed globally by icons.ts at app startup.
        if (window.lucide) window.lucide.createIcons();
        modal.querySelector<HTMLFormElement>('.rental-overrides')!.addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
            const read = (name: string, allowZero: boolean) => {
                const raw = (form.elements.namedItem(name) as HTMLInputElement).value.trim();
                if (raw === '') return { value: undefined, valid: true };
                const value = Number(raw); return { value, valid: Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) };
            };
            const marketValue = read('marketValue', false), price = read('price', false), rent = read('rent', false), area = read('area', false), annualValue = read('annualValue', true);
            if (![price, marketValue, rent, area, annualValue].every((item) => item.valid)) {
                let error = form.querySelector<HTMLElement>('.rental-form-error');
                if (!error) { error = document.createElement('p'); error.className = 'rental-form-error'; form.prepend(error); }
                error.textContent = 'Price, market value, rent and area must be greater than zero. Annual Value may be zero.'; return;
            }
            this.overrides.set(this.overrideKey(active.transaction), { price: price.value, marketValue: marketValue.value, rent: rent.value, area: area.value, annualValue: annualValue.value });
            this.closeModal(modal); this.renderRentalPoints(); requestAnimationFrame(() => this.openDetails(active.point)); });
        modal.querySelector<HTMLButtonElement>('.rental-reset')!.addEventListener('click', () => { this.overrides.delete(this.overrideKey(active.transaction)); this.closeModal(modal); this.renderRentalPoints(); });
    }

    private openScenarioEditor(): void {
        const existing = appState.get('rentalScenario');
        const modal = this.modal('rental-scenario-modal', 'Rental scenario assumptions');
        modal.querySelector('.rental-modal-body')!.innerHTML = `<p>Uses an illustrative 3% rate by default, not a current bank quote. Enter your bank quotation before relying on the result. <a href="https://www.dbs.com.sg/personal/loans/homeloans/hdb-loan" target="_blank" rel="noreferrer">Bank package information</a>.</p><form class="rental-scenario-form">
          ${numberField('purchaseDate', 'Purchase date', null, 'date', String(existing.purchaseDate ?? singaporeToday()))}
          ${numberField('ltv', 'LTV (%)', Number(existing.ltv ?? .75) * 100)} ${numberField('mortgageYears', 'Mortgage tenure (years)', Number(existing.mortgageYears ?? 25))}
          ${numberField('initialRate', 'Rate before MOP (%)', Number(existing.initialRate ?? .03) * 100)} ${numberField('rentalRate', 'Rate at rental start (%)', Number(existing.rentalRate ?? .03) * 100)}
          ${numberField('annualRentGrowth', 'Annual rent growth (%)', Number(existing.annualRentGrowth ?? 0) * 100)} ${numberField('operatingReserve', 'Operating reserve (%)', Number(existing.operatingReserve ?? .10) * 100)}
          <button>Apply scenario</button></form>`;
        modal.querySelector('form')!.addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
            const number = (name: string) => Number((form.elements.namedItem(name) as HTMLInputElement).value);
            const candidate: Record<string, unknown> = { purchaseDate: (form.elements.namedItem('purchaseDate') as HTMLInputElement).value, ltv: number('ltv') / 100,
                mortgageYears: number('mortgageYears'), initialRate: number('initialRate') / 100, rentalRate: number('rentalRate') / 100,
                annualRentGrowth: number('annualRentGrowth') / 100, operatingReserve: number('operatingReserve') / 100 };
            const scenario = sanitizeScenario(candidate);
            if (Object.keys(scenario).length !== 7) {
                const error = document.createElement('p'); error.className = 'rental-form-error'; error.textContent = 'Check the date and values. The model accepts 0–100% rates/reserve, LTV 0–100%, 1–50 years, and rent growth −99% to 100%.';
                form.querySelector('.rental-form-error')?.remove(); form.prepend(error); return;
            }
            appState.set('rentalScenario', scenario);
            try { localStorage.setItem('hdb_rentalScenario', JSON.stringify(appState.get('rentalScenario'))); } catch (_) { /* optional */ }
            this.closeModal(modal); });
    }

    private modal(id: string, title: string): HTMLElement {
        document.getElementById(id)?.remove(); const modal = document.createElement('div'); modal.id = id; modal.className = 'rental-modal';
        modal.innerHTML = `<div class="rental-modal-card" role="dialog" aria-modal="true" aria-labelledby="${id}-title"><header><h2 id="${id}-title">${title}</h2><button type="button" aria-label="Close"><i data-lucide="x"></i></button></header><div class="rental-modal-body"></div></div>`;
        modal.querySelector('header button')!.addEventListener('click', () => this.closeModal(modal));
        modal.addEventListener('click', (event) => { if (event.target === modal) this.closeModal(modal); });
        modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { this.closeModal(modal); return; }
            if (event.key !== 'Tab') return;
            const focusable = [...modal.querySelectorAll<HTMLElement>('button, input, select, summary, [href]')].filter((element) => !element.hasAttribute('disabled'));
            if (!focusable.length) return;
            const current = document.activeElement as HTMLElement;
            const index = focusable.indexOf(current);
            if (event.shiftKey && (index <= 0)) { event.preventDefault(); focusable.at(-1)!.focus(); }
            else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0].focus(); }
        });
        document.body.appendChild(modal);
        // @ts-ignore - lucide is installed globally by icons.ts at app startup.
        if (window.lucide) window.lucide.createIcons();
        modal.querySelector<HTMLElement>('button, input')?.focus(); return modal;
    }
    private closeModal(modal: HTMLElement): void { modal.remove(); }
    private overrideKey(transaction: HDBTransaction): string { return `${transaction.block}|${transaction.street_name}|${transaction.flat_type}`; }
}

function escapeHtml(value: string): string { const el = document.createElement('span'); el.textContent = value; return el.innerHTML; }
function money(value: number): string { return `${value < 0 ? '−' : ''}$${Math.round(Math.abs(value)).toLocaleString()}`; }
function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function formatMonth(value: string): string {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) return value;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function numberField(name: string, label: string, value: number | null, type = 'number', stringValue?: string): string {
    const rendered = stringValue ?? (value === null || value === undefined || !Number.isFinite(value) ? '' : String(Math.round(value * 100) / 100));
    return `<label>${label}<input name="${name}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${escapeAttribute(rendered)}"></label>`;
}
function summaryText(summary: { count: number; min: number; max: number; median: number; q1: number; q3: number } | null | undefined): string {
    return summary ? `n=${summary.count}, median ${money(summary.median)}, range ${money(summary.min)}–${money(summary.max)}, IQR ${money(summary.q1)}–${money(summary.q3)}` : 'none';
}
function areaSummaryText(summary: { count: number; min: number; max: number; median: number; q1: number; q3: number } | null | undefined): string {
    return summary ? `n=${summary.count}, median ${summary.median.toFixed(1)} sqm, range ${summary.min.toFixed(1)}–${summary.max.toFixed(1)} sqm, IQR ${summary.q1.toFixed(1)}–${summary.q3.toFixed(1)} sqm` : 'none';
}
function escapeAttribute(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function sanitizeScenario(raw: Record<string, unknown> | null): Record<string, number | string> {
    if (!raw || typeof raw !== 'object') return {};
    const result: Record<string, number | string> = {};
    if (typeof raw.purchaseDate === 'string' && isRealIsoDate(raw.purchaseDate)) result.purchaseDate = raw.purchaseDate;
    const limits: Record<string, [number, number]> = { ltv: [0, 1], mortgageYears: [1, 50], initialRate: [0, 1], rentalRate: [0, 1], annualRentGrowth: [-.99, 1], operatingReserve: [0, 1] };
    for (const [key, [min, max]] of Object.entries(limits)) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) result[key] = value;
    }
    return result;
}
function isRealIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function missingScenarioText(estimate: RentalEstimate, hasTargetPrice = false, compact = false): string {
    if (estimate.eligibility === 'prohibited') return compact ? 'Whole-flat rental prohibited' : '⚠ Whole-flat rental is prohibited for this block. No rental projection is shown.';
    const missingRent = estimate.monthlyRent === null;
    const missingPrice = !hasTargetPrice && !estimate.resale.qualifiedForMap;
    if (compact) return missingRent && missingPrice ? 'Rent and price unavailable' : missingRent ? 'Rental estimate unavailable' : 'Purchase estimate unavailable';
    if (missingRent && missingPrice) return 'Rental and purchase evidence are insufficient. Enter a target rent and target price below to calculate this block only.';
    if (missingRent) return 'Rental evidence is insufficient. Enter a target current rent below to calculate this block only.';
    return 'At least three qualifying resale transactions are needed for a map purchase-price estimate. Enter a target price below to calculate this block only.';
}
