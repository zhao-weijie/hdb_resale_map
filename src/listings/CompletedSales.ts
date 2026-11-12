import type { Infer } from 'convex/values';
import type { candidateSummary, comparisonContext } from '../../convex/trackerTypes';
import type { AnalyticsPanel } from '../analytics/AnalyticsPanel';
import { TransactionTable } from '../components/TransactionTable';
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { appState } from '../state/AppState';
import { circleSelection, rectangleSelection, NO_SPATIAL_SELECTION, type SpatialSelection } from '../spatial/selection';
import { getTransactionStats } from '../utils/transactionStats';
import { action, asking, element, flatTypes, group, input, label, observed, select, sgd, submit, textStatus } from './dom';
import { sha256, type BlockLookup } from './geocodes';

export type Comparison = Infer<typeof comparisonContext>;
type Summary = Infer<typeof candidateSummary>;
type ComparisonHome = { title: string; summary: Summary; revision: number; block?: BlockLookup };
type Rules = Comparison['rules'];
const TRANSFORM_VERSION = 'hdb-arrow-v1';

export class CompletedSales {
    private generation = 0;

    constructor(
        private readonly host: HTMLElement,
        private readonly analytics: AnalyticsPanel,
        private readonly data: DataLoader,
        private readonly map: MapView,
    ) {}

    close(): void {
        this.generation += 1;
        this.host.replaceChildren();
        this.map.clearCompletedSalesComparison();
    }

    open(home: ComparisonHome, onBack: (comparison?: Comparison) => void, saved?: Comparison): void {
        this.close();
        const back = action('Back to home', () => {
            this.close();
            this.analytics.showDestination('tracker');
            onBack();
        }, 'tracker-button tracker-quiet');
        const heading = element('h2', `Completed sales near ${home.title}`);
        const ask = element('p', saved
            ? `${asking(saved.asking?.priceCents)} · ${observed(saved.asking?.observedAt)}`
            : `${asking(home.summary.askingPriceCents)} · ${observed(home.summary.askingObservedAt)}`, 'tracker-ask');
        this.host.append(back, heading, ask);
        const publicArea = appState.get('spatialSelection');
        this.map.setCompletedSalesComparison(NO_SPATIAL_SELECTION, []);
        this.analytics.showDestination('comparison');
        back.focus({ preventScroll: true });
        if (saved) this.renderSaved(home, onBack, saved);
        else this.renderForm(home, publicArea, onBack);
    }

    private renderForm(home: ComparisonHome, area: SpatialSelection, onBack: (comparison?: Comparison) => void): void {
        const manifest = this.data.getComparisonManifest();
        if (!manifest) {
            this.host.append(textStatus('Completed-sales history is unavailable. Reload the public dataset and try again.'));
            return;
        }
        if (!home.block && area.kind === 'none') {
            this.host.append(element('p', 'Resolve this home’s postal code, or select an area in Analytics and return here.'));
            return;
        }
        const publicFilters = appState.get('globalFilters');
        const start = input('month', publicFilters.date === 'all' ? manifest.minMonth : publicFilters.date, true);
        const end = input('month', manifest.maxMonth, true);
        for (const control of [start, end]) {
            control.min = manifest.minMonth;
            control.max = manifest.maxMonth;
        }
        const type = select([['', 'All flat types'], ...flatTypes.map((value) => [value, value] as const)],
            home.summary.facts.flatType?.value ?? '');
        const floor = input('number', String(publicFilters.floorMin), true);
        floor.min = '1'; floor.max = '60';
        const leaseMin = input('number', String(publicFilters.leaseMin), true);
        const leaseMax = input('number', String(publicFilters.leaseMax), true);
        for (const control of [leaseMin, leaseMax]) { control.min = '0'; control.max = '99'; }
        const radius = input('number', '500', true);
        radius.min = '1'; radius.max = '25000';
        const geoOptions: Array<[string, string]> = [];
        if (home.block) geoOptions.push(['block', 'Circle around the home’s block']);
        if (area.kind !== 'none') geoOptions.push(['drawn', 'Use selected area']);
        const scope = select(geoOptions, geoOptions[0][0]);
        const form = element('form', undefined, 'tracker-form');
        const radiusField = label('Radius in metres', radius);
        const syncScope = () => { radiusField.hidden = scope.value === 'drawn'; radius.disabled = radiusField.hidden; };
        scope.addEventListener('change', syncScope);
        syncScope();
        form.append(label('Comparable area', scope), radiusField,
            group(label('From month', start), label('Through month', end)),
            label('Flat type', type),
            group(label('Minimum floor', floor), label('Minimum lease years', leaseMin), label('Maximum lease years', leaseMax)));
        const apply = submit('Show completed sales');
        form.append(apply);
        const status = textStatus();
        const results = element('div', undefined, 'tracker-results');
        this.host.append(form, status, results);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (start.value > end.value || Number(leaseMin.value) > Number(leaseMax.value)) {
                status.textContent = 'Check the date and lease bounds. The starting value must be at or below the ending value.';
                (start.value > end.value ? start : leaseMin).focus();
                return;
            }
            const selection = scope.value === 'drawn' ? area
                : circleSelection(home.block!.latitude, home.block!.longitude, Number(radius.value));
            if (selection.kind === 'none') return;
            const geometry: Comparison['geometry'] = selection.kind === 'circle'
                ? { kind: 'circle', lng: selection.center.longitude, lat: selection.center.latitude, radiusMeters: selection.radiusMeters }
                : { kind: 'rectangle', minLng: selection.west, minLat: selection.south, maxLng: selection.east, maxLat: selection.north };
            const rules = {
                startMonth: start.value, endMonth: end.value, flatTypes: type.value ? [type.value] : [...flatTypes],
                floorMin: Number(floor.value), leaseMonthsMin: Number(leaseMin.value) * 12,
                leaseMonthsMax: Number(leaseMax.value) * 12, exclusions: [],
            };
            const generation = ++this.generation;
            apply.disabled = true;
            results.replaceChildren();
            status.textContent = 'Loading completed-sales history…';
            this.map.setCompletedSalesComparison(selection, []);
            if (selection.kind === 'circle') this.map.revealSavedBlock(selection.center.latitude, selection.center.longitude);
            void this.buildSnapshot(home, scope.value === 'block' ? home.block : undefined, geometry, rules).then(({ snapshot, rows }) => {
                if (generation !== this.generation) return;
                this.map.setCompletedSalesComparison(selection, rows);
                status.textContent = '';
                this.renderResults(results, snapshot, rows);
                if (!rows.length) results.append(action('Edit filters', () => scope.focus()));
                results.append(action('Attach comparison to notes', () => {
                    this.close();
                    this.analytics.showDestination('tracker');
                    onBack(snapshot);
                }, 'tracker-button tracker-primary'));
            }).catch(() => {
                if (generation === this.generation) status.textContent = 'Completed-sales history could not load. Use Show completed sales to retry.';
            }).finally(() => { if (generation === this.generation) apply.disabled = false; });
        });
    }

    private async datasetIdentity(rules: Rules): Promise<Comparison['dataset']> {
        const manifest = this.data.getComparisonManifest();
        if (!manifest || rules.startMonth < manifest.minMonth || rules.endMonth > manifest.maxMonth) {
            throw new Error('Dataset does not cover the requested date window');
        }
        const partitions = manifest.years
            .filter((year) => year.maxMonth >= rules.startMonth && year.minMonth <= rules.endMonth)
            .sort((first, second) => first.year - second.year)
            .map(({ url, sha256 }) => ({ url: /^[a-zA-Z0-9_.-]+$/.test(url) ? `data/${url}` : url, sha256 }));
        const fingerprint = await sha256(JSON.stringify([manifest.version, TRANSFORM_VERSION, partitions.map((p) => p.sha256)]));
        return { fingerprint, manifestVersion: manifest.version, transformVersion: TRANSFORM_VERSION, partitions };
    }

    private async loadRows(geometry: Comparison['geometry'], rules: Rules): Promise<HDBTransaction[]> {
        await this.data.ensureDateRange(rules.startMonth, rules.endMonth);
        const candidates = geometry.kind === 'circle'
            ? this.data.queryCircle(geometry.lat, geometry.lng, geometry.radiusMeters)
            : geometry.kind === 'rectangle'
                ? this.data.queryRectangle(geometry.minLat, geometry.minLng, geometry.maxLat, geometry.maxLng)
                : this.data.queryCircle(geometry.lat, geometry.lng, 1);
        return candidates.filter((row) => {
            const [floorMin, floorMax] = row.storey_range.split(' TO ').map(Number);
            return row.month >= rules.startMonth && row.month <= rules.endMonth
                && rules.flatTypes.includes(row.flat_type)
                && (rules.floorMin === undefined || floorMax >= rules.floorMin)
                && (rules.floorMax === undefined || floorMin <= rules.floorMax)
                && (rules.leaseMonthsMin === undefined || Math.round(row.remaining_lease_years * 12) >= rules.leaseMonthsMin)
                && (rules.leaseMonthsMax === undefined || Math.round(row.remaining_lease_years * 12) <= rules.leaseMonthsMax)
                && (rules.areaSqmMin === undefined || row.floor_area_sqm >= rules.areaSqmMin)
                && (rules.areaSqmMax === undefined || row.floor_area_sqm <= rules.areaSqmMax);
        }).sort((a, b) => b.month.localeCompare(a.month));
    }

    private async buildSnapshot(home: ComparisonHome, block: BlockLookup | undefined, geometry: Comparison['geometry'], rules: Rules) {
        const [dataset, rows] = await Promise.all([this.datasetIdentity(rules), this.loadRows(geometry, rules)]);
        const price = getTransactionStats(rows, 'price');
        const psf = getTransactionStats(rows, 'price_psf');
        const manifest = this.data.getComparisonManifest()!;
        const occurrences = new Map<string, number>();
        const comparables = await Promise.all(rows.slice(0, 100).map(async (row) => {
            const partitionHash = manifest.years.find((partition) => partition.year === Number(row.month.slice(0, 4)))!.sha256;
            const serialized = JSON.stringify([row.month, row.transaction_date.toISOString(), row.town, row.block, row.street_name,
                row.flat_type, row.storey_range, row.floor_area_sqm, row.flat_model, row.lease_commence_date, row.remaining_lease_years,
                row.resale_price, row.price_psm, row.price_psf, row.latitude, row.longitude, row.mrt_distance_m]);
            const occurrence = (occurrences.get(serialized) ?? 0) + 1;
            occurrences.set(serialized, occurrence);
            return { partitionHash, rowFingerprint: await sha256(serialized), occurrence, month: row.month, block: row.block,
                streetName: row.street_name, flatType: row.flat_type, storeyRange: row.storey_range,
                floorAreaSqm: row.floor_area_sqm, resalePrice: row.resale_price };
        }));
        const { summary } = home;
        const snapshot: Comparison = {
            kind: 'completed_sales', version: 1, geometry, rules, dataset, comparables,
            sampleCount: rows.length, truncatedDetails: rows.length > comparables.length,
            stats: { minPrice: price?.min, medianPrice: price?.median, maxPrice: price?.max, meanPrice: price?.mean, medianPsf: psf?.median },
            preparedAt: Date.now(), candidateRevision: home.revision,
            candidateFacts: {
                flatType: summary.facts.flatType?.value ?? undefined, area: summary.facts.area?.value ?? undefined,
                floor: summary.facts.floor?.value ?? undefined, flatModel: summary.facts.flatModel?.value ?? undefined,
                completionYear: summary.facts.completionYear?.value ?? undefined,
                leaseCommencementYear: summary.facts.leaseCommencementYear?.value ?? undefined,
            },
            asking: { priceCents: summary.askingPriceCents, sourceListingId: summary.askingSourceListingId,
                observationId: summary.askingObservationId, observedAt: summary.askingObservedAt },
            blockCenter: block && { postalCode: block.postalCode, lat: block.latitude, lng: block.longitude, geocodeVersion: block.version },
        };
        return { snapshot, rows };
    }

    private renderResults(host: HTMLElement, snapshot: Comparison, rows: HDBTransaction[]): void {
        const { geometry, rules, stats, sampleCount } = snapshot;
        const shape = geometry.kind === 'circle' ? `${geometry.radiusMeters} m circle`
            : geometry.kind === 'rectangle' ? 'Selected rectangle' : `Block ${geometry.postalCode}`;
        const coordinates = geometry.kind === 'rectangle'
            ? `${geometry.minLat.toFixed(5)}, ${geometry.minLng.toFixed(5)} to ${geometry.maxLat.toFixed(5)}, ${geometry.maxLng.toFixed(5)}`
            : `${geometry.lat.toFixed(5)}, ${geometry.lng.toFixed(5)}`;
        host.append(element('h3', `${sampleCount.toLocaleString()} completed ${sampleCount === 1 ? 'sale' : 'sales'}`),
            element('p', `${shape} · ${coordinates} · ${rules.startMonth} through ${rules.endMonth}`, 'tracker-meta'),
            element('p', `${rules.flatTypes.length === flatTypes.length ? 'All flat types' : rules.flatTypes.join(', ')} · Floor ${rules.floorMin ?? 'any'}+${rules.floorMax == null ? '' : ` to ${rules.floorMax}`} · Remaining lease ${(rules.leaseMonthsMin ?? 0) / 12}–${(rules.leaseMonthsMax ?? 1188) / 12} years`, 'tracker-meta'),
            element('p', `Dataset ${snapshot.dataset.fingerprint.slice(0, 12)} · Prices in SGD · PSF per square foot`, 'tracker-meta'));
        if (sampleCount === 1 && stats.medianPrice !== undefined) host.append(element('p', `Completed price ${sgd.format(stats.medianPrice)}`));
        if (sampleCount > 1 && stats.medianPrice !== undefined && stats.minPrice !== undefined && stats.maxPrice !== undefined) {
            host.append(element('p', `Median ${sgd.format(stats.medianPrice)} · Range ${sgd.format(stats.minPrice)}–${sgd.format(stats.maxPrice)}`));
        }
        if (!rows.length) return;
        const table = new TransactionTable(rows, { pageSize: 8 });
        const root = element('div');
        root.innerHTML = table.markup();
        table.mount(root);
        host.append(root);
    }

    private renderSaved(home: ComparisonHome, onBack: (comparison?: Comparison) => void, saved: Comparison): void {
        const status = textStatus('Checking the saved dataset version…');
        const results = element('div', undefined, 'tracker-results');
        this.host.append(status, results, action('Start a fresh comparison', () => this.open(home, onBack)));
        const generation = ++this.generation;
        void (async () => {
            try {
                const identity = await this.datasetIdentity(saved.rules);
                if (identity.fingerprint !== saved.dataset.fingerprint) throw new Error('Dataset changed');
                const rows = await this.loadRows(saved.geometry, saved.rules);
                if (rows.length !== saved.sampleCount) throw new Error('Selection changed');
                if (generation !== this.generation) return;
                const shape = saved.geometry;
                const selection = shape.kind === 'rectangle'
                    ? rectangleSelection(shape.minLat, shape.minLng, shape.maxLat, shape.maxLng)
                    : circleSelection(shape.lat, shape.lng, shape.kind === 'circle' ? shape.radiusMeters : 1);
                this.map.setCompletedSalesComparison(selection, rows);
                status.textContent = 'Saved comparison · Original dataset available';
                this.renderResults(results, saved, rows);
            } catch {
                if (generation !== this.generation) return;
                status.textContent = 'Saved snapshot · The original dataset could not be reproduced. The saved figures and available row snapshots are below.';
                const rows = saved.comparables.map((row) => ({
                    transaction_date: new Date(`${row.month}-01T12:00:00Z`),
                    flat_type: row.flatType, storey_range: row.storeyRange, resale_price: row.resalePrice,
                    floor_area_sqm: row.floorAreaSqm,
                } as HDBTransaction));
                this.renderResults(results, saved, rows);
                if (saved.truncatedDetails) results.append(element('p', 'The saved row details contain the first 100 comparable sales.'));
            }
        })();
    }
}
