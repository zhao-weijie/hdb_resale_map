import type { LocationInput, ManualSource, SourceFacts } from '../../convex/trackerTypes';
import { action, asking, element, flatTypes, group, input, label, select, submit, textStatus, errorMessage, link } from './dom';
import { addressWithUnit, lookupPostal, type BlockLookup } from './geocodes';
import { areaMeasurement, floorMeasurement } from './homeMeasurements';

export type ManualDraft = { operationId: string; title?: string; location: LocationInput; sources: ManualSource[] };
const draftKey = 'hdb_tracker_manual_v1';
const draftExpiryMs = 15 * 60 * 1000;

export function loadManualDraft(): ManualDraft | undefined {
    try {
        const record = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
        if (record?.draft && typeof record.savedAt === 'number' && Date.now() - record.savedAt < draftExpiryMs) return record.draft;
        sessionStorage.removeItem(draftKey);
    } catch { /* Current-tab review still works without session storage. */ }
    return undefined;
}

export function discardManualDraft(): void {
    try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
}

type Options = {
    signedIn: () => boolean;
    targetReady: () => boolean;
    signIn: () => void;
    collectionName: () => string;
    save: (draft: ManualDraft) => Promise<void>;
    cancel: () => void;
};

export function mountHomeForm(host: HTMLElement, options: Options, recovered?: ManualDraft): () => void {
    let latest = recovered;
    let updateAuth = () => {};
    const form = element('form', undefined, 'tracker-form');
    form.noValidate = true;
    const header = element('h2', 'Add home');
    header.tabIndex = -1;
    const back = action('Back to saved homes', options.cancel, 'tracker-button tracker-quiet');
    const review = element('div', undefined, 'tracker-form');
    review.hidden = true;
    host.replaceChildren(back, header, form, review);
    const title = input('text', recovered?.title);
    title.maxLength = 120;
    const address = input('text', recovered?.location.rawAddress);
    address.maxLength = 400;
    const postal = input('text', recovered?.location.postalCode);
    postal.pattern = '[0-9]{6}'; postal.maxLength = 6; postal.inputMode = 'numeric';
    const unit = input('text', recovered?.location.unitNumber);
    unit.maxLength = 64;
    const identity = element('fieldset', undefined, 'tracker-home-identity');
    const identityRequirement = 'Enter at least one';
    const identityStatus = textStatus();
    identityStatus.classList.add('tracker-sr-only');
    identity.append(element('legend', identityRequirement), identityStatus, label('Full address', address),
        group(label('Postal code', postal), label('Custom label', title)));
    identity.addEventListener('input', () => {
        if ([address, postal, title].some((field) => field.value.trim())) identityStatus.textContent = '';
    });
    const facts = recovered?.sources[0]?.facts;
    const flatType = select([['', 'Unknown'], ...flatTypes.map((value) => [value, value] as const)], facts?.flatType ?? '');
    const area = input('number', facts?.area ? String(facts.area.originalValue) : '');
    area.min = '0.01'; area.step = 'any';
    const areaUnit = select([['sqm', 'm²'], ['sqft', 'sq ft']], facts?.area?.originalUnit ?? 'sqm');
    const floor = input('text', facts?.floor?.originalText ?? '');
    floor.placeholder = 'Example 08 or 07–09';
    const sourceList = element('div', undefined, 'tracker-source-list');
    const sources: ReturnType<typeof sourceFields>[] = [];
    function addSource(source?: ManualSource): HTMLInputElement {
        const fields = sourceFields(sources.length + 1, source);
        sources.push(fields);
        sourceList.append(fields.root);
        if (sources.length > 1) fields.root.append(action('Remove this listing', () => {
            sources.splice(sources.indexOf(fields), 1);
            fields.root.remove();
            sources.forEach((entry, index) => { entry.legend.textContent = `Source listing ${index + 1}`; });
            add.disabled = false;
            add.focus();
        }, 'tracker-button tracker-quiet'));
        if (sources.length >= 10) add.disabled = true;
        return fields.url;
    }
    const add = action('Add another listing URL', () => addSource().focus());
    if (recovered?.sources.length) recovered.sources.forEach(addSource);
    else addSource();
    const status = textStatus();
    const proceed = submit('Review home');
    form.append(identity, sourceList, add, label('Unit number', unit), label('Floor or floor range', floor),
        label('Flat type', flatType), group(label('Floor area', area), label('Area unit', areaUnit)), proceed, status);

    const renderReview = (draft: ManualDraft, block: BlockLookup | null, lookupError: boolean): void => {
        latest = draft;
        form.hidden = true;
        review.hidden = false;
        const target = element('p');
        const note = textStatus();
        const locationStatus = textStatus();
        const confirmation = element('div', undefined, 'tracker-form');
        const save = action('Save home', () => { void saveHome(); }, 'tracker-button tracker-primary');
        let busy = false;
        updateAuth = () => {
            const ready = !options.signedIn() || options.targetReady();
            target.textContent = ready ? `Save 1 home to ${options.collectionName()}.` : 'Loading your target collection…';
            save.textContent = options.signedIn() ? 'Save home' : 'Sign in to save';
            save.disabled = busy || !ready;
        };
        updateAuth();
        const titleText = draft.title || addressWithUnit(draft.location.rawAddress, draft.location.unitNumber)
            || draft.location.postalCode || 'New home';
        const evidence = element('ul', undefined, 'tracker-evidence-list');
        for (const source of draft.sources) {
            const row = element('li');
            const sourceLink = link('Open listing', source.url);
            row.append(element('strong', new URL(source.url).hostname),
                element('span', asking(source.facts?.askingPriceCents)),
                element('span', `Agent name ${source.contact?.name ?? 'Unknown'} · Phone number ${source.contact?.phoneRaw ?? 'Unknown'}`));
            if (sourceLink) row.append(sourceLink);
            evidence.append(row);
        }
        const applyBlock = (selected: boolean) => {
            if (busy) return;
            draft.location = {
                rawAddress: draft.location.rawAddress, postalCode: draft.location.postalCode, unitNumber: draft.location.unitNumber,
                status: selected ? 'confirmed' : 'unresolved',
                matchMethod: selected ? 'buyer_selected' : undefined,
                geocodeVersion: selected ? block?.version : undefined,
            };
            draft.operationId = crypto.randomUUID();
            locationStatus.textContent = selected ? 'Location confirmed for this block.' : 'This home will be saved with an unresolved location.';
        };
        if (block) {
            confirmation.append(
                element('p', `Entered address · ${addressWithUnit(draft.location.rawAddress, draft.location.unitNumber) || 'Unknown'}`),
                element('p', `Postal lookup · Blk ${block.block} · ${block.address} · ${block.postalCode} · ${block.method === 'dataset' ? 'Public block dictionary' : 'OneMap address search'}`),
                group(action('Confirm block', () => applyBlock(true)), action('Keep unresolved', () => applyBlock(false))),
            );
            locationStatus.textContent = draft.location.status === 'confirmed'
                ? 'Location confirmed for this block.' : 'Review this block match before saving, or keep the location unresolved.';
        } else {
            locationStatus.textContent = draft.location.status === 'confirmed'
                ? 'The block lookup is currently unavailable. Your confirmed postal code is retained.'
                : lookupError ? 'The block lookup is unavailable. Retry or save this home unresolved.'
                : 'No unique block match. You can save the address and review its location later.';
            if (lookupError) confirmation.append(action('Retry block lookup', () => { void refreshReview(draft, true); }));
        }
        review.replaceChildren(element('h3', titleText), target, evidence, confirmation, locationStatus,
            group(save, action('Edit home', () => { if (!busy) { review.hidden = true; form.hidden = false; address.focus(); } }),
                action('Discard draft', () => { if (!busy) { discardManualDraft(); options.cancel(); } }, 'tracker-button tracker-quiet')), note);
        save.focus({ preventScroll: true });
        async function saveHome(): Promise<void> {
            if (busy || (options.signedIn() && !options.targetReady())) return;
            if (!options.signedIn()) {
                try { sessionStorage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), draft })); }
                catch { /* The review stays mounted while signing in. */ }
                options.signIn();
                return;
            }
            busy = true;
            save.disabled = true;
            note.textContent = 'Saving home…';
            try {
                await options.save(draft);
                discardManualDraft();
            } catch (error) {
                note.textContent = errorMessage(error, 'The home could not be saved. Use Save home to retry.');
            } finally {
                busy = false;
                updateAuth();
            }
        }
    };
    async function refreshReview(draft: ManualDraft, retry = false): Promise<void> {
        proceed.disabled = true;
        status.textContent = draft.location.postalCode ? 'Looking up the block…' : '';
        let block: BlockLookup | null = null;
        let lookupError = false;
        if (draft.location.postalCode) {
            try { block = await lookupPostal(draft.location.postalCode, retry); }
            catch { lookupError = true; }
        }
        status.textContent = '';
        proceed.disabled = false;
        renderReview(draft, block, lookupError);
    }
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        status.textContent = '';
        const buyerLabel = title.value.trim() || undefined;
        const rawAddress = address.value.trim() || undefined;
        const postalCode = postal.value.trim() || undefined;
        const unitNumber = unit.value.trim() || undefined;
        if (!buyerLabel && !rawAddress && !postalCode) {
            identityStatus.textContent = identityRequirement;
            address.focus();
            return;
        }
        identityStatus.textContent = '';
        for (const [index, { url }] of sources.entries()) {
            const value = url.value.trim();
            url.setCustomValidity(value && !link('Listing', value)
                ? `Listing ${index + 1} needs a valid HTTP or HTTPS URL.` : '');
            if (!url.reportValidity()) return;
        }
        if (!form.reportValidity()) return;

        const normalizedFloor = floorMeasurement(floor.value);
        if (floor.value.trim() && !normalizedFloor) {
            status.textContent = 'Enter a whole-number floor or a range such as 07–09.';
            floor.focus();
            return;
        }
        const listingSources = sources.map((fields, index): ManualSource => {
            const originalUnit = areaUnit.value === 'sqft' ? 'sqft' : 'sqm';
            const originalValue = Number(area.value);
            const sourceFacts: SourceFacts = {
                askingPriceCents: fields.ask.value ? Math.round(Number(fields.ask.value) * 100) : undefined,
                ...(index === 0 ? {
                    flatType: flatTypes.find((value) => value === flatType.value),
                    area: area.value ? areaMeasurement(originalValue, originalUnit) : undefined,
                    floor: normalizedFloor, rawAddress, postalCode, unitNumber,
                } : {}),
            };
            const contact = { name: fields.name.value.trim() || undefined, phoneRaw: fields.phone.value.trim() || undefined };
            return { url: fields.url.value.trim(), facts: sourceFacts, contact: contact.name || contact.phoneRaw ? contact : undefined };
        });
        void refreshReview({ operationId: crypto.randomUUID(), title: buyerLabel,
            location: { status: 'unresolved', rawAddress, postalCode, unitNumber }, sources: listingSources });
    });
    if (latest) void refreshReview(latest);
    else header.focus({ preventScroll: true });
    return () => updateAuth();
}

function requiredMark(): HTMLSpanElement {
    const mark = element('span', '*', 'tracker-required');
    mark.setAttribute('aria-hidden', 'true');
    return mark;
}

function sourceFields(index: number, source?: ManualSource) {
    const root = element('fieldset');
    const legend = element('legend', `Source listing ${index}`);
    const url = input('url', source?.url, true);
    const name = input('text', source?.contact?.name);
    const phone = input('tel', source?.contact?.phoneRaw);
    const ask = input('number', source?.facts?.askingPriceCents == null ? '' : String(source.facts.askingPriceCents / 100));
    ask.min = '0.01'; ask.step = '0.01'; ask.max = '100000000';
    url.maxLength = 2048; name.maxLength = 120; phone.maxLength = 80;
    url.addEventListener('input', () => url.setCustomValidity(''));
    root.append(legend, label('Listing URL', url, requiredMark()),
        group(label('Agent name', name), label('Phone number', phone)), label('Asking price in SGD', ask));
    return { root, legend, url, name, phone, ask };
}
