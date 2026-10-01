import type { DataLoader } from '../data/DataLoader';
import { RentalDataLoader } from '../data/RentalDataLoader';
import type { ColorScaleBar } from '../components/ColorScaleBar';
import type { MapView, RentalMapPoint } from '../map/MapView';
import { appState } from '../state/AppState';
import { applyFilters } from '../utils/filters';
import {
    blockKey, buildRentalMapTargets, calculateScenario, createRentalEstimationContext, estimateRentForTarget, getMapRentalMetric,
    normalizeFlatType, singaporeToday,
    type RentalEstimate, type RentalScenario, type RentalEstimationContext,
} from './model';
import type { BlockTypeTarget, RentalAnalysisWindow, RentalDataset, ScenarioAssumptions } from './types';
import type { MapMetric } from '../metrics';
import { createScalePresentation, metricValue } from '../metrics';
import type { ScalePresentation } from '../metrics';
import { containsCoordinate } from '../spatial/selection';
import type { SpatialSelection } from '../spatial/selection';
import { publishRentalOverviewSource } from '../analytics/rentalOverview';
import { RentalControls } from './RentalControls';
import { TransactionTable } from '../components/TransactionTable';

type RentalMode = Exclude<MapMetric, 'price' | 'price_psf'>;

interface EstimateRow { point: RentalMapPoint; estimate: RentalEstimate; scenario: RentalScenario | null; target: BlockTypeTarget; }

/** Coordinates lazy rental loading and calculations with separate rental views. */
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
    private windowLoading = false;
    private status = '';
    private estimationContext: RentalEstimationContext | null = null;
    private estimationContextKey = '';
    private analysisWindow: RentalAnalysisWindow | null = null;
    private overrides = new Map<string, { price?: number; marketValue?: number; rent?: number; area?: number; annualValue?: number }>();
    private readonly controls: RentalControls;

    constructor(dataLoader: DataLoader, mapView: MapView, colorScale: ColorScaleBar) {
        this.dataLoader = dataLoader;
        this.mapView = mapView;
        this.colorScale = colorScale;
        this.controls = new RentalControls({
            onMetric: (mode) => { appState.set('colorMode', mode); try { localStorage.setItem('hdb_colorMode', mode); } catch (_) {} },
            onFlatType: (type) => appState.set('rentalActiveFlatType', type),
            onApplyWindow: (start) => this.updateWindow(start),
            onAssumptions: () => this.openScenarioEditor(),
            onRetry: () => void this.loadAndRender(),
        });
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
        });
        appState.subscribe('globalFilters', () => {
            this.ensureActiveType();
            this.syncControls();
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
            if (this.isRentalMode(appState.get('colorMode'))) this.updatePresentation();
        });
        appState.subscribe('spatialSelection', () => {
            if (this.isRentalMode(appState.get('colorMode'))) this.updatePresentation();
        });
        this.ensureActiveType();
        this.syncControls();
        if (this.isRentalMode(appState.get('colorMode') as MapMetric)) void this.loadAndRender();
    }

    private isRentalMode(mode: MapMetric): mode is RentalMode { return mode !== 'price' && mode !== 'price_psf'; }

    private updateWindow(start: string): void {
        const resaleLatest = this.dataLoader.getAllData().reduce((latest, row) => row.month > latest ? row.month : latest, '');
        const requestedWindow = this.dataset ? rentalWindowFromStart(start, this.dataset.minMonth, this.dataset.maxMonth, resaleLatest) : null;
        if (!requestedWindow) { this.status = 'Invalid month'; this.syncControls(); return; }
        const version = ++this.windowRequestVersion;
        this.windowLoading = true; this.status = 'Loading…'; this.syncControls();
        void this.dataLoader.ensureDateRange(requestedWindow.minMonth, requestedWindow.maxMonth).then(() => {
            if (version !== this.windowRequestVersion) return;
            this.analysisWindow = requestedWindow;
            this.estimationContext = null;
            publishRentalOverviewSource(this.dataset, this.analysisWindow);
            this.windowLoading = false; this.status = '';
            this.syncControls();
            if (this.isRentalMode(appState.get('colorMode') as MapMetric)) this.renderRentalPoints();
        }).catch(() => {
            if (version === this.windowRequestVersion) { this.windowLoading = false; this.status = 'Load failed'; this.syncControls(); }
        });
    }

    private ensureActiveType(): void {
        const types = appState.get('globalFilters').flatTypes;
        const current = appState.get('rentalActiveFlatType');
        if (current && types.includes(current)) return;
        appState.set('rentalActiveFlatType', types.includes('4 ROOM') ? '4 ROOM' : types[0] ?? null);
    }

    private syncControls(): void {
        const resaleLatest = this.dataLoader.getAllData().reduce((latest, row) => row.month > latest ? row.month : latest, '');
        const latest = this.dataset && resaleLatest > this.dataset.maxMonth ? this.dataset.maxMonth : resaleLatest;
        this.controls.update({ mode: appState.get('colorMode') as MapMetric, activeType: appState.get('rentalActiveFlatType'), flatTypes: appState.get('globalFilters').flatTypes,
            datasetMin: this.dataset?.minMonth, latestMonth: latest, window: this.analysisWindow, status: this.status, loading: !!this.loadPromise || this.windowLoading,
            retry: this.status.startsWith('Rental data unavailable') });
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
                publishRentalOverviewSource(this.dataset, this.analysisWindow);
                this.status = '';
            })().catch((error: unknown) => {
                this.status = `Rental data unavailable. Retry: ${error instanceof Error ? error.message : 'request failed'}`;
                this.dataset = null;
                publishRentalOverviewSource(null, null);
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
        const filteredTransactions = applyFilters(all, filters);
        const latestResale = new Map<string, (typeof filteredTransactions)[number]>();
        for (const transaction of filteredTransactions) {
            const key = `${blockKey(transaction.block, transaction.street_name)}|${normalizeFlatType(transaction.flat_type)}`;
            const existing = latestResale.get(key);
            if (!existing || transaction.month > existing.month) latestResale.set(key, transaction);
        }
        const targets = buildRentalMapTargets(this.dataset, this.analysisWindow, filters.flatTypes);
        const scenarioInputs = appState.get('rentalScenario') as Partial<ScenarioAssumptions>;
        const resaleFilters = { floorMin: filters.floorMin, leaseMin: filters.leaseMin, leaseMax: filters.leaseMax };
        const contextKey = `${this.dataset.generatedAt}|${all.length}|${resaleFilters.floorMin}|${resaleFilters.leaseMin}|${resaleFilters.leaseMax}|${this.analysisWindow?.minMonth}|${this.analysisWindow?.maxMonth}`;
        if (!this.estimationContext || this.estimationContextKey !== contextKey) {
            this.estimationContext = createRentalEstimationContext({ rentalRecords: this.dataset.records, rentalLocations: this.dataset.locations, resaleComparables: all,
                resaleFilters, analysisWindow: this.analysisWindow ?? undefined });
            this.estimationContextKey = contextKey;
        }
        const context = this.estimationContext;
        this.rows = targets.map((rentalTarget) => {
            const targetKey = `${blockKey(rentalTarget.block, rentalTarget.streetName)}|${normalizeFlatType(rentalTarget.flatType)}`;
            const transaction = latestResale.get(targetKey);
            const target: BlockTypeTarget = transaction ? {
                ...rentalTarget,
                town: transaction.town,
                leaseCommencement: transaction.lease_commence_date,
                nearestMrtExitMeters: transaction.mrt_distance_m,
            } : rentalTarget;
            const key = this.overrideKey(target);
            const override = this.overrides.get(key);
            const estimate = estimateRentForTarget(context, target);
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
            const scenario = canModelPurchase && purchasePrice > 0 && currentMonthlyRent > 0
                ? calculateScenario({ purchasePrice, currentMonthlyRent, evidenceAsOf: estimate.analysisWindow?.maxMonth,
                    marketValue: override?.marketValue, annualValueOverride: override?.annualValue, assumptions: scenarioInputs }) : null;
            const metric = getMapRentalMetric(appState.get('colorMode') as RentalMode, estimate, scenario);
            const point: RentalMapPoint = { block: target.block, streetName: target.streetName, flatType: target.flatType,
                latitude: target.latitude!, longitude: target.longitude!,
                rent: getMapRentalMetric('rent', estimate, scenario).value, rentPsf: getMapRentalMetric('rent_psf', estimate, scenario).value,
                grossYield: getMapRentalMetric('gross_yield', estimate, scenario).value, monthlySurplus: getMapRentalMetric('monthly_surplus', estimate, scenario).value,
                provenance: estimate.source === 'nearby_blocks' ? 'nearby' : estimate.source === 'same_block' ? 'same_block' : 'insufficient',
                metricValue: metric.value, estimate, scenario };
            return { point, estimate, scenario, target };
        });
        if (request !== this.requestVersion) return;
        this.mapView.setRentalPoints(this.rows.map((row) => row.point));
        this.updatePresentation();
    }

    private updatePresentation(): void {
        const mode = appState.get('colorMode') as RentalMode;
        const presentation = buildRentalScalePresentation(
            mode,
            this.rows.map((row) => row.point),
            appState.get('rentalActiveFlatType'),
            appState.get('spatialSelection'),
        );
        this.mapView.setRentalDomain(presentation.domain);
        this.colorScale.setPresentation(presentation);
    }

    private openDetails(point: RentalMapPoint): void {
        const matching = this.rows
            .filter((row) => row.point.block === point.block && row.point.streetName === point.streetName)
            .sort((a, b) => a.point.flatType.localeCompare(b.point.flatType, undefined, { numeric: true }));
        const active = matching.find((row) => row.point.flatType === point.flatType) ?? matching[0];
        if (!active) return;
        const modal = this.modal('rental-detail-modal', `Blk ${escapeHtml(point.block)} ${escapeHtml(point.streetName)}`);

        const displayEvidence = (row: EstimateRow) => row.estimate.selected ?? row.estimate.direct;
        const observations = matching.flatMap((row) => displayEvidence(row).records).filter((record) => Number.isFinite(record.monthly_rent) && record.monthly_rent > 0);
        let scaleMin = observations.length ? Math.min(...observations.map((record) => record.monthly_rent)) : 0;
        let scaleMax = observations.length ? Math.max(...observations.map((record) => record.monthly_rent)) : 1;
        if (scaleMin === scaleMax) {
            const padding = Math.max(100, scaleMin * .05);
            scaleMin -= padding; scaleMax += padding;
        }
        const position = (value: number) => Math.max(0, Math.min(100, ((value - scaleMin) / (scaleMax - scaleMin)) * 100));
        const distributionRows = matching.map((row) => {
            const selected = row.point.flatType === point.flatType;
            const override = this.overrides.get(this.overrideKey(row.target));
            const evidenceModel = displayEvidence(row);
            const evidence = evidenceModel.summary;
            const source = row.estimate.source === 'same_block' ? 'same block' : row.estimate.source === 'nearby_blocks' ? 'nearby' : 'insufficient';
            const included = new Set(evidenceModel.includedRecords);
            const lanes = new Map<number, number>();
            let maxLane = 0;
            const points = evidenceModel.records.map((record) => {
                const lane = lanes.get(record.monthly_rent) ?? 0; lanes.set(record.monthly_rent, lane + 1); maxLane = Math.max(maxLane, lane);
                const tooltip = `${record.month} · ${money(record.monthly_rent)} · ${record.block} ${record.street_name}`;
                return `<button type="button" class="rental-observation${included.has(record) ? '' : ' excluded'}" style="--point:${position(record.monthly_rent)}%;--lane:${lane}" data-rental-tooltip="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}"></button>`;
            }).join('');
            const plot = evidenceModel.records.length ? `<div class="rental-boxplot" role="group" aria-label="${escapeAttribute(`${row.point.flatType}: ${evidenceModel.records.length} rents`)}"
                style="--lanes:${maxLane};${evidence ? `--plot-min:${position(evidence.min)}%;--plot-q1:${position(evidence.q1)}%;--plot-median:${position(evidence.median)}%;--plot-q3:${position(evidence.q3)}%;--plot-max:${position(evidence.max)}%` : ''}">
                ${evidence ? `<span class="rental-boxplot-whisker"></span><span class="rental-boxplot-cap rental-boxplot-cap--min"></span><span class="rental-boxplot-cap rental-boxplot-cap--max"></span><span class="rental-boxplot-box"></span><span class="rental-boxplot-median"></span><span class="rental-quartile rental-quartile--q1" style="--quartile:${position(evidence.q1)}%">${money(evidence.q1)}</span><span class="rental-quartile rental-quartile--q3" style="--quartile:${position(evidence.q3)}%">${money(evidence.q3)}</span>` : ''}${points}
              </div>` : '<span class="rental-distribution-empty">Insufficient evidence</span>';
            return `<div class="rental-distribution-row${selected ? ' active' : ''}" role="listitem">
              <div class="rental-distribution-type"><strong>${escapeHtml(row.point.flatType)}</strong>${selected ? '<span>Selected</span>' : ''}${override ? '<small>Adjusted</small>' : ''}</div>
              <div class="rental-distribution-plot">${plot}<small>${evidenceModel.records.length} rents · ${source}</small></div>
              <div class="rental-distribution-value"><strong>${row.estimate.monthlyRent === null ? '—' : money(row.estimate.monthlyRent)}</strong><small>estimate</small></div>
            </div>`;
        }).join('');
        const s = active.scenario;
        const activeOverride = this.overrides.get(this.overrideKey(active.target));
        const evidenceCount = active.estimate.selected?.summary?.count;
        const evidenceSource = active.estimate.source === 'same_block' ? 'Same-block evidence' : active.estimate.source === 'nearby_blocks' ? 'Nearby-block estimate' : 'Insufficient rental evidence';
        const purchaseEstimate = activeOverride?.price ?? active.estimate.resale.summary?.median ?? null;
        const surplusTone = s ? (s.propertyMonthlySurplus < 0 ? ' negative' : ' positive') : '';
        modal.querySelector('.rental-modal-body')!.innerHTML = `<div class="rental-detail-meta">
            <span class="rental-type-chip">${escapeHtml(active.point.flatType)}</span>
            <span>${evidenceSource}${evidenceCount ? ` · ${evidenceCount} rents` : ''}</span>
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
            ${observations.length ? `<div class="rental-distribution-axis"><span>${money(scaleMin)}</span><span>${money(scaleMax)}</span></div>` : ''}
          </section>
          <section class="rental-resale-comparables" aria-labelledby="rental-resale-title"><div class="rental-section-heading"><h3 id="rental-resale-title">Resale comparables</h3></div><div class="rental-resale-table"></div></section>
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
              <summary><i data-lucide="chevron-down" aria-hidden="true"></i><span>Adjust inputs</span><small>Price, rent, area and Annual Value</small></summary>
              <form class="rental-overrides"><p>Changes apply only to this block and flat type.</p>
          ${numberField('price', 'Target price', this.overrides.get(this.overrideKey(active.target))?.price ?? active.estimate.resale.summary?.median ?? null)}
          ${numberField('marketValue', 'Market value for BSD (optional)', this.overrides.get(this.overrideKey(active.target))?.marketValue ?? null)}
          ${numberField('rent', 'Current rent', this.overrides.get(this.overrideKey(active.target))?.rent ?? active.estimate.monthlyRent)}
          ${numberField('area', 'Area (sqm)', this.overrides.get(this.overrideKey(active.target))?.area ?? active.estimate.resale.areaSummary?.median ?? null)}
          ${numberField('annualValue', 'Annual Value', this.overrides.get(this.overrideKey(active.target))?.annualValue ?? null)}
                <div class="rental-override-actions"><button>Apply changes</button><button type="button" class="rental-reset" ${activeOverride ? '' : 'disabled'}>Reset</button></div>
              </form>
            </details>
          </div>`;
        // @ts-ignore - lucide is installed globally by icons.ts at app startup.
        if (window.lucide) window.lucide.createIcons();
        // Transaction history follows the resale filters, independently of the rental estimate window.
        const resaleRecords = applyFilters(
            this.dataLoader.getTransactionsForBlock(point.block, point.streetName),
            appState.get('globalFilters'),
        );
        resaleRecords.sort((a, b) => b.month.localeCompare(a.month));
        const tableHost = modal.querySelector<HTMLElement>('.rental-resale-table')!;
        const table = new TransactionTable(resaleRecords, { pageSize: 5, activeFlatType: active.point.flatType });
        tableHost.innerHTML = table.markup(); table.mount(tableHost);
        this.bindObservationTooltips(modal);
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
            this.overrides.set(this.overrideKey(active.target), { price: price.value, marketValue: marketValue.value, rent: rent.value, area: area.value, annualValue: annualValue.value });
            this.closeModal(modal); this.renderRentalPoints(); requestAnimationFrame(() => this.openDetails(active.point)); });
        modal.querySelector<HTMLButtonElement>('.rental-reset')!.addEventListener('click', () => { this.overrides.delete(this.overrideKey(active.target)); this.closeModal(modal); this.renderRentalPoints(); });
    }

    private openScenarioEditor(): void {
        const existing = appState.get('rentalScenario');
        const modal = this.modal('rental-scenario-modal', 'Rental scenario assumptions');
        modal.querySelector('.rental-modal-body')!.innerHTML = scenarioFormMarkup(existing);
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

    private bindObservationTooltips(modal: HTMLElement): void {
        const tooltip = document.createElement('div'); tooltip.className = 'rental-observation-tooltip'; tooltip.hidden = true; modal.appendChild(tooltip);
        let pinned: HTMLElement | null = null;
        const hide = () => { tooltip.hidden = true; };
        const dismiss = () => { pinned = null; hide(); };
        const show = (button: HTMLElement) => {
            tooltip.textContent = button.dataset.rentalTooltip ?? '';
            const rect = button.getBoundingClientRect(); tooltip.hidden = false;
            tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2))}px`;
            tooltip.style.top = `${Math.max(8, rect.top - tooltip.offsetHeight - 7)}px`;
        };
        modal.querySelectorAll<HTMLElement>('[data-rental-tooltip]').forEach((button) => {
            button.addEventListener('mouseenter', () => show(button));
            button.addEventListener('focus', () => show(button)); button.addEventListener('blur', () => { if (pinned !== button) hide(); });
            button.addEventListener('mouseleave', () => { if (pinned !== button) hide(); });
            button.addEventListener('click', (event) => { event.stopPropagation(); pinned = button; show(button); });
        });
        modal.addEventListener('click', dismiss);
        modal.addEventListener('rental-tooltip-dismiss', dismiss);
    }

    private modal(id: string, title: string): HTMLElement {
        document.getElementById(id)?.remove(); const modal = document.createElement('div'); modal.id = id; modal.className = 'rental-modal';
        modal.innerHTML = `<div class="rental-modal-card" role="dialog" aria-modal="true" aria-labelledby="${id}-title"><header><h2 id="${id}-title">${title}</h2><button type="button" aria-label="Close"><i data-lucide="x"></i></button></header><div class="rental-modal-body"></div></div>`;
        modal.querySelector('header button')!.addEventListener('click', () => this.closeModal(modal));
        modal.addEventListener('click', (event) => { if (event.target === modal) this.closeModal(modal); });
        modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { const tooltip = modal.querySelector<HTMLElement>('.rental-observation-tooltip:not([hidden])'); if (tooltip) { modal.dispatchEvent(new Event('rental-tooltip-dismiss')); event.stopImmediatePropagation(); return; } this.closeModal(modal); return; }
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
    private overrideKey(target: BlockTypeTarget): string { return `${blockKey(target.block, target.streetName)}|${normalizeFlatType(target.flatType)}`; }
}

export function buildRentalScalePresentation(
    metric: RentalMode,
    points: readonly RentalMapPoint[],
    activeType: string | null,
    selection: SpatialSelection,
): ScalePresentation {
    const population = points.filter((point) => !activeType || normalizeFlatType(point.flatType) === normalizeFlatType(activeType));
    const values = population.map((point) => metricValue(metric, point));
    const selectedValues = selection.kind === 'none' ? undefined : population
        .filter((point) => containsCoordinate(selection, point))
        .map((point) => metricValue(metric, point));
    return createScalePresentation(metric, values, selectedValues);
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
export function scenarioFormMarkup(existing: Record<string, number | string>): string {
    return `<form class="rental-scenario-form">
          ${numberField('purchaseDate', 'Purchase date', null, 'date', String(existing.purchaseDate ?? singaporeToday()))}
          ${numberField('ltv', 'LTV (%)', Number(existing.ltv ?? .75) * 100)} ${numberField('mortgageYears', 'Mortgage tenure (years)', Number(existing.mortgageYears ?? 25))}
          ${numberField('initialRate', 'Rate before MOP (%)', Number(existing.initialRate ?? .03) * 100)} ${numberField('rentalRate', 'Rate at rental start (%)', Number(existing.rentalRate ?? .03) * 100)}
          ${numberField('annualRentGrowth', 'Annual rent growth (%)', Number(existing.annualRentGrowth ?? 0) * 100)} ${numberField('operatingReserve', 'Operating reserve (%)', Number(existing.operatingReserve ?? .10) * 100)}
          <button>Apply scenario</button></form>`;
}
function escapeAttribute(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function rentalWindowFromStart(startMonth: string, datasetMin: string, datasetMax: string, resaleLatest: string): RentalAnalysisWindow | null {
    const latest = resaleLatest && resaleLatest < datasetMax ? resaleLatest : datasetMax;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth) || startMonth < datasetMin || startMonth > latest) return null;
    return { minMonth: startMonth, maxMonth: latest };
}
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
    const missingRent = estimate.monthlyRent === null;
    const missingPrice = !hasTargetPrice && !estimate.resale.qualifiedForMap;
    if (compact) return missingRent && missingPrice ? 'Rent and price unavailable' : missingRent ? 'Rental estimate unavailable' : 'Purchase estimate unavailable';
    if (missingRent && missingPrice) return 'Rental and purchase evidence are insufficient. Enter a target rent and target price below to calculate this block only.';
    if (missingRent) return 'Rental evidence is insufficient. Enter a target current rent below to calculate this block only.';
    return 'At least three qualifying resale transactions are needed for a map purchase-price estimate. Enter a target price below to calculate this block only.';
}
