import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { createElement as createIcon, ListFilter } from 'lucide';
import type { AnalyticsPanel } from '../analytics/AnalyticsPanel';
import type { DataLoader } from '../data/DataLoader';
import type { MapView } from '../map/MapView';
import { appState } from '../state/AppState';
import { listingClient } from './client';
import { CompletedSales } from './CompletedSales';
import { action, asking, deletionForm, disclosure, element, errorMessage, group, input, label, select, shortlistButton, submit, textStatus } from './dom';
import { lookupPostal, type BlockLookup } from './geocodes';
import { discardManualDraft, loadManualDraft, mountHomeForm, type ManualDraft } from './HomeForm';
import { hasPendingImport, mountImportExport, type ImportExportProps } from './ImportExport';
import { HomeDetail, homeReference, homeTitle, homeFacts } from './HomeDetail';
import { progressLabels, progressSelect } from './progress';
import { mountColumns, renderCustomValue } from './TrackerColumns';

type Candidate = Doc<'candidates'>;
type Collection = Doc<'collections'>;
type Field = Doc<'customFields'>;
type Screen = 'list' | 'detail' | 'chooser' | 'manual' | 'auth' | 'import' | 'columns' | 'manage';
type SortKey = 'createdAt' | 'asking' | 'lastMeaningfulChangeAt';
type Filter = { query: string; progress: string; shortlisted: boolean; resolution: string };
type LocationResult = BlockLookup | 'loading' | 'error' | 'missing';
type Origin = { screen: 'list' | 'chooser'; scroll: number; candidateId?: Id<'candidates'>; opener?: HTMLElement; block?: string };
const defaultFilter: Filter = { query: '', progress: '', shortlisted: false, resolution: '' };
const sortOptions = [
    ['createdAt', 'Recently added'], ['asking', 'Asking price'], ['lastMeaningfulChangeAt', 'Last changed'],
] as const;

export class TrackerPanel {
    private readonly list = element('div', undefined, 'tracker-view');
    private readonly detailHost = element('div', undefined, 'tracker-view');
    private readonly manual = element('div', undefined, 'tracker-view');
    private readonly auth = element('div', undefined, 'tracker-view');
    private readonly importHost = element('div', undefined, 'tracker-view tracker-import-host');
    private readonly importBody = element('div');
    private readonly columns = element('div', undefined, 'tracker-view');
    private readonly manage = element('div', undefined, 'tracker-view');
    private readonly chooser = element('div', undefined, 'tracker-view');
    private readonly live = element('span', undefined, 'tracker-sr-only');
    private readonly shortlistStatus = textStatus();
    private readonly shortlistSaves = new Map<Id<'candidates'>, { revision: number; operationId: string; pending: boolean }>();
    private readonly comparison: CompletedSales;
    private readonly importer?: ReturnType<typeof mountImportExport>;
    private screen: Screen = 'list';
    private authReturn: Screen = 'list';
    private collectionId?: Id<'collections'>;
    private collections: Collection[] = [];
    private homes: Candidate[] = [];
    private fields: Field[] = [];
    private hiddenColumns = new Set<string>();
    private importFocus?: Set<Id<'candidates'>>;
    private locations = new Map<string, LocationResult>();
    private geocodeGeneration = 0;
    private readGeneration = 0;
    private accountGeneration = 0;
    private unsubscribeCollections?: () => void;
    private collectionRevision?: number;
    private showArchived = false;
    private loading = false;
    private loaded = false;
    private loadError = '';
    private signedIn = false;
    private authReady = false;
    private filters: Filter = { ...defaultFilter };
    private sort: { key: SortKey; direction: 'asc' | 'desc' } = { key: 'createdAt', direction: 'desc' };
    private pinsEnabled = true;
    private listPage = 0;
    private selected?: { candidateId: Id<'candidates'>; origin: Origin };
    private detail?: HomeDetail;
    private chooserListOrigin?: Origin;
    private updateManualAuth?: () => void;
    private results?: HTMLElement;
    private shortlistFocus?: string;
    private count?: HTMLParagraphElement;
    private lastAnnouncement = '';
    private mountedDraft = false;

    constructor(
        private readonly host: HTMLElement,
        private readonly analytics: AnalyticsPanel,
        private readonly data: DataLoader,
        private readonly map: MapView,
    ) {
        this.comparison = new CompletedSales(document.getElementById('tracker-comparison')!, analytics, data, map);
        this.live.setAttribute('role', 'status');
        host.replaceChildren(this.list, this.detailHost, this.chooser, this.manual, this.auth, this.importHost, this.columns, this.manage, this.live);
        this.importHost.append(this.importBody);
        if (listingClient.convex) this.importer = mountImportExport(this.importBody, listingClient.convex, this.importProps());
        this.setScreen('list');
        this.renderList();
        listingClient.subscribeAuth((signedIn) => this.setAuth(signedIn));
        void listingClient.ready.finally(() => {
            this.authReady = true;
            this.setAuth(listingClient.isSignedIn());
            this.renderList();
        });
        host.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (this.screen === 'chooser') this.closeChooser();
            if (this.screen === 'auth') this.cancelAuth();
        });
    }

    enter(): void {
        if (this.mountedDraft || !this.importer) return;
        this.mountedDraft = true;
        const draft = loadManualDraft();
        if (draft) this.openManual(draft);
        else if (hasPendingImport()) this.openImport('import');
    }

    private setScreen(screen: Screen): void {
        this.screen = screen;
        for (const [name, node] of [
            ['list', this.list], ['detail', this.detailHost], ['chooser', this.chooser], ['manual', this.manual],
            ['auth', this.auth], ['import', this.importHost], ['columns', this.columns], ['manage', this.manage],
        ] as const) node.hidden = name !== screen;
        this.host.scrollTop = 0;
    }

    private announce(text: string): void {
        if (this.lastAnnouncement === text) return;
        this.lastAnnouncement = text;
        this.live.textContent = text;
    }

    private importProps(): ImportExportProps {
        return {
            collectionId: this.collectionId,
            collectionName: this.currentCollection()?.name,
            signedIn: this.signedIn,
            customFields: this.fields,
            lookupPostal,
            requestSignIn: () => this.openAuth('import'),
            onClose: () => this.goToList(),
            onSaved: (collectionId, candidateIds, unresolvedOnly) => {
                this.importFocus = candidateIds?.length ? new Set(candidateIds) : undefined;
                this.filters = { ...defaultFilter, resolution: unresolvedOnly ? 'unresolved' : '' };
                this.listPage = 0;
                this.switchCollection(collectionId, true);
                this.goToList();
            },
        };
    }

    private currentCollection(): Collection | undefined {
        return this.collections.find((collection) => collection._id === this.collectionId);
    }

    private setAuth(signedIn: boolean): void {
        if (signedIn === this.signedIn) return;
        const wasSignedIn = this.signedIn;
        this.signedIn = signedIn;
        const generation = ++this.accountGeneration;
        this.unsubscribeCollections?.();
        this.unsubscribeCollections = undefined;
        this.clearCollection();
        this.collections = [];
        if (!signedIn && wasSignedIn) {
            this.importer?.close();
            discardManualDraft();
            this.manual.replaceChildren();
            this.auth.replaceChildren();
            this.importBody.replaceChildren();
            this.columns.replaceChildren();
            this.manage.replaceChildren();
            this.chooser.replaceChildren();
            this.updateManualAuth = undefined;
            this.analytics.showDestination('tracker');
            this.setScreen('list');
        }
        this.importer?.update(this.importProps());
        this.updateManualAuth?.();
        this.renderList();
        if (!signedIn || !listingClient.convex) return;
        this.loading = true;
        this.updateManualAuth?.();
        this.renderList();
        this.unsubscribeCollections = listingClient.convex.onUpdate(api.tracker.listCollections, {}, (collections) => {
            if (generation !== this.accountGeneration) return;
            this.collections = collections;
            const active = collections.find((collection) => collection._id === this.collectionId)
                ?? collections.find((collection) => collection.state === 'active') ?? collections[0];
            if (!active) {
                if (this.collectionId) {
                    this.clearCollection();
                    if (this.screen === 'detail') this.analytics.showDestination('tracker');
                    this.setScreen('list');
                }
                this.loading = false;
                this.loaded = true;
                this.renderList();
                this.updateManualAuth?.();
                return;
            }
            if (active._id !== this.collectionId) this.switchCollection(active._id);
            else if (active.contentRevision !== this.collectionRevision) this.reloadCollection();
            this.importer?.update(this.importProps());
            this.updateManualAuth?.();
        }, (error) => {
            if (generation !== this.accountGeneration) return;
            this.loading = false;
            this.loadError = errorMessage(error, 'Your collections could not load.');
            this.renderList();
        });
    }

    private clearCollection(): void {
        this.readGeneration += 1;
        this.geocodeGeneration += 1;
        this.collectionId = undefined;
        this.collectionRevision = undefined;
        this.showArchived = false;
        this.homes = [];
        this.shortlistSaves.clear();
        this.shortlistStatus.textContent = '';
        this.shortlistFocus = undefined;
        this.fields = [];
        this.locations.clear();
        this.chooserListOrigin = undefined;
        this.clearSelection();
        this.loaded = false;
        this.loading = false;
        this.loadError = '';
        this.hiddenColumns.clear();
        this.refreshPins();
    }

    private switchCollection(id: Id<'collections'>, preserveFilters = false): void {
        if (id === this.collectionId) {
            this.reloadCollection();
            return;
        }
        const priorScreen = this.screen;
        this.clearCollection();
        this.collectionId = id;
        if (!preserveFilters) {
            this.filters = { ...defaultFilter };
            this.importFocus = undefined;
        }
        this.sort = { key: 'createdAt', direction: 'desc' };
        this.listPage = 0;
        if (priorScreen === 'detail' || priorScreen === 'chooser' || priorScreen === 'columns' || priorScreen === 'manage') {
            this.analytics.showDestination('tracker');
            this.setScreen('list');
        }
        this.importer?.update(this.importProps());
        this.reloadCollection();
    }

    private reloadCollection(): void {
        const client = listingClient.convex;
        const collectionId = this.collectionId;
        if (!client || !collectionId || !this.signedIn) return;
        const generation = ++this.readGeneration;
        const recordState = this.showArchived ? 'archived' : 'active';
        this.loading = true;
        this.loadError = '';
        this.renderList();
        void (async () => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const homes: Candidate[] = [];
                let cursor: string | null = null;
                let revision: number | undefined;
                let complete = false;
                const fields = await client.query(api.tracker.listCustomFields, { collectionId });
                do {
                    const result: FunctionReturnType<typeof api.tracker.listCandidates> = await client.query(api.tracker.listCandidates, {
                        collectionId, recordState, paginationOpts: { cursor, numItems: 50 },
                    });
                    if (generation !== this.readGeneration) return;
                    if (revision !== undefined && revision !== result.contentRevision) break;
                    revision = result.contentRevision;
                    homes.push(...result.page);
                    cursor = result.continueCursor;
                    complete = result.isDone;
                } while (!complete);
                if (!complete || (this.currentCollection()?.contentRevision ?? 0) > (revision ?? 0)) continue;
                const unseen = !this.loaded;
                this.homes = homes;
                this.fields = fields;
                this.collectionRevision = revision;
                this.loading = false;
                this.loaded = true;
                this.importer?.update(this.importProps());
                if (this.selected && !homes.some((home) => home._id === this.selected?.candidateId)) {
                    const origin = this.selected.origin;
                    this.analytics.showDestination('tracker');
                    this.goToList(origin);
                    this.announce('The selected home is no longer in this list.');
                }
                if (unseen) {
                    const config = this.currentCollection()?.trackerView;
                    this.hiddenColumns = new Set(config?.hiddenColumns ?? []);
                }
                this.renderList();
                this.refreshFilteredView();
                this.resolveLocations();
                return;
            }
            throw new Error('Collection changed while loading');
        })().catch((error) => {
            if (generation !== this.readGeneration) return;
            this.loading = false;
            this.loadError = errorMessage(error, 'Your saved homes could not load. Retry to refresh the collection.');
            this.renderList();
        });
    }

    private resolveLocations(retry = false): void {
        const generation = ++this.geocodeGeneration;
        const postals = [...new Set(this.homes.flatMap((home) => isMapped(home) && home.location.postalCode ? [home.location.postalCode] : []))];
        const pending = postals.filter((postal) => {
            const state = this.locations.get(postal);
            return !state || state === 'loading' || (retry && (state === 'error' || state === 'missing'));
        });
        for (const postal of pending) this.locations.set(postal, 'loading');
        this.refreshFilteredView();
        void (async () => {
            for (let index = 0; index < pending.length; index += 8) {
                if (generation !== this.geocodeGeneration) return;
                await Promise.all(pending.slice(index, index + 8).map(async (postal) => {
                    let result: LocationResult;
                    try { result = await lookupPostal(postal, retry) ?? 'missing'; }
                    catch { result = 'error'; }
                    if (generation === this.geocodeGeneration) this.locations.set(postal, result);
                }));
                if (generation === this.geocodeGeneration) this.refreshFilteredView();
            }
        })();
    }

    private blockFor(home: Candidate): BlockLookup | undefined {
        const result = home.location.postalCode && isMapped(home) ? this.locations.get(home.location.postalCode) : undefined;
        return typeof result === 'object' ? result : undefined;
    }

    private filteredHomes(): Candidate[] {
        const filters = this.filters;
        const query = filters.query.toLowerCase();
        return this.homes.filter((home) => {
            if (this.importFocus && !this.importFocus.has(home._id)) return false;
            if (filters.progress && home.progress !== filters.progress) return false;
            if (filters.shortlisted && !home.shortlisted) return false;
            const resolution = isMapped(home) ? 'resolved' : 'unresolved';
            if (filters.resolution && resolution !== filters.resolution) return false;
            if (!query) return true;
            return [home.title, home.location.rawAddress, home.location.unitNumber, home.location.postalCode,
                this.blockFor(home)?.address, homeReference(home)].some((value) => value?.toLowerCase().includes(query));
        });
    }

    private refreshFilteredView(clearExcluded = false): void {
        const matching = this.filteredHomes();
        if (clearExcluded && this.selected && !matching.some((home) => home._id === this.selected?.candidateId)) {
            this.clearSelection();
            this.setScreen('list');
            this.announce('The selected home is outside the current filters.');
        } else if (clearExcluded) this.announce(`${matching.length} saved ${matching.length === 1 ? 'home matches' : 'homes match'} the filters.`);
        this.renderResults(matching);
        this.refreshPins(matching);
    }

    private clearSelection(): void {
        this.selected = undefined;
        this.detail?.close();
        this.detail = undefined;
        this.detailHost.replaceChildren();
        this.comparison.close();
        appState.set('selectedCandidateId', null);
    }

    private refreshPins(homes = this.filteredHomes()): void {
        const grouped = new Map<string, { block: BlockLookup; homes: Candidate[] }>();
        for (const home of homes) {
            const block = this.blockFor(home);
            if (!block) continue;
            const key = blockKey(block);
            const group = grouped.get(key) ?? { block, homes: [] };
            group.homes.push(home);
            grouped.set(key, group);
        }
        const showLayer = this.pinsEnabled && !this.showArchived && this.currentCollection()?.state !== 'archived';
        this.map.setSavedBlockPins(showLayer ? [...grouped].map(([key, { block, homes }]) => ({
            key, latitude: block.latitude, longitude: block.longitude, count: homes.length,
            label: `${homes.length} saved ${homes.length === 1 ? 'home' : 'homes'} at Blk ${block.block}`,
            selected: homes.some((home) => this.selected?.candidateId === home._id),
            open: (opener) => {
                this.analytics.showDestination('tracker');
                this.map.closePopup();
                if (homes.length === 1) this.openHome(homes[0], { screen: 'list', scroll: this.host.scrollTop, opener });
                else {
                    this.chooserListOrigin = { screen: 'list', scroll: this.host.scrollTop, opener };
                    this.openChooser(key);
                }
            },
        })) : []);
        const setting = document.getElementById('tracker-layer-setting');
        if (setting) {
            setting.hidden = !this.loaded || !this.collectionId || this.showArchived || this.currentCollection()?.state === 'archived';
            const control = setting.querySelector('input');
            if (control) control.checked = this.pinsEnabled;
            else setting.append(this.layerSetting());
        }
    }

    private layerSetting(): HTMLLabelElement {
        const checkbox = input('checkbox');
        checkbox.checked = this.pinsEnabled;
        checkbox.addEventListener('change', () => {
            this.pinsEnabled = checkbox.checked;
            this.list.querySelectorAll<HTMLInputElement>('[data-tracker-layer]').forEach((item) => { item.checked = this.pinsEnabled; });
            this.refreshPins();
        });
        checkbox.dataset.trackerLayer = 'true';
        const setting = label('Saved homes on map', checkbox);
        setting.classList.add('tracker-checkbox');
        return setting;
    }

    private renderList(): void {
        this.rememberShortlistFocus(this.list);
        const header = element('header', undefined, 'tracker-header');
        const current = this.currentCollection();
        const name = current?.name ?? 'Saved homes';
        const heading = element('h2', name);
        heading.tabIndex = -1;
        this.count = element('p', '', 'tracker-meta');
        header.append(heading, this.count);
        if (current?.state === 'archived') header.append(element('p', 'Archived collection', 'tracker-meta'));
        if (this.showArchived) header.append(element('p', 'Archived homes', 'tracker-meta'));
        const enabled = !!listingClient.convex;
        const add = action('Add home', () => this.openManual(), 'tracker-button tracker-primary');
        const importFile = action('Import', () => this.openImport('import'));
        add.disabled = !enabled || current?.state === 'archived';
        importFile.disabled = !enabled || current?.state === 'archived';
        const actions = group(add, importFile);
        this.list.replaceChildren(header, actions);
        if (!enabled) {
            this.list.append(textStatus('Saved homes is unavailable on this deployment.'));
            return;
        }
        if (!this.authReady && !this.signedIn) {
            this.list.append(textStatus('Checking your sign-in…'));
            return;
        }
        if (!this.signedIn) {
            this.list.append(element('p', 'Keep your listings, agent contacts and viewing notes together.'));
            this.list.append(action('Sign in', () => this.openAuth('list')));
            return;
        }
        if (this.collections.length > 1) {
            const collection = select(this.collections.map((item) => [item._id, item.state === 'archived' ? `${item.name} (archived)` : item.name]), this.collectionId ?? '');
            collection.addEventListener('change', () => {
                const target = this.collections.find((item) => item._id === collection.value);
                if (target) this.switchCollection(target._id);
            });
            header.prepend(label('Collection', collection));
        }
        if (this.collectionId) {
            const menu = element('details', undefined, 'tracker-menu');
            const items = group(action('Columns', () => this.openColumns()), action('Export', () => this.openImport('export')),
                action(this.showArchived ? 'Show active homes' : 'Show archived homes', () => {
                    this.showArchived = !this.showArchived;
                    this.homes = [];
                    this.listPage = 0;
                    this.refreshPins();
                    this.reloadCollection();
                }),
                action('Manage collection', () => this.openManageCollection()));
            if (this.loaded && !this.showArchived && current?.state !== 'archived') items.append(this.layerSetting());
            items.append(action('Sign out', () => { void listingClient.signOut(); }, 'tracker-button tracker-quiet'));
            menu.append(element('summary', 'Collection menu'), items);
            actions.append(menu);
        } else actions.append(action('Sign out', () => { void listingClient.signOut(); }, 'tracker-button tracker-quiet'));
        if (this.loadError) {
            this.list.append(textStatus(this.loadError), action('Retry', () => {
                if (this.collectionId) this.reloadCollection();
                else { this.signedIn = false; this.setAuth(true); }
            }));
        }
        if (this.collectionId && (this.homes.length || this.loaded)) this.list.append(this.listControls());
        this.results = element('div', undefined, 'tracker-results');
        this.list.append(this.shortlistStatus, this.results);
        this.renderResults(this.filteredHomes());
    }

    private listControls(): HTMLElement {
        const controls = element('div', undefined, 'tracker-list-controls');
        const search = input('search', this.filters.query);
        search.placeholder = 'Address, label or home reference';
        const progress = progressSelect(this.filters.progress, true);
        const shortlist = select([['', 'All homes'], ['shortlisted', 'Shortlisted']], this.filters.shortlisted ? 'shortlisted' : '');
        const resolution = select([['', 'All statuses'], ['resolved', 'Resolved'], ['unresolved', 'Unresolved']], this.filters.resolution);
        const sort = select(sortOptions, this.sort.key);
        sort.id = 'tracker-sort';
        sort.disabled = this.loading || !this.loaded;

        const fields = element('div', undefined, 'tracker-filter-fields');
        fields.id = 'tracker-filter-fields';
        fields.hidden = true;
        fields.append(label('Progress', progress), label('Shortlist', shortlist), label('Resolution status', resolution), label('Sort', sort));
        const updateFilters = () => {
            this.filters = { query: search.value.trim(), progress: progress.value, shortlisted: shortlist.value === 'shortlisted', resolution: resolution.value };
            this.listPage = 0;
            this.refreshFilteredView(true);
        };
        search.addEventListener('input', updateFilters);
        fields.addEventListener('change', (event) => {
            if (event.target === sort) this.setSort(sort.value as SortKey);
            else updateFilters();
        });

        const toggle = action('Filter & sort', () => setOpen(fields.hidden), 'tracker-button tracker-filter-toggle');
        const setOpen = (open: boolean) => {
            fields.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
        };
        toggle.prepend(createIcon(ListFilter, { 'aria-hidden': 'true' }));
        toggle.setAttribute('aria-controls', fields.id);
        setOpen(false);
        controls.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || fields.hidden || event.target === search) return;
            event.preventDefault();
            setOpen(false);
            toggle.focus();
        });
        const toolbar = element('div', undefined, 'tracker-results-toolbar');
        toolbar.append(element('h3', 'Results'), toggle);
        controls.append(label('Search saved homes', search), toolbar, fields);
        return controls;
    }

    private renderResults(homes: Candidate[]): void {
        if (!this.results?.isConnected || !this.count?.isConnected) return;
        this.rememberShortlistFocus(this.results);
        const active = document.activeElement;
        const focusId = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-home-id]')?.dataset.homeId : undefined;
        this.results.replaceChildren();
        const mappedCount = this.homes.filter((home) => this.blockFor(home)).length;
        const total = this.homes.length;
        const count = `${total} ${total === 1 ? 'home' : 'homes'} · ${mappedCount} mapped`;
        this.count.textContent = this.loading ? 'Loading saved homes…' : this.loaded ? count : '';
        if (this.loading) {
            this.results.append(textStatus('Loading collection pages…'));
            return;
        }
        if (!this.loaded || this.loadError) {
            this.restoreShortlistFocus();
            return;
        }
        if (!total) {
            if (this.showArchived) this.results.append(element('h3', 'No archived homes'));
            else this.results.append(element('h3', 'No saved homes yet'), element('p', 'Add a listing or import a file to start your search.'));
            this.restoreShortlistFocus();
            return;
        }
        if ([...this.locations.values()].some((state) => state === 'loading')) this.results.append(textStatus('Looking up saved block locations…'));
        if ([...this.locations.values()].some((state) => state === 'error' || state === 'missing')) {
            this.results.append(element('p', 'Some saved block locations are unavailable. Their address and saved match are retained.', 'tracker-meta'),
                action('Retry block lookup', () => this.resolveLocations(true)));
        }
        if (this.importFocus || Object.values(this.filters).some(Boolean)) {
            this.results.append(group(element('p', `${homes.length} of ${total} homes`, 'tracker-meta'), action('Clear filters', () => {
                this.filters = { ...defaultFilter };
                this.importFocus = undefined;
                this.listPage = 0;
                this.renderList();
                this.refreshFilteredView(true);
                this.list.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
            }, 'tracker-button tracker-quiet')));
        }
        if (!homes.length) {
            this.results.append(element('p', 'No homes match these filters.'));
            this.restoreShortlistFocus();
            return;
        }
        const sorted = [...homes].sort((a, b) => {
            const value = (home: Candidate) => this.sort.key === 'asking' ? home.summary.askingPriceCents : home[this.sort.key];
            const first = value(a); const second = value(b);
            if (first == null && second != null) return 1;
            if (second == null && first != null) return -1;
            return ((first ?? 0) - (second ?? 0)) * (this.sort.direction === 'asc' ? 1 : -1) || b.createdAt - a.createdAt;
        });
        const pages = Math.ceil(sorted.length / 30);
        this.listPage = Math.min(this.listPage, pages - 1);
        const visible = sorted.slice(this.listPage * 30, this.listPage * 30 + 30);
        this.results.append(this.compactRows(visible), this.wideRows(visible));
        if (pages > 1) {
            const previous = action('Previous page', () => { this.listPage -= 1; this.renderResults(homes); });
            const next = action('Next page', () => { this.listPage += 1; this.renderResults(homes); });
            previous.disabled = this.listPage === 0; next.disabled = this.listPage === pages - 1;
            this.results.append(group(previous, element('span', `Page ${this.listPage + 1} of ${pages}`), next));
        }
        if (focusId) this.focusHome(focusId);
        this.restoreShortlistFocus();
    }

    private setSort(key: SortKey, toggle = false): void {
        this.sort = { key, direction: toggle && this.sort.key === key
            ? this.sort.direction === 'asc' ? 'desc' : 'asc'
            : key === 'asking' ? 'asc' : 'desc' };
        const sort = this.list.querySelector<HTMLSelectElement>('#tracker-sort');
        if (sort) sort.value = key;
        this.listPage = 0;
        this.renderResults(this.filteredHomes());
        this.announce(`Sorted by ${sortOptions.find(([id]) => id === key)?.[1]}, ${this.sort.direction === 'asc' ? 'ascending' : 'descending'}.`);
    }

    private homeButton(home: Candidate, className: string): HTMLButtonElement {
        const button = action('', () => this.openHome(home, { screen: 'list', scroll: this.host.scrollTop,
            candidateId: home._id, opener: button }), className);
        button.dataset.homeId = home._id;
        return button;
    }

    private shortlistControl(home: Candidate, title: string): HTMLButtonElement {
        const button = shortlistButton(title, home.shortlisted, () => { void this.toggleShortlist(home); });
        button.dataset.shortlistHome = home._id;
        button.disabled = this.currentCollection()?.state !== 'active';
        if (this.shortlistSaves.get(home._id)?.pending) button.setAttribute('aria-disabled', 'true');
        return button;
    }

    private async toggleShortlist(home: Candidate): Promise<void> {
        const client = listingClient.convex;
        const { collectionId, _id: candidateId, revision } = home;
        const prior = this.shortlistSaves.get(candidateId);
        if (!client || !this.signedIn || this.loading || prior?.pending
            || this.collectionId !== collectionId || this.currentCollection()?.state !== 'active') return;

        const shortlisted = !home.shortlisted;
        const save = { revision, operationId: prior?.revision === revision ? prior.operationId : crypto.randomUUID(), pending: true };
        this.shortlistSaves.set(candidateId, save);
        this.shortlistStatus.textContent = '';
        this.renderResults(this.filteredHomes());
        try {
            await client.mutation(api.tracker.editCandidate, {
                collectionId, candidateId, expectedRevision: revision, operationId: save.operationId, patch: { shortlisted },
            });
        } catch (error) {
            if (this.shortlistSaves.get(candidateId) !== save) return;
            save.pending = false;
            const message = errorMessage(error, 'The shortlist could not be updated. Try again.');
            this.shortlistStatus.textContent = message;
            if (/conflict|changed|revision|out of date/i.test(message)) this.reloadCollection();
            else this.renderResults(this.filteredHomes());
            return;
        }
        if (this.shortlistSaves.get(candidateId) !== save) return;
        this.shortlistSaves.delete(candidateId);
        this.announce(shortlisted ? 'Home shortlisted.' : 'Home removed from the shortlist.');
        this.reloadCollection();
    }

    private rememberShortlistFocus(container: HTMLElement): void {
        const active = document.activeElement;
        if (active instanceof HTMLElement && container.contains(active)) this.shortlistFocus = active.dataset.shortlistHome;
    }

    private restoreShortlistFocus(): void {
        const id = this.shortlistFocus;
        this.shortlistFocus = undefined;
        if (!id || this.list.hidden || document.activeElement !== document.body) return;
        const star = [...this.list.querySelectorAll<HTMLButtonElement>('[data-shortlist-home]')]
            .find((node) => node.dataset.shortlistHome === id && node.offsetParent);
        (star ?? this.list.querySelector<HTMLButtonElement>('.tracker-filter-toggle'))?.focus({ preventScroll: true });
    }

    private compactRows(homes: Candidate[]): HTMLElement {
        const list = element('ul', undefined, 'tracker-compact');
        for (const home of homes) {
            const item = element('li');
            const button = this.homeButton(home, 'tracker-home-row');
            const title = homeTitle(home, this.blockFor(home));
            button.append(element('strong', title),
                element('span', asking(home.summary.askingPriceCents), 'tracker-ask'),
                element('span', homeFacts(home), 'tracker-meta'),
                element('span', progressLabels[home.progress], 'tracker-row-step'));
            if (!isMapped(home)) button.append(element('span', 'Review location', 'tracker-attention'));
            item.append(button, this.shortlistControl(home, title));
            list.append(item);
        }
        return list;
    }

    private wideRows(homes: Candidate[]): HTMLElement {
        const wrap = element('div', undefined, 'tracker-wide');
        const table = element('table');
        const head = table.createTHead().insertRow();
        const fields = this.fields.filter((field) => field.state === 'active' && !this.hiddenColumns.has(field.publicId));
        const headers: Array<[string, SortKey?]> = [['Home', 'createdAt'], ['Asking', 'asking'], ['Progress']];
        for (const [text, key] of [...headers, ...fields.map((field): [string] => [field.label])]) {
            const cell = element('th');
            cell.scope = 'col';
            if (key) {
                const button = action(text, () => {
                    this.setSort(key, true);
                    this.results?.querySelector<HTMLButtonElement>(`[data-sort="${key}"]`)?.focus();
                }, 'tracker-sort-header');
                button.dataset.sort = key;
                button.disabled = this.loading;
                cell.append(button);
                if (this.sort.key === key) cell.setAttribute('aria-sort', this.sort.direction === 'asc' ? 'ascending' : 'descending');
            } else cell.textContent = text;
            head.append(cell);
        }
        const body = table.createTBody();
        for (const home of homes) {
            const row = body.insertRow();
            const open = this.homeButton(home, 'tracker-table-home');
            const title = homeTitle(home, this.blockFor(home));
            open.append(element('strong', title), element('span', homeFacts(home), 'tracker-meta'));
            if (!isMapped(home)) open.append(element('span', 'Review location', 'tracker-attention'));
            const homeCell = element('div', undefined, 'tracker-table-home-cell');
            homeCell.append(open, this.shortlistControl(home, title));
            row.insertCell().append(homeCell);
            for (const value of [asking(home.summary.askingPriceCents), progressLabels[home.progress],
                ...fields.map((field) => renderCustomValue(field, home))]) row.insertCell().textContent = value;
        }
        wrap.append(table);
        return wrap;
    }

    private focusHome(id: string): void {
        [...this.list.querySelectorAll<HTMLElement>('[data-home-id]')]
            .find((node) => node.dataset.homeId === id && node.offsetParent)?.focus({ preventScroll: true });
    }

    private goToList(origin?: Origin): void {
        this.clearSelection();
        this.setScreen('list');
        this.renderList();
        this.refreshPins();
        if (!origin) return;
        this.host.scrollTop = origin.scroll;
        if (origin.opener?.isConnected && origin.opener.offsetParent) origin.opener.focus({ preventScroll: true });
        else if (origin.candidateId) this.focusHome(origin.candidateId);
    }

    private openHome(home: Candidate, origin: Origin): void {
        if (!this.signedIn || !this.collectionId || !listingClient.convex) return;
        this.clearSelection();
        this.selected = { candidateId: home._id, origin };
        appState.set('selectedCandidateId', home._id);
        this.setScreen('detail');
        this.refreshPins();
        const block = this.blockFor(home);
        if (block && this.pinsEnabled && !this.showArchived && this.currentCollection()?.state !== 'archived') this.map.revealSavedBlock(block.latitude, block.longitude);
        this.detail = new HomeDetail(this.detailHost, listingClient.convex, {
            collectionId: this.collectionId,
            candidateId: home._id,
            backLabel: origin.block ? `Back to ${this.chooserTitle(origin.block)}` : 'Back to saved homes',
            goBack: () => {
                this.clearSelection();
                if (origin.block) this.openChooser(origin.block, origin);
                else this.goToList(origin);
            },
            fields: () => this.fields,
            getBlock: (candidate) => this.blockFor(candidate),
            collectionArchived: this.currentCollection()?.state === 'archived',
            onRemoved: () => this.goToList(origin),
            openComparison: (candidate, block, onBack, snapshot) => this.comparison.open({
                title: homeTitle(candidate, block), summary: candidate.summary, revision: candidate.revision, block,
            }, onBack, snapshot),
            onChanged: () => this.reloadCollection(),
        });
        this.detail.open();
    }

    private chooserTitle(key: string): string {
        const candidates = this.filteredHomes().filter((home) => {
            const block = this.blockFor(home);
            return block && blockKey(block) === key;
        });
        const block = candidates[0] && this.blockFor(candidates[0]);
        return `${candidates.length} saved homes at Blk ${block?.block ?? key.split('|')[0]}`;
    }

    private openChooser(key: string, origin?: Origin): void {
        this.clearSelection();
        this.setScreen('chooser');
        const homes = this.filteredHomes().filter((home) => {
            const block = this.blockFor(home);
            return block && blockKey(block) === key;
        });
        const title = element('h2', this.chooserTitle(key));
        title.tabIndex = -1;
        this.chooser.replaceChildren(action('Back to saved homes', () => this.closeChooser(), 'tracker-button tracker-quiet'), title);
        for (const home of homes) {
            const button = action('', () => this.openHome(home, { screen: 'chooser', scroll: this.host.scrollTop, candidateId: home._id, block: key }),
                'tracker-home-row');
            button.dataset.homeId = home._id;
            button.append(element('strong', homeTitle(home, this.blockFor(home))),
                element('span', asking(home.summary.askingPriceCents), 'tracker-ask'),
                element('span', `${homeFacts(home)} · ${home.summary.askingSourceName ?? 'Source unknown'} · ${homeReference(home)}`, 'tracker-meta'));
            this.chooser.append(button);
        }
        const block = homes[0] && this.blockFor(homes[0]);
        const match = block && (this.data.getTransactionsForBlock(block.block, block.streetName).find((row) =>
            appState.get('filteredTransactions').includes(row)));
        if (block && match) this.chooser.append(action('See block sales', () => this.analytics.openBlockSales(block.latitude, block.longitude, match)));
        if (origin) this.host.scrollTop = origin.scroll;
        const focus = [...this.chooser.querySelectorAll<HTMLElement>('[data-home-id]')].find((button) => button.dataset.homeId === origin?.candidateId);
        (focus ?? title).focus({ preventScroll: true });
    }

    private closeChooser(): void {
        this.goToList(this.chooserListOrigin);
        this.chooserListOrigin = undefined;
    }

    private openManual(recovered?: ManualDraft): void {
        this.setScreen('manual');
        const attempts = new Map<string, Id<'collections'> | undefined>();
        this.updateManualAuth = mountHomeForm(this.manual, {
            signedIn: () => this.signedIn,
            targetReady: () => this.collectionId !== undefined || (this.loaded && !this.loading && !this.loadError),
            collectionName: () => this.currentCollection()?.name ?? 'My home search',
            signIn: () => this.openAuth('manual'),
            cancel: () => { this.updateManualAuth = undefined; this.manual.replaceChildren(); this.goToList(); },
            save: async (draft) => {
                if (!this.signedIn || !listingClient.convex) return;
                const generation = this.accountGeneration;
                if (!attempts.has(draft.operationId)) attempts.set(draft.operationId, this.collectionId);
                const result = await listingClient.convex.mutation(api.tracker.saveHome, {
                    ...draft, collectionId: attempts.get(draft.operationId),
                });
                if (generation !== this.accountGeneration) return;
                this.switchCollection(result.collectionId);
                this.updateManualAuth = undefined;
                this.manual.replaceChildren();
                this.goToList();
                this.announce('Home saved.');
            },
        }, recovered);
    }

    private openImport(mode: 'import' | 'export'): void {
        if (!this.importer) return;
        this.setScreen('import');
        this.importer.update(this.importProps());
        this.importer.open(mode);
    }

    private openColumns(): void {
        if (!this.collectionId || !listingClient.convex) return;
        this.setScreen('columns');
        mountColumns(this.columns, listingClient.convex, this.collectionId, this.fields, this.hiddenColumns, {
            onClose: () => this.goToList(),
            onChanged: () => this.reloadCollection(),
            onVisibility: (hidden) => { this.hiddenColumns = hidden; this.renderList(); },
            currentCollection: () => this.currentCollection(),
        });
    }

    private openManageCollection(): void {
        const collection = this.currentCollection();
        const client = listingClient.convex;
        if (!collection || !client) return;
        this.setScreen('manage');
        const account = this.accountGeneration;
        const status = textStatus();
        const operationId = crypto.randomUUID();
        let busy = false;
        const apply = async (mutation: () => Promise<unknown>, message: string, deleted = false) => {
            if (busy || account !== this.accountGeneration) return;
            busy = true;
            status.textContent = 'Saving…';
            try {
                await mutation();
                if (account !== this.accountGeneration) return;
                if (deleted) {
                    this.collections = this.collections.filter((item) => item._id !== collection._id);
                    if (this.collectionId === collection._id) {
                        this.clearCollection();
                        const active = this.collections.find((item) => item.state === 'active') ?? this.collections[0];
                        if (active) this.switchCollection(active._id);
                        else this.loaded = true;
                    }
                }
                this.manage.replaceChildren();
                this.goToList();
                this.announce(message);
            } catch (error) {
                if (account === this.accountGeneration) status.textContent = errorMessage(error, 'The collection could not be updated. Try again.');
            } finally { busy = false; }
        };
        const nextState = collection.state === 'archived' ? 'active' : 'archived';
        const stateLabel = nextState === 'active' ? 'Restore collection' : 'Archive collection';
        const back = action('Back to saved homes', () => this.goToList(), 'tracker-button tracker-quiet');
        this.manage.replaceChildren(back, element('h2', `Manage ${collection.name}`), status,
            element('p', 'Archived collections retain their records and can be restored from this menu.'),
            action(stateLabel, () => {
                void apply(() => client.mutation(api.tracker.updateCollection, {
                    collectionId: collection._id, expectedRevision: collection.revision, operationId, state: nextState,
                }), nextState === 'active' ? 'Collection restored.' : 'Collection archived.');
            }),
            disclosure('Permanently delete collection', deletionForm('collection', () => {
                void apply(() => client.mutation(api.lifecycle.deleteCollection, {
                    collectionId: collection._id, expectedRevision: collection.revision, confirmation: 'delete',
                }), 'Collection deleted.', true);
            })));
        back.focus();
    }

    private openAuth(returnTo: Screen): void {
        if (this.signedIn) return;
        this.authReturn = returnTo;
        this.setScreen('auth');
        const form = element('form', undefined, 'tracker-form');
        const email = input('email', '', true); email.autocomplete = 'email';
        const code = input('text'); code.autocomplete = 'one-time-code'; code.inputMode = 'numeric';
        code.pattern = '[0-9]{8}'; code.maxLength = 8;
        const codeField = label('Email verification code', code);
        codeField.hidden = true; code.disabled = true;
        const save = submit('Send verification code');
        const status = textStatus();
        let sent = false;
        const reset = action('Use another email', () => {
            sent = false; code.value = ''; codeField.hidden = true; code.disabled = true; email.readOnly = false;
            save.textContent = 'Send verification code'; reset.hidden = true; status.textContent = ''; email.focus();
        }, 'tracker-button tracker-quiet');
        reset.hidden = true;
        form.append(label('Email address', email), codeField, group(save, reset), status);
        this.auth.replaceChildren(action('Back', () => this.cancelAuth(), 'tracker-button tracker-quiet'),
            element('h2', 'Sign in to Saved homes'),
            element('p', 'Enter the code from your email in this browser to continue.'), form);
        email.focus();
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            save.disabled = true; reset.disabled = true;
            status.textContent = sent ? 'Verifying code…' : 'Sending verification code…';
            void (async () => {
                if (sent) {
                    await listingClient.verifyCode(email.value, code.value);
                    if (this.screen === 'auth') {
                        this.cancelAuth();
                        this.announce('Signed in. Review your collection before saving.');
                    }
                    return;
                }
                await listingClient.sendCode(email.value);
                sent = true; email.readOnly = true; code.disabled = false; code.required = true; codeField.hidden = false;
                reset.hidden = false; save.textContent = 'Verify and sign in';
                status.textContent = 'Check your email for an eight-digit verification code.';
                code.focus();
            })().catch((error) => {
                status.textContent = errorMessage(error, sent ? 'The code could not be verified. Check the code or request a new one.'
                    : 'The verification email could not be sent. Check the address and try again.');
            }).finally(() => { save.disabled = false; reset.disabled = false; });
        });
    }

    private cancelAuth(): void {
        this.setScreen(this.authReturn);
        this.auth.replaceChildren();
        this.updateManualAuth?.();
        const focus = this.host.querySelector<HTMLElement>('.tracker-view:not([hidden]) button');
        focus?.focus({ preventScroll: true });
    }
}

function isMapped(home: Candidate): boolean {
    return home.location.status === 'matched' || home.location.status === 'confirmed';
}

function blockKey(block: BlockLookup): string {
    return `${block.block.toUpperCase()}|${block.streetName.trim().toUpperCase()}`;
}
