import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { ManualSource } from '../../convex/trackerTypes';
import type { Comparison } from './CompletedSales';
import { action, asking, dateLabel, deletionForm, disclosure, element, errorMessage, group, input, label, link, observed, shortlistButton, submit, textStatus } from './dom';
import { lookupPostal, type BlockLookup } from './geocodes';
import { homeEditor } from './HomeEditor';
import { progressLabels, progressSelect } from './progress';

type Home = Doc<'candidates'>;
type Source = Doc<'sourceListings'>;
type Note = Doc<'notes'>;
type Patch = FunctionArgs<typeof api.tracker.editCandidate>['patch'];
type View = 'overview' | 'edit' | 'listings' | 'delete';

export function homeReference(home: Home): string {
    return `Home ${home.publicId.slice(0, 8).toUpperCase()}`;
}

export function homeTitle(home: Home, block?: BlockLookup): string {
    return home.location.rawAddress || block?.address || home.title || home.location.postalCode || homeReference(home);
}

export function homeFacts(home: Home): string {
    const { facts } = home.summary;
    return [facts.flatType?.value, facts.area?.value && factValue(facts.area.value),
        home.location.unitNumber || (facts.floor?.value && `Floor ${factValue(facts.floor.value)}`),
        home.title && home.title !== home.location.rawAddress ? home.title : undefined].filter(Boolean).join(' · ') || 'Property details unknown';
}

type Options = {
    collectionId: Id<'collections'>;
    candidateId: Id<'candidates'>;
    backLabel: string;
    goBack(): void;
    fields(): Doc<'customFields'>[];
    getBlock(home: Home): BlockLookup | undefined;
    collectionArchived?: boolean;
    onRemoved(): void;
    openComparison(home: Home, block: BlockLookup | undefined, onBack: (snapshot?: Comparison) => void, saved?: Comparison): void;
    onChanged(): void;
};

export class HomeDetail {
    private detail?: { candidate: Home; sources: Source[] };
    private request = 0;
    private disposed = false;
    private busy = false;
    private operationIds = new Map<string, string>();
    private notes: Note[] = [];
    private noteCursor: string | null = null;
    private allNotes = false;
    private notesReady = false;
    private notesError = false;
    private rationaleNote?: Note;
    private bodyDraft?: string;
    private attached?: Comparison | null;
    private view: View = 'overview';
    private readonly status = textStatus();
    private block?: BlockLookup;
    private blockLookupError = false;
    private notesText?: HTMLTextAreaElement;
    private readonly ids: Pick<Options, 'collectionId' | 'candidateId'>;

    constructor(private readonly host: HTMLElement, private readonly client: ConvexClient, private readonly options: Options) {
        this.ids = { collectionId: options.collectionId, candidateId: options.candidateId };
    }

    open(): void {
        const back = this.back();
        this.host.replaceChildren(back, textStatus('Loading saved home…'));
        back.focus({ preventScroll: true });
        void this.fetchDetail(true).catch(() => {
            if (!this.disposed) this.host.replaceChildren(this.back(), textStatus('This home could not load.'), action('Retry', () => this.open()));
        });
    }

    close(): void {
        this.disposed = true;
        this.request += 1;
        this.operationIds.clear();
    }

    private back(): HTMLButtonElement {
        return action(this.options.backLabel, this.options.goBack, 'tracker-button tracker-quiet');
    }

    private async fetchDetail(loadNotes = false): Promise<void> {
        const request = ++this.request;
        const detail = await this.client.query(api.tracker.candidateDetail, this.ids);
        if (!detail) throw new Error('Home missing');
        if (this.disposed || request !== this.request) return;
        this.detail = detail;
        this.block = this.options.getBlock(detail.candidate);
        this.blockLookupError = false;
        this.render();
        if (!this.block && ['confirmed', 'matched'].includes(detail.candidate.location.status) && detail.candidate.location.postalCode) {
            void lookupPostal(detail.candidate.location.postalCode).then((block) => {
                if (this.disposed || request !== this.request) return;
                this.block = block ?? undefined;
                this.blockLookupError = !block;
            }).catch(() => { if (!this.disposed && request === this.request) this.blockLookupError = true; });
        }
        if (loadNotes) void this.loadNotes(true);
    }

    private async loadNotes(reset = false): Promise<void> {
        try {
            if (reset) {
                this.notes = [];
                this.noteCursor = null;
                this.allNotes = false;
                this.notesReady = false;
                this.notesError = false;
                this.rationaleNote = undefined;
            }
            do {
                const result = await this.client.query(api.tracker.listNotes, { ...this.ids, paginationOpts: { cursor: this.noteCursor, numItems: 20 } });
                if (this.disposed) return;
                this.notes.push(...result.page);
                this.noteCursor = result.continueCursor;
                this.allNotes = result.isDone;
                this.rationaleNote ??= this.notes.find((note) => note.kind === 'rationale');
            } while (reset && !this.rationaleNote && !this.allNotes);
            this.notesReady = true;
        } catch {
            if (this.disposed) return;
            this.notesError = true;
        }
        this.renderNoteSlot();
    }

    private async save<T>(key: string, payload: unknown, mutate: (operationId: string) => Promise<T>, after?: () => void): Promise<void> {
        if (this.busy || this.disposed) return;
        const body = JSON.stringify([key, payload]);
        const operationId = this.operationIds.get(body) ?? crypto.randomUUID();
        this.operationIds.set(body, operationId);
        this.busy = true;
        this.status.textContent = 'Saving…';
        this.status.scrollIntoView({ block: 'nearest' });
        try {
            await mutate(operationId);
            this.operationIds.delete(body);
            if (this.disposed) return;
            this.status.textContent = 'Saved.';
            this.options.onChanged();
            after?.();
            if (this.disposed) return;
            try { await this.fetchDetail(); }
            catch { if (!this.disposed) this.status.textContent = 'Saved. Reopen this home to refresh its latest details.'; }
        } catch (error) {
            if (this.disposed) return;
            this.status.textContent = errorMessage(error, 'This change could not be saved. Your edits are still here. Use the save action to retry.');
            if (/conflict|changed|revision|out of date/i.test(this.status.textContent)) this.showConflict(payload);
        } finally {
            this.busy = false;
        }
    }

    private showConflict(payload: unknown): void {
        void this.client.query(api.tracker.candidateDetail, this.ids).then((latest) => {
            if (this.disposed || !latest) return;
            const local = typeof payload === 'object' && payload !== null ? Object.entries(payload) : [];
            const incoming = latest.candidate as Record<string, unknown>;
            const fields = local.filter(([key]) => key in incoming && factValue(incoming[key]) !== factValue(keyValue(payload, key)));
            const note = element('div', undefined, 'tracker-conflict');
            note.append(element('h3', 'This home changed while you were editing'));
            for (const [key, value] of fields) {
                note.append(element('p', `${humanize(key)} · Saved ${factValue(incoming[key])} · Your edit ${factValue(value)}`));
            }
            if (!fields.length) note.append(element('p', 'Your inputs are still in this form. Reload the saved record before making another change.'));
            note.append(action('Reload saved home', () => {
                note.remove();
                void this.fetchDetail(true).catch(() => { this.status.textContent = 'The latest home could not load.'; });
            }));
            this.status.after(note);
        }).catch(() => {});
    }

    private async edit(patch: Patch, after?: () => void): Promise<void> {
        if (!this.detail) return;
        const expectedRevision = this.detail.candidate.revision;
        await this.save('candidate', patch, (operationId) => this.client.mutation(api.tracker.editCandidate, {
            ...this.ids, patch, expectedRevision, operationId,
        }), after);
    }

    private show(view: View): void {
        if (this.busy) return;
        this.view = view;
        this.status.textContent = '';
        this.render();
    }

    private render(): void {
        if (!this.detail || this.disposed) return;
        const { candidate: home, sources } = this.detail;
        if (this.view === 'delete' && home.recordState !== 'archived') this.view = 'overview';
        const view = this.view;
        if (view !== 'overview') {
            const titles = { edit: 'Edit home', listings: 'Listing links', delete: 'Permanently delete home' };
            const back = action(view === 'edit' ? 'Cancel edit' : 'Back to home', () => this.show('overview'), 'tracker-button tracker-quiet');
            const heading = element('h2', titles[view]);
            heading.tabIndex = -1;
            const contents = view === 'edit' ? homeEditor(home, this.options.fields(), (patch) => this.edit(patch, () => { this.view = 'overview'; }))
                : view === 'listings' ? this.renderListingLinks(home, sources) : this.renderDeletion(home);
            this.host.replaceChildren(back, heading, this.status, contents);
            heading.focus();
            return;
        }
        const previous = document.activeElement;
        const needsFocus = !(previous instanceof HTMLElement) || this.host.contains(previous) || previous === document.body;
        const openDisclosures = new Set([...this.host.querySelectorAll<HTMLDetailsElement>('details[open]')]
            .map((box) => box.querySelector('summary')?.textContent));
        const name = homeTitle(home, this.block);
        const title = element('h2', name);
        title.tabIndex = -1;
        const star = shortlistButton(name, home.shortlisted, () => { void this.edit({ shortlisted: !home.shortlisted }); });
        star.disabled = !!this.options.collectionArchived;
        const titleRow = element('div', undefined, 'tracker-home-title');
        titleRow.append(title, star);
        const source = sources.find((item) => item._id === home.summary.askingSourceListingId)
            ?? sources.find((item) => item._id === home.preferredSourceListingId);
        const overview = element('header', undefined, 'tracker-header tracker-home-heading');
        const metadata = [homeFacts(home), home.location.postalCode !== name ? home.location.postalCode : undefined,
            home.recordState === 'archived' ? 'Archived' : undefined].filter(Boolean).join(' · ');
        overview.append(titleRow, element('p', metadata, 'tracker-meta'),
            element('p', asking(home.summary.askingPriceCents), 'tracker-ask tracker-detail-ask'));
        if (source) {
            const date = home.summary.askingObservedAt == null ? `Recorded ${dateLabel(source.lastRecordedAt)}` : observed(home.summary.askingObservedAt);
            const origin = home.summary.askingTimeBasis === 'buyer_reported' ? ' · Entered by buyer' : '';
            overview.append(element('p', `${sourceName(source)} · ${date}${origin}`, 'tracker-meta'));
        }
        const controls = group();
        controls.classList.add('tracker-home-actions');
        if (!this.options.collectionArchived) controls.append(action('Edit home', () => this.show('edit')));
        const listing = link('Open ad', source?.url);
        if (listing) {
            listing.classList.add('tracker-quiet');
            controls.append(listing);
        }
        controls.append(this.renderActions(home));
        overview.append(controls, this.renderProgress(home));
        const notes = element('section');
        notes.dataset.notesSlot = 'true';
        this.host.replaceChildren(this.back(), overview, this.status, notes,
            action('Compare completed sales', () => this.compare(home), 'tracker-button tracker-compare-trigger'));
        this.renderNoteSlot();
        for (const box of this.host.querySelectorAll('details')) if (openDisclosures.has(box.querySelector('summary')?.textContent)) box.open = true;
        if (needsFocus) {
            const focus = previous?.classList.contains('tracker-shortlist-toggle') ? star
                : previous?.closest('.tracker-home-progress') ? overview.querySelector('select') ?? title : title;
            focus.focus({ preventScroll: true });
        }
    }

    private renderProgress(home: Home): HTMLElement {
        if (this.options.collectionArchived) return element('p', `Progress · ${progressLabels[home.progress]}`, 'tracker-meta');
        const progress = progressSelect(home.progress);
        const save = submit('Save progress');
        save.disabled = true;
        progress.addEventListener('change', () => { save.disabled = progress.value === home.progress; });
        const form = element('form', undefined, 'tracker-home-progress');
        form.append(group(label('Progress', progress), save));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!save.disabled) void this.edit({ progress: progress.value as Home['progress'] });
        });
        return form;
    }

    private renderNoteSlot(): void {
        const section = this.host.querySelector<HTMLElement>('[data-notes-slot]');
        if (!section || !this.detail || this.disposed) return;
        section.className = 'tracker-section';
        const home = this.detail.candidate;
        section.replaceChildren(element('h3', 'Private notes'));
        if (!this.notesReady) {
            section.append(textStatus(this.notesError ? 'Notes could not load.' : 'Loading private notes…'));
            if (this.notesError) section.append(action('Retry notes', () => { void this.loadNotes(true); }));
            return;
        }
        const form = element('form', undefined, 'tracker-form');
        const note = this.rationaleNote;
        const body = element('textarea');
        body.rows = 5; body.maxLength = 10_000;
        body.value = this.bodyDraft ?? note?.body ?? '';
        this.notesText = body;
        form.append(label('Reason or notes', body));
        const attachment = this.attached === undefined ? note?.comparisonContext : this.attached;
        if (attachment) {
            form.append(element('p', `Comparison attached · ${attachment.sampleCount} completed sales · ${attachment.rules.startMonth} to ${attachment.rules.endMonth}`, 'tracker-meta'),
                group(action('Open attached comparison', () => this.compare(home, attachment)),
                    action('Remove comparison', () => { this.attached = null; this.renderNoteSlot(); this.notesText?.focus(); }, 'tracker-button tracker-quiet')));
        }
        const save = submit('Save notes');
        const hasChanges = () => note ? body.value !== note.body || this.attached !== undefined : Boolean(body.value.trim() || attachment);
        save.disabled = !hasChanges();
        body.addEventListener('input', () => {
            this.bodyDraft = body.value;
            save.disabled = !hasChanges();
        });
        form.append(save);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!hasChanges()) return;
            const params = { ...this.ids, kind: 'rationale' as const, body: body.value, noteId: note?._id,
                expectedRevision: note?.revision, comparisonContext: this.attached,
                deleted: !!note && !body.value.trim() && !attachment ? true : undefined };
            void this.save('rationale note', params, (operationId) => this.client.mutation(api.tracker.saveNote, { ...params, operationId }), () => {
                this.bodyDraft = undefined;
                this.attached = undefined;
                void this.loadNotes(true);
            });
        });
        section.append(form);
        if (!this.allNotes || this.notes.some((entry) => entry._id !== note?._id)) section.append(this.renderPreviousNotes(home));
    }

    private renderPreviousNotes(home: Home): HTMLElement {
        const list = element('ol', undefined, 'tracker-evidence-list');
        const append = (note: Note) => {
            const row = element('li');
            row.append(element('strong', `${humanize(note.kind)} · ${dateLabel(note.occurredAt ?? note.createdAt)}`),
                element('p', note.body, 'tracker-note-text'));
            if (note.occurredAt) row.append(element('p', `Recorded ${dateLabel(note.createdAt)}`, 'tracker-meta'));
            if (note.comparisonContext) row.append(action('Open attached comparison', () => this.compare(home, note.comparisonContext)));
            list.append(row);
        };
        this.notes.filter((note) => note._id !== this.rationaleNote?._id).forEach(append);
        const more = action('Load older notes', () => {
            more.disabled = true;
            void this.loadNotes().finally(() => { more.disabled = false; });
        });
        more.hidden = this.allNotes;
        return disclosure('Previous notes', list, more);
    }

    private compare(home: Home, saved?: Comparison): void {
        const open = () => this.options.openComparison(home, this.block, (snapshot) => {
            if (this.disposed) return;
            if (snapshot) {
                this.attached = snapshot;
                this.renderNoteSlot();
                this.notesText?.focus();
            } else this.host.querySelector<HTMLButtonElement>('.tracker-compare-trigger')?.focus({ preventScroll: true });
        }, saved);
        if (saved || this.block || !home.location.postalCode || !['matched', 'confirmed'].includes(home.location.status)) { open(); return; }
        const retry = this.blockLookupError;
        this.status.textContent = 'Looking up this home’s block…';
        void lookupPostal(home.location.postalCode, retry).then((block) => {
            if (this.disposed) return;
            this.block = block ?? undefined;
            this.status.textContent = '';
            open();
        }).catch(() => {
            this.blockLookupError = true;
            if (this.disposed) return;
            this.status.textContent = 'Block lookup is unavailable. Retry, or choose a drawn area in Analytics to compare.';
            open();
        });
    }

    private renderListingLinks(home: Home, sources: Source[]): HTMLElement {
        const section = element('section', undefined, 'tracker-form');
        const list = element('ul', undefined, 'tracker-evidence-list');
        sources.forEach((source, index) => {
            const open = link(`${sourceName(source)} · Listing ${index + 1}`, source.url);
            if (!open) return;
            const row = element('li');
            row.append(open);
            list.append(row);
        });
        section.append(list.childNodes.length ? list : element('p', 'No listing links yet.', 'tracker-meta'));
        if (this.options.collectionArchived) return section;

        const form = element('form', undefined, 'tracker-form');
        const url = input('url', '', true);
        url.maxLength = 2048;
        url.addEventListener('input', () => url.setCustomValidity(''));
        const add = submit('Link listing');
        form.append(label('URL for another listing of this home', url), group(add));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const listingUrl = url.value.trim();
            if (!link('Listing', listingUrl)) {
                url.setCustomValidity('Enter a valid HTTP or HTTPS listing URL.');
                url.reportValidity();
                return;
            }
            const source: ManualSource = { url: listingUrl };
            url.disabled = add.disabled = true;
            void this.save('source', source, (operationId) => this.client.mutation(api.tracker.linkSource, {
                ...this.ids, operationId, source, expectedRevision: home.revision,
            })).finally(() => { url.disabled = add.disabled = false; });
        });
        section.append(form);
        return section;
    }

    private renderActions(home: Home): HTMLElement {
        const menu = element('details', undefined, 'tracker-menu');
        const summary = element('summary', 'More');
        summary.setAttribute('aria-label', 'More home actions');
        const items = group(action('Listing links', () => this.show('listings')));
        const archived = home.recordState === 'archived';
        if (!this.options.collectionArchived) {
            items.append(action(archived ? 'Restore home' : 'Archive home', () => {
                void this.edit({ recordState: archived ? 'active' : 'archived' }, this.options.onRemoved);
            }));
        }
        if (archived) items.append(action('Delete home', () => this.show('delete')));
        menu.append(summary, items);
        return menu;
    }

    private renderDeletion(home: Home): HTMLElement {
        return deletionForm('home', () => {
            void this.save('delete home', { revision: home.revision }, () => this.client.mutation(api.lifecycle.deleteCandidate, {
                ...this.ids, expectedRevision: home.revision, confirmation: 'delete',
            }), this.options.onRemoved);
        });
    }
}

function sourceName(source: Source): string {
    if (source.portalDisplayName) return source.portalDisplayName;
    if (source.portal && source.portal !== 'other') return humanize(source.portal);
    try { return new URL(source.url).hostname; } catch { return 'Source listing'; }
}

function factValue(value: unknown): string {
    if (value === undefined || value === null) return 'Unknown';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.length ? value.map(factValue).join(', ') : 'None';
    if (typeof value === 'object') {
        const field = value as Record<string, unknown>;
        if (typeof field.sqm === 'number') {
            const sqm = `${field.sqm.toLocaleString('en-SG', { maximumFractionDigits: 2 })} m²`;
            return field.originalUnit === 'sqft' ? `${sqm} (${field.originalValue} sq ft supplied)` : sqm;
        }
        if (field.kind === 'exact') return String(field.originalText ?? field.value);
        if (field.kind === 'range') return String(field.originalText ?? `${field.min}–${field.max}`);
        if ('value' in field) return factValue(field.value);
        return Object.entries(field).map(([key, item]) => `${humanize(key)} ${factValue(item)}`).join(' · ') || 'Unknown';
    }
    return 'Unknown';
}

function keyValue(value: unknown, key: string): unknown {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function humanize(value: string): string {
    const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}
