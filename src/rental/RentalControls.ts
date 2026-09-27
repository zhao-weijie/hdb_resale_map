import type { RentalAnalysisWindow } from './types';
import type { MapMetric } from '../metrics';
import { MAP_METRICS } from '../components/MapMetricOptions';

export interface RentalControlsViewModel {
    mode: MapMetric;
    activeType: string | null;
    flatTypes: string[];
    datasetMin?: string;
    latestMonth?: string;
    window: RentalAnalysisWindow | null;
    status: string;
    loading: boolean;
    retry: boolean;
}

export interface RentalControlsCallbacks {
    onMetric(mode: MapMetric): void;
    onFlatType(type: string): void;
    onApplyWindow(start: string): void;
    onAssumptions(): void;
    onRetry(): void;
}

export class RentalControls {
    private readonly shell = document.createElement('section');
    private readonly analysis = document.createElement('div');
    private committedWindowStart: string | null | undefined;

    constructor(private callbacks: RentalControlsCallbacks) {
        this.shell.id = 'rental-map-controls';
        this.shell.className = 'rental-map-controls';
        this.shell.innerHTML = `<button type="button" class="rental-metric-trigger" aria-haspopup="true" aria-expanded="false"><span class="rental-metric-label"></span><span class="rental-active-type" hidden></span><span aria-hidden="true">▾</span></button><div class="rental-controls-menu" hidden><div class="rental-mode-options"></div><div class="rental-type-row" hidden><label>Flat type <select class="rental-type-select"></select></label></div></div>`;
        this.shell.querySelector('.rental-mode-options')!.innerHTML = MAP_METRICS.map(({ value, label, unit }) => `<button type="button" data-rental-mode="${value}"><span>${label}</span><small>${unit}</small></button>`).join('');
        document.body.appendChild(this.shell);
        this.analysis.className = 'card rental-analysis-card';
        this.analysis.hidden = true;
        this.analysis.innerHTML = `<div class="card-header"><h3>Rental analysis</h3></div><div class="card-body"><label for="rental-window-start">Rental from</label><div class="rental-window-fields"><input type="month" id="rental-window-start" class="rental-window-start"><button type="button" class="btn-primary rental-window-apply">Apply</button></div><div class="rental-analysis-actions"><button type="button" class="rental-assumptions-open">Assumptions</button><button type="button" class="rental-retry" hidden>Retry</button></div><p class="rental-status" aria-live="polite"></p></div>`;
        document.getElementById('rental-analysis-slot')?.appendChild(this.analysis);
        this.bind();
    }

    update(vm: RentalControlsViewModel): void {
        const descriptor = MAP_METRICS.find((item) => item.value === vm.mode) ?? MAP_METRICS[0];
        const rental = vm.mode !== 'price' && vm.mode !== 'price_psf';
        this.shell.querySelector('.rental-metric-label')!.textContent = `Colour by: ${descriptor.label}`;
        const badge = this.shell.querySelector<HTMLElement>('.rental-active-type')!;
        badge.textContent = vm.activeType ?? '';
        badge.hidden = !rental;
        this.shell.querySelector<HTMLElement>('.rental-type-row')!.hidden = !rental;
        this.shell.querySelectorAll<HTMLButtonElement>('[data-rental-mode]').forEach((button) => { const active = button.dataset.rentalMode === vm.mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
        const select = this.shell.querySelector<HTMLSelectElement>('.rental-type-select')!;
        select.innerHTML = vm.flatTypes.map((type) => `<option>${escapeHtml(type)}</option>`).join('');
        select.value = vm.activeType ?? '';
        this.analysis.hidden = !rental;
        const input = this.analysis.querySelector<HTMLInputElement>('.rental-window-start')!;
        input.disabled = !vm.datasetMin || vm.loading;
        input.min = vm.datasetMin ?? '';
        input.max = vm.latestMonth ?? '';
        const committedWindowStart = vm.window?.minMonth ?? null;
        if (this.committedWindowStart !== committedWindowStart) {
            input.value = committedWindowStart ?? '';
            this.committedWindowStart = committedWindowStart;
        }
        this.analysis.querySelector<HTMLButtonElement>('.rental-window-apply')!.disabled = !vm.datasetMin || vm.loading;
        this.analysis.querySelector<HTMLElement>('.rental-status')!.textContent = vm.status;
        this.analysis.querySelector<HTMLButtonElement>('.rental-retry')!.hidden = !vm.retry;
    }

    private bind(): void {
        const close = () => { this.shell.querySelector<HTMLElement>('.rental-controls-menu')!.hidden = true; this.shell.querySelector('.rental-metric-trigger')!.setAttribute('aria-expanded', 'false'); };
        this.shell.querySelector<HTMLButtonElement>('.rental-metric-trigger')!.addEventListener('click', () => { const menu = this.shell.querySelector<HTMLElement>('.rental-controls-menu')!; menu.hidden = !menu.hidden; this.shell.querySelector('.rental-metric-trigger')!.setAttribute('aria-expanded', String(!menu.hidden)); });
        this.shell.querySelectorAll<HTMLButtonElement>('[data-rental-mode]').forEach((button) => button.addEventListener('click', () => { const mode = button.dataset.rentalMode as MapMetric; this.callbacks.onMetric(mode); if (mode === 'price' || mode === 'price_psf') close(); }));
        this.shell.querySelector<HTMLSelectElement>('.rental-type-select')!.addEventListener('change', (event) => this.callbacks.onFlatType((event.target as HTMLSelectElement).value));
        this.analysis.querySelector<HTMLButtonElement>('.rental-window-apply')!.addEventListener('click', () => this.callbacks.onApplyWindow(this.analysis.querySelector<HTMLInputElement>('.rental-window-start')!.value));
        this.analysis.querySelector<HTMLButtonElement>('.rental-assumptions-open')!.addEventListener('click', () => this.callbacks.onAssumptions());
        this.analysis.querySelector<HTMLButtonElement>('.rental-retry')!.addEventListener('click', () => this.callbacks.onRetry());
        document.addEventListener('click', (event) => { if (!this.shell.contains(event.target as Node)) close(); });
        this.shell.addEventListener('keydown', (event) => { if (event.key === 'Escape') { close(); this.shell.querySelector<HTMLButtonElement>('.rental-metric-trigger')!.focus(); } });
    }
}

function escapeHtml(value: string): string { const el = document.createElement('span'); el.textContent = value; return el.innerHTML; }
