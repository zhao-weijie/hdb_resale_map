import type { ConvexClient } from 'convex/browser';
import type { Infer } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { ImportRow, LocationInput, previewRow } from '../../convex/trackerTypes';
import type { BlockLookup } from './geocodes';
import { action, asking, disclosure, element, errorMessage, group, input, label, select, textStatus } from './dom';
import {
    BACKUP_FORMAT, IMPORT_BYTES, fields, hashFile, isPrivateField, normalizeRow, readTrackerFile, suggestMapping,
    type AreaUnit, type CustomField, type TrackerFile,
} from './imports';
import {
    applyBackup, backupFileHash, csvPrivateColumns, csvPublicColumns, discardBackup, downloadFile, exportBackup, exportCsv, inspectBackup,
} from './backupFiles';
import './import-export.css';

type Preview = Infer<typeof previewRow>;
type Receipt = Doc<'importItems'>;
type RowIssue = { field: string; message: string };
type ReviewRow = {
    input: ImportRow; issues: RowIssue[]; preview?: Preview;
    block?: BlockLookup; locationMessage?: string;
};
type Attempt = {
    key: string; collectionId?: Id<'collections'>; runId?: Id<'importRuns'>;
    rows: ImportRow[]; receipts: Receipt[];
};
type Draft = {
    expires: number;
    name: string;
    hash: string;
    file: TrackerFile;
    mapping: Record<string, string>;
    area: AreaUnit | '';
    corrections: Record<number, Partial<Record<string, string>>>;
    skipped: number[];
    privateApproved: boolean;
    collectionId?: Id<'collections'>;
    attempt?: Attempt;
};
type RestoreDraft = { hash: string; key: string; collectionId?: Id<'collections'> };
type BackupSelection = { file: File; summary: Awaited<ReturnType<typeof inspectBackup>>; restore: RestoreDraft };
export interface ImportExportProps {
    collectionId?: Id<'collections'>;
    collectionName?: string;
    signedIn: boolean;
    customFields?: CustomField[];
    lookupPostal(postalCode: string): Promise<BlockLookup | null>;
    requestSignIn(): void;
    onClose(): void;
    onSaved(collectionId: Id<'collections'>, candidateIds?: Id<'candidates'>[], unresolvedOnly?: boolean): void;
}
const draftKey = 'hdb-tracker-import-v2';
const restoreKey = 'hdb-tracker-restore-v2';
const draftTTL = 2 * 60 * 60 * 1000;
const pageRows = 20;
const batchBytes = 250 * 1024;
const textEncoder = new TextEncoder();

function readStored<T>(key: string): T | undefined {
    try {
        const value = sessionStorage.getItem(key);
        return value ? JSON.parse(value) as T : undefined;
    } catch { return undefined; }
}

function store<T>(key: string, value?: T): boolean {
    try {
        if (value === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch { return false; }
}

function pendingDraft() {
    const draft = readStored<Draft>(draftKey);
    if (draft && draft.expires > Date.now() && draft.file && Array.isArray(draft.file.rows)) return draft;
    if (draft) store(draftKey);
}

export function hasPendingImport(): boolean {
    return Boolean(pendingDraft() || readStored<RestoreDraft>(restoreKey));
}

function fieldLabel(field: string, definitions: CustomField[]) {
    return fields.find(([key]) => key === field)?.[1] ??
        definitions.find(definition => field === 'custom.' + definition.publicId)?.label ??
        field.replace(/([A-Z])/g, ' $1').replace(/\./g, ' · ');
}

function showValue(field: string, value: unknown): string {
    if (value === null || value === undefined) return 'Unknown';
    if (typeof value === 'number' && field.toLowerCase().endsWith('askingpricecents')) return asking(value);
    if (typeof value === 'object' && 'sqm' in value && typeof value.sqm === 'number') return value.sqm.toFixed(1) + ' m²';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function batches(rows: ImportRow[]): ImportRow[][] {
    const result: ImportRow[][] = [];
    let chunk: ImportRow[] = [];
    let bytes = 0;
    for (const row of rows) {
        const length = textEncoder.encode(JSON.stringify(row)).length;
        if (chunk.length >= 25 || (chunk.length && bytes + length > batchBytes)) {
            result.push(chunk);
            chunk = [];
            bytes = 0;
        }
        chunk.push(row);
        bytes += length;
    }
    if (chunk.length) result.push(chunk);
    return result;
}

function describeBlock(rawAddress: string | undefined, block: BlockLookup) {
    if (!rawAddress) return true;
    const street = (value: string) => value.toUpperCase().replace(/\b(?:BLK|BLOCK|SINGAPORE)\b/g, '')
        .replace(/#\s*\d+\s*-\s*\d+/g, '').replace(/\b\d{6}\b/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
    const supplied = street(rawAddress);
    const address = street(block.address);
    const expected = street(block.block + ' ' + block.streetName);
    return !supplied || supplied.includes(expected) || address.includes(supplied);
}

export function mountImportExport(host: HTMLElement, client: ConvexClient, initial: ImportExportProps) {
    let props = initial;
    let mode: 'import' | 'export' | undefined;
    let draft = pendingDraft();
    let restoreDraft = readStored<RestoreDraft>(restoreKey);
    let backup: BackupSelection | undefined;
    let review: ReviewRow[] = [];
    let view: 'map' | 'review' | 'results' = draft?.attempt ? 'results' : 'map';
    let busy = false;
    let generation = 0;
    let message = '';
    let issue = '';
    let page = 0;
    let editFailed = false;
    let previewDirty = false;
    let opener: HTMLElement | null = null;
    const csvColumns = new Set<string>(csvPublicColumns.map(([key]) => key));
    const definitions = () => props.customFields ?? [];
    const fileInput = input('file');
    fileInput.accept = '.csv,.json,text/csv,application/json';
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) void chooseFile(file);
    });
    host.classList.add('tracker-transfer');
    host.hidden = true;
    host.addEventListener('keydown', event => {
        if (event.key === 'Escape' && mode && !busy) {
            event.stopPropagation();
            close();
            props.onClose();
        }
    });

    function persist() {
        if (!draft) return true;
        draft.expires = Date.now() + draftTTL;
        return store(draftKey, draft);
    }

    function open(next: 'import' | 'export') {
        if (busy) return;
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        mode = next;
        issue = '';
        message = '';
        render(true);
        if (next === 'import' && props.signedIn) void findInterruptedRestore();
    }

    async function findInterruptedRestore() {
        const token = generation;
        try {
            const pending = await client.query(api.backups.pendingRestore, {});
            if (token !== generation || !props.signedIn || mode !== 'import' || busy) return;
            if (pending) {
                restoreDraft = pending;
                store(restoreKey, pending);
                if (backup?.restore.hash === pending.hash) backup.restore = pending;
            } else if (restoreDraft?.collectionId) {
                restoreDraft = undefined;
                store(restoreKey);
            }
            render();
        } catch { /* The selected file can still resume a local restore session. */ }
    }

    function close() {
        if (busy) return;
        if (draft?.attempt && draft.attempt.receipts.length === draft.attempt.rows.length &&
            !draft.attempt.receipts.some(receipt => ['rejected', 'conflict'].includes(receipt.outcome))) {
            draft = undefined;
            view = 'map';
        }
        mode = undefined;
        host.hidden = true;
        host.replaceChildren();
        opener?.focus();
    }

    async function work(fallback: string, job: (token: number) => Promise<void>) {
        if (busy) return;
        busy = true;
        issue = '';
        const token = ++generation;
        render();
        try { await job(token); }
        catch (error) {
            if (token === generation) issue = errorMessage(error, error instanceof Error && !/^\[CONVEX/.test(error.message) ? error.message : fallback);
        } finally {
            if (token === generation) {
                busy = false;
                message = '';
                render(true);
            }
        }
    }

    async function chooseFile(file: File) {
        await work('This file could not be opened.', async token => {
            const json = /\.json$/i.test(file.name) || file.type === 'application/json';
            if (json) {
                const head = await file.slice(0, 64 * 1024).text();
                if (head.includes('"' + BACKUP_FORMAT + '"') || file.size > IMPORT_BYTES) {
                    const summary = await inspectBackup(file);
                    const hash = await backupFileHash(file);
                    if (token !== generation) return;
                    if (restoreDraft && restoreDraft.hash !== hash) throw new Error('Discard or resume the interrupted restore before choosing another backup.');
                    const restore = restoreDraft ?? { hash, key: crypto.randomUUID() };
                    backup = { file, summary, restore };
                    return;
                }
            }
            if (file.size > IMPORT_BYTES) throw new Error('Choose a listing file up to 10 MiB.');
            const parsed = readTrackerFile(await file.text(), json ? 'json_tracker' : 'csv');
            const hash = await hashFile(file);
            if (token !== generation) return;
            backup = undefined;
            review = [];
            view = 'map';
            editFailed = false;
            draft = {
                expires: Date.now() + draftTTL, name: file.name, hash, file: parsed, mapping: suggestMapping(parsed.columns),
                area: '', corrections: {}, skipped: [], privateApproved: false, collectionId: props.collectionId,
            };
        });
    }

    function revise(row: ReviewRow, field: string, value: string) {
        if (!draft) return;
        const number = row.input.rowNumber;
        draft.corrections[number] = { ...draft.corrections[number], [field]: value };
        previewDirty = true;
        const save = host.querySelector<HTMLButtonElement>('[data-save-import]');
        if (save) save.disabled = true;
    }

    function skip(number: number, value: boolean) {
        if (!draft) return;
        const selected = new Set(draft.skipped);
        if (value) selected.add(number);
        else selected.delete(number);
        draft.skipped = [...selected];
        if (!value && props.signedIn && !review.find(row => row.input.rowNumber === number)?.preview) void preview(true);
        else { persist(); render(); }
    }

    async function preview(keepPage = false) {
        const current = draft;
        if (!current) return;
        if (Object.values(current.mapping).some(isPrivateField) && !current.privateApproved) {
            issue = 'Confirm the mapped private columns before reviewing this import.';
            render();
            return;
        }
        await work('Preview could not be checked. Try again.', async token => {
            const expectedCollection = current.attempt?.collectionId ?? props.collectionId;
            if (props.signedIn && !current.attempt && current.collectionId && current.collectionId !== expectedCollection) {
                throw new Error('Open the original collection before resuming this import, or discard the draft.');
            }
            const receipts = new Map(current.attempt?.receipts.map(receipt => [receipt.rowNumber, receipt]));
            const earlier = new Map(current.attempt?.rows.map(row => [row.rowNumber, row]));
            const targetRows = editFailed ? current.file.rows.filter(row => {
                const receipt = receipts.get(row.number);
                return receipt && ['rejected', 'conflict'].includes(receipt.outcome);
            }) : current.file.rows;
            const next: ReviewRow[] = targetRows.map(({ number, cells }) => {
                const corrections = current.corrections[number] ?? {};
                const mapping = { ...current.mapping };
                const amended = { ...cells };
                for (const [field, value] of Object.entries(corrections)) {
                    if (field.startsWith('$') || value === undefined) continue;
                    const column = Object.keys(mapping).find(column => mapping[column] === field) ?? '$' + field;
                    mapping[column] = field;
                    amended[column] = value;
                }
                const { row, issues } = normalizeRow(amended, mapping, current.area, definitions());
                if (row.source && corrections.$undated === 'yes') row.source.acceptUndatedAsCurrent = true;
                const key = crypto.randomUUID();
                const receipt = receipts.get(number);
                return {
                    issues,
                    input: {
                        ...row, rowNumber: number, rowKey: key, logicalRowKey: earlier.get(number)?.logicalRowKey ?? key,
                        ...(corrections.$link ? { linkCandidateId: corrections.$link as Id<'candidates'> } : {}),
                        ...(editFailed && receipt ? { supersedesItemId: receipt._id } : {}),
                    },
                };
            });
            message = 'Checking source matches and block locations…';
            render();
            const lookup = new Map<string, Promise<BlockLookup | null>>();
            for (let offset = 0; offset < next.length; offset += 8) {
                await Promise.all(next.slice(offset, offset + 8).map(async row => {
                    if (current.skipped.includes(row.input.rowNumber)) return;
                    const facts = row.input.source?.facts;
                    if (!facts) return;
                    const correction = current.corrections[row.input.rowNumber] ?? {};
                    const postalCode = correction.$matchPostal || facts.postalCode;
                    const address = facts.rawAddress ?? undefined;
                    const unitNumber = facts.unitNumber ?? undefined;
                    const location: LocationInput = {
                        status: 'unresolved', ...(postalCode ? { postalCode } : {}),
                        ...(address ? { rawAddress: address } : {}), ...(unitNumber ? { unitNumber } : {}),
                    };
                    row.input.location = location;
                    if (!postalCode) { row.locationMessage = 'Postal code is missing. The home can be saved for later review.'; return; }
                    if (!/^\d{6}$/.test(postalCode)) {
                        row.issues.push({ field: 'postalCode', message: 'Use six digits for the block lookup.' });
                        return;
                    }
                    try {
                        let request = lookup.get(postalCode);
                        if (!request) {
                            request = props.lookupPostal(postalCode);
                            lookup.set(postalCode, request);
                        }
                        row.block = (await request) ?? undefined;
                        if (!row.block) { row.locationMessage = 'No unique block found for ' + postalCode + '.'; return; }
                        if (correction.$match === 'unresolved') return;
                        if (!describeBlock(address, row.block) && correction.$match !== 'confirmed') {
                            location.status = 'ambiguous';
                            row.locationMessage = 'The supplied address and lookup result need review.';
                            return;
                        }
                        location.status = correction.$match === 'confirmed' ? 'confirmed' : 'matched';
                        location.matchMethod = location.status === 'confirmed' ? 'buyer_selected' :
                            row.block.method === 'dataset' ? 'geocode_dictionary' : 'address_search';
                        location.geocodeVersion = row.block.version;
                    } catch {
                        row.locationMessage = 'Block lookup is temporarily unavailable. You can retry or save the home for location review.';
                    }
                }));
                if (token !== generation) return;
            }
            if (props.signedIn) {
                const active = next.filter(row => !row.issues.length && !current.skipped.includes(row.input.rowNumber));
                const byNumber = new Map(active.map(row => [row.input.rowNumber, row]));
                for (const rows of batches(active.map(row => row.input))) {
                    const results: Preview[] = await client.query(api.imports.preview, { collectionId: expectedCollection, rows });
                    if (token !== generation) return;
                    for (const result of results) {
                        const row = byNumber.get(result.rowNumber);
                        if (!row) continue;
                        row.preview = result;
                        if (result.expectedSourceRevision !== undefined) row.input.expectedSourceRevision = result.expectedSourceRevision;
                        if (result.expectedCandidateRevision !== undefined) row.input.expectedCandidateRevision = result.expectedCandidateRevision;
                    }
                }
            }
            if (token !== generation) return;
            review = next;
            previewDirty = false;
            view = 'review';
            if (!keepPage) page = 0;
            persist();
        });
    }

    function signIn() {
        const retained = persist();
        message = retained ? 'Return to this browser after verifying your email to review and save.' :
            'Keep this tab open while you sign in. The browser could not store your draft.';
        render();
        props.requestSignIn();
    }

    function eligible(row: ReviewRow) {
        return !row.issues.length && row.preview && row.preview.status !== 'needs_attention';
    }

    async function save() {
        const current = draft;
        if (!current) return;
        if (!props.signedIn) { signIn(); return; }
        if (!current.attempt || editFailed) {
            const skipped = new Set(current.skipped);
            if (previewDirty || review.some(row => !skipped.has(row.input.rowNumber) && !eligible(row))) {
                issue = 'Correct or skip the rows that need attention, then check the preview again.';
                render();
                return;
            }
            const rows = review.map(({ input: proposed }) => skipped.has(proposed.rowNumber) ? {
                rowKey: proposed.rowKey, logicalRowKey: proposed.logicalRowKey, rowNumber: proposed.rowNumber, skip: true,
                ...(proposed.supersedesItemId ? { supersedesItemId: proposed.supersedesItemId } : {}),
            } : proposed);
            if (!rows.some(row => !row.skip) && !editFailed) return;
            if (editFailed && current.attempt) {
                const failed = new Set(rows.map(row => row.rowNumber));
                current.attempt.rows = [...current.attempt.rows.filter(row => !failed.has(row.rowNumber)), ...rows];
                current.attempt.receipts = current.attempt.receipts.filter(receipt => !failed.has(receipt.rowNumber));
                editFailed = false;
            } else {
                current.attempt = { key: crypto.randomUUID(), collectionId: props.collectionId, rows, receipts: [] };
            }
            persist();
        }
        const attempt = current.attempt;
        view = 'results';
        await work('The import was interrupted. Resume the same run to finish checking its rows.', async token => {
            if (!attempt.runId || !attempt.collectionId) {
                const started = await client.mutation(api.imports.startRun, {
                    collectionId: attempt.collectionId, idempotencyKey: attempt.key, format: current.file.format,
                    fileName: current.name.slice(0, 180), fileHash: current.hash, totalRows: attempt.rows.length,
                    mapping: Object.fromEntries(Object.entries(current.mapping).filter(([, field]) => field)
                        .map(([column, field]) => [field, column])),
                    mode: current.privateApproved ? 'explicit_tracker_update' : 'merge_sources',
                });
                if (token !== generation) return;
                attempt.collectionId = started.collectionId;
                attempt.runId = started.runId;
                persist();
            }
            const received = new Set(attempt.receipts.map(receipt => receipt.rowKey));
            for (const rows of batches(attempt.rows.filter(row => !received.has(row.rowKey)))) {
                const result: Receipt[] = await client.mutation(api.imports.commitRows, {
                    collectionId: attempt.collectionId, runId: attempt.runId, rows,
                });
                if (token !== generation) return;
                attempt.receipts.push(...result);
                message = 'Checked ' + attempt.receipts.length + ' of ' + attempt.rows.length + ' rows…';
                persist();
                render();
            }
            if (!attempt.receipts.some(receipt => ['rejected', 'conflict'].includes(receipt.outcome))) store(draftKey);
        });
    }

    async function restore() {
        if (!backup) return;
        if (!props.signedIn) {
            restoreDraft = backup.restore;
            store(restoreKey, restoreDraft);
            signIn();
            return;
        }
        const chosen = backup;
        await work('The backup could not be restored. Resume with the same file or discard the interrupted restore.', async token => {
            restoreDraft = chosen.restore;
            store(restoreKey, restoreDraft);
            const collectionId = await applyBackup(client, chosen.file, chosen.summary, chosen.restore.key, chosen.restore.hash,
                (status, id) => {
                    if (token !== generation) throw new Error('Restore paused.');
                    chosen.restore.collectionId = id;
                    store(restoreKey, chosen.restore);
                    message = status;
                    render();
                });
            if (token !== generation) return;
            backup = undefined;
            restoreDraft = undefined;
            store(restoreKey);
            mode = undefined;
            props.onSaved(collectionId);
        });
    }

    async function discard() {
        if (!props.signedIn || !restoreDraft) return;
        const id = restoreDraft.collectionId;
        await work('The interrupted restore could not be discarded. Try again.', async token => {
            if (id) await discardBackup(client, id);
            if (token !== generation) return;
            if (backup) backup.restore = { hash: backup.restore.hash, key: crypto.randomUUID() };
            restoreDraft = undefined;
            store(restoreKey);
        });
    }

    async function download(kind: 'csv' | 'json') {
        const collectionId = props.collectionId;
        if (!collectionId || !props.signedIn) return;
        await work('Export could not be completed. Try downloading a fresh copy.', async token => {
            message = kind === 'json' ? 'Preparing the private backup…' : 'Preparing the tracker CSV…';
            render();
            const blob = kind === 'json' ? await exportBackup(client, collectionId, () => {
                if (token !== generation) throw new Error('Export paused.');
            }) : await exportCsv(client, collectionId, csvColumns);
            if (token === generation) downloadFile(blob, 'saved-homes-' + new Date().toISOString().slice(0, 10) + '.' + kind);
        });
    }

    function renderMapping() {
        if (!draft) return;
        const chosen = draft;
        host.append(element('p', chosen.name + ' · ' + chosen.file.rows.length.toLocaleString() + ' rows', 'tracker-muted'));
        host.append(element('h3', 'Map file columns'));
        const options: [string, string][] = [['', 'Skip column'], ...fields.map(([id, name]): [string, string] => [id, name])];
        for (const field of definitions().filter(field => field.state === 'active')) {
            options.push(['custom.' + field.publicId, 'Private custom field · ' + field.label]);
        }
        const mapping = element('div', undefined, 'tracker-transfer-mapping');
        for (const column of chosen.file.columns) {
            const control = select(options, chosen.mapping[column] ?? '');
            control.disabled = busy;
            control.addEventListener('change', () => {
                if (control.value && Object.entries(chosen.mapping).some(([from, field]) => from !== column && field === control.value)) {
                    control.value = chosen.mapping[column] ?? '';
                    issue = 'Map each tracker field to one column.';
                } else {
                    chosen.mapping[column] = control.value;
                    chosen.privateApproved = false;
                    issue = '';
                }
                render();
                [...host.querySelectorAll('select')].find(item => item.dataset.column === column)?.focus();
            });
            control.dataset.column = column;
            const example = chosen.file.rows.find(row => row.cells[column] !== null && row.cells[column] !== undefined && row.cells[column] !== '')?.cells[column];
            const sample = example === undefined ? 'No sample value' : String(example);
            const field = label(column, control);
            field.insertBefore(element('small', sample.length > 100 ? sample.slice(0, 100) + '…' : sample, 'tracker-muted'), control);
            const row = element('div', undefined, 'tracker-transfer-mapping-row');
            row.append(field);
            mapping.append(row);
        }
        host.append(mapping);
        const area = select([['', 'Choose if needed'], ['sqm', 'Square metres (m²)'], ['sqft', 'Square feet (ft²)']], chosen.area);
        area.disabled = busy;
        area.addEventListener('change', () => { chosen.area = area.value as Draft['area']; });
        host.append(label('Default area unit for values without a unit', area));
        if (Object.values(chosen.mapping).some(isPrivateField)) {
            const approve = input('checkbox');
            approve.checked = chosen.privateApproved;
            approve.disabled = busy;
            approve.addEventListener('change', () => { chosen.privateApproved = approve.checked; });
            host.append(label('Apply the mapped private values and append mapped notes. Blank cells preserve saved values.', approve));
        }
        const reviewButton = action('Review rows', () => { void preview(); }, 'tracker-button tracker-primary');
        reviewButton.disabled = busy;
        host.append(group(reviewButton));
    }

    function rowLabel(number: number) {
        const line = draft?.file.rows.find(row => row.number === number)?.line;
        return line === undefined ? 'Row ' + number : 'CSV line ' + line;
    }

    function renderRow(row: ReviewRow) {
        const status = draft?.skipped.includes(row.input.rowNumber) ? 'Skipped' :
            row.issues.length || row.preview?.status === 'needs_attention' ? 'Needs attention' :
                row.preview ? ({ new: 'New', update: 'Update', unchanged: 'Unchanged' } as Record<string, string>)[row.preview.status] :
                    'Awaiting account check';
        const rowTitle = row.input.title ?? row.input.source?.facts?.rawAddress ?? row.input.source?.url ?? 'Listing';
        const body = element('div', undefined, 'tracker-transfer-row-body');
        const facts = row.input.source?.facts;
        if (facts?.askingPriceCents || facts?.area) {
            const original = draft?.file.rows.find(item => item.number === row.input.rowNumber);
            const originalAsk = Object.keys(draft?.mapping ?? {}).find(key => draft?.mapping[key] === 'askingPrice');
            const values = [
                facts.askingPriceCents ? [originalAsk && original?.cells[originalAsk] ? String(original.cells[originalAsk]) : undefined, asking(facts.askingPriceCents)].filter(Boolean).join(' → ') : undefined,
                facts.area ? facts.area.originalValue + ' ' + facts.area.originalUnit + ' → ' + facts.area.sqm.toFixed(1) + ' m²' : undefined,
            ].filter(Boolean);
            body.append(element('p', values.join(' · '), 'tracker-muted'));
        }
        const problems = [...row.issues, ...(row.preview?.problems ?? [])];
        if (problems.length) {
            const list = element('ul', undefined, 'tracker-transfer-problems');
            for (const problem of problems) list.append(element('li', fieldLabel(problem.field, definitions()) + ' · ' + problem.message));
            body.append(list);
        }
        if (row.preview?.changes.length) {
            const changes = element('dl', undefined, 'tracker-transfer-changes');
            for (const change of row.preview.changes) {
                changes.append(element('dt', fieldLabel(change.field, definitions())),
                    element('dd', showValue(change.field, change.before) + ' → ' + showValue(change.field, change.after)));
            }
            body.append(changes);
        }
        if (row.locationMessage || row.block) {
            body.append(element('p', row.locationMessage ?? 'Block match found.', 'tracker-muted'));
            if (row.block) body.append(element('p', row.block.address + ' · ' + row.block.postalCode));
        }
        const postal = input('text', draft?.corrections[row.input.rowNumber]?.$matchPostal ?? facts?.postalCode ?? '');
        postal.inputMode = 'numeric';
        postal.maxLength = 6;
        postal.addEventListener('input', () => revise(row, '$matchPostal', postal.value));
        const location = select([['', 'Use block lookup'], ['confirmed', 'Confirm this postal-code match'], ['unresolved', 'Save for location review']],
            draft?.corrections[row.input.rowNumber]?.$match ?? '');
        location.addEventListener('change', () => revise(row, '$match', location.value));
        const similar = row.preview?.similarCandidates ?? [];
        if (similar.length) {
            const candidates: [string, string][] = [['', 'Keep as a separate home']];
            for (const home of similar) candidates.push([
                home.candidateId, (home.title ?? home.location.rawAddress ?? home.location.postalCode ?? 'Saved home') +
                    ' · ' + asking(home.summary.askingPriceCents) + ' · ' + home.publicId.slice(0, 8),
            ]);
            const choice = select(candidates, row.input.linkCandidateId ?? '');
            choice.addEventListener('change', () => revise(row, '$link', choice.value));
            body.append(label('Possible matches in this collection', choice));
        }
        const fix = element('div', undefined, 'tracker-transfer-correction');
        const fieldsToEdit = new Set(['url', ...problems.map(problem => problem.field)]);
        for (const key of fieldsToEdit) {
            const id = key.replace(/^(source\.facts\.|source\.|facts\.)/, '');
            if (!fields.some(([field]) => field === id) && !id.startsWith('custom.')) continue;
            const origin = Object.keys(draft?.mapping ?? {}).find(column => draft?.mapping[column] === id);
            const raw = origin ? draft?.file.rows.find(item => item.number === row.input.rowNumber)?.cells[origin] : undefined;
            const field = input(id === 'url' ? 'url' : 'text', draft?.corrections[row.input.rowNumber]?.[id] ?? String(raw ?? ''));
            field.addEventListener('input', () => revise(row, id, field.value));
            fix.append(label(fieldLabel(id, definitions()), field));
        }
        if (row.input.source?.observedAt === undefined) {
            const override = input('checkbox');
            override.checked = Boolean(row.input.source?.acceptUndatedAsCurrent);
            override.addEventListener('change', () => revise(row, '$undated', override.checked ? 'yes' : 'no'));
            fix.append(label('Treat this undated row as my current report', override));
        }
        fix.append(label('Postal code for block lookup', postal), label('Block match', location));
        const refresh = action('Check this correction', () => { void preview(true); });
        refresh.disabled = busy;
        fix.append(refresh);
        body.append(disclosure('Correct row or location', fix));
        const omitted = input('checkbox');
        omitted.checked = status === 'Skipped';
        omitted.disabled = busy;
        omitted.addEventListener('change', () => skip(row.input.rowNumber, omitted.checked));
        body.append(label('Skip this row', omitted));
        const item = disclosure(rowLabel(row.input.rowNumber) + ' · ' + status + ' · ' + rowTitle, body);
        item.classList.add('tracker-transfer-review-row');
        item.open = review.length === 1;
        return item;
    }

    function renderReview() {
        if (!draft) return;
        host.append(element('p', draft.name + ' · ' + (props.collectionName ?? (props.collectionId ? 'Selected collection' : 'Your private collection')), 'tracker-muted'));
        const selected = review.filter(row => !draft?.skipped.includes(row.input.rowNumber));
        const usable = selected.filter(eligible);
        const problems = selected.filter(row => row.issues.length || row.preview?.status === 'needs_attention').length;
        const counts = [
            ['New', usable.filter(row => row.preview?.status === 'new').length],
            ['Updates', usable.filter(row => row.preview?.status === 'update').length],
            ['Unchanged', usable.filter(row => row.preview?.status === 'unchanged').length],
            ['Needs attention', problems],
        ] as const;
        host.append(textStatus(props.signedIn ? counts.map(([label, count]) => count + ' ' + label.toLowerCase()).join(' · ') :
            selected.length + ' selected · ' + problems + ' with input issues. Sign in to check saved listing matches.'));
        host.append(element('p', draft.privateApproved ? 'Only mapped private fields will be changed. Existing notes stay in place, and mapped notes are appended.' :
            'Saved progress, shortlist, viewing notes and custom values are preserved.', 'tracker-muted'));
        const list = element('div', undefined, 'tracker-transfer-review');
        const ordered = [...review].sort((a, b) => Number(Boolean(b.issues.length || b.preview?.status === 'needs_attention')) -
            Number(Boolean(a.issues.length || a.preview?.status === 'needs_attention')));
        for (const row of ordered.slice(page * pageRows, (page + 1) * pageRows)) list.append(renderRow(row));
        host.append(list);
        if (review.length > pageRows) {
            const previous = action('Previous rows', () => { page--; render(); });
            const next = action('Next rows', () => { page++; render(); });
            previous.disabled = busy || page === 0;
            next.disabled = busy || (page + 1) * pageRows >= review.length;
            host.append(group(previous, element('span', 'Page ' + (page + 1) + ' of ' + Math.ceil(review.length / pageRows)), next));
        }
        const saveButton = action(props.signedIn ? 'Save ' + usable.length + (usable.length === 1 ? ' row' : ' rows') : 'Sign in to save', () => { void save(); }, 'tracker-button tracker-primary');
        saveButton.dataset.saveImport = '';
        saveButton.disabled = busy || previewDirty || (props.signedIn && (usable.length !== selected.length || (!usable.length && !editFailed)));
        const map = action('Change mapping', () => { view = 'map'; render(true); });
        map.disabled = busy || editFailed;
        host.append(group(map, saveButton));
    }

    function renderResults() {
        const attempt = draft?.attempt;
        if (!attempt) return;
        if (!props.signedIn) {
            host.append(element('p', 'Sign in to access the import results.'), group(action('Sign in', signIn)));
            return;
        }
        if (attempt.collectionId && props.collectionId !== attempt.collectionId) {
            host.append(element('p', 'Open the collection where this import started to access its results.'));
            return;
        }
        const received = attempt.receipts.length;
        const failures = attempt.receipts.filter(receipt => ['rejected', 'conflict'].includes(receipt.outcome));
        const count = (outcome: string) => attempt.receipts.filter(receipt => receipt.outcome === outcome).length;
        host.append(textStatus(count('accepted') + ' saved · ' + count('unchanged') + ' unchanged · ' + count('skipped') +
            ' skipped · ' + failures.length + ' need attention' + (received < attempt.rows.length ? ' · ' + (attempt.rows.length - received) + ' pending' : '')));
        if (failures.length) {
            const list = element('ul', undefined, 'tracker-transfer-problems');
            for (const receipt of failures) list.append(element('li', rowLabel(receipt.rowNumber) + ' · ' + receipt.problems.map(problem => problem.message).join(' ')));
            host.append(list);
        }
        if (received < attempt.rows.length) {
            const resume = action(props.signedIn ? 'Resume import' : 'Sign in to resume', () => { void save(); }, 'tracker-button tracker-primary');
            resume.disabled = busy;
            host.append(group(resume));
            return;
        }
        const ids = [...new Set(attempt.receipts.flatMap(receipt => receipt.candidateId ? [receipt.candidateId] : []))];
        const id = attempt.collectionId;
        const show = (unresolved?: boolean) => {
            if (!id) return;
            close();
            props.onSaved(id, ids, unresolved);
        };
        if (id && ids.length && props.signedIn) host.append(group(
            action('View imported homes', () => show(), 'tracker-button tracker-primary'),
            action('Review locations', () => show(true)),
        ));
        if (failures.length) {
            const retry = action('Correct failed rows', () => { editFailed = true; void preview(); });
            retry.disabled = busy || !props.signedIn;
            const clear = action('Close results', () => { draft = undefined; view = 'map'; review = []; store(draftKey); render(true); });
            clear.disabled = busy;
            host.append(group(retry, clear));
        }
    }

    function previewColumns() {
        return [...csvPublicColumns, ...csvPrivateColumns].filter(([key]) => csvColumns.has(key)).map(([, title]) => title).join(' · ') || 'Choose at least one column.';
    }

    function renderExport() {
        if (!props.collectionId || !props.signedIn) {
            host.append(element('p', 'Open your private collection to download it.'));
            return;
        }
        host.append(element('h3', 'Tracker CSV'));
        host.append(element('p', 'One row per active home using the selected listing. Choose which columns to download.', 'tracker-muted'));
        for (const [legend, options] of [['Listing facts', csvPublicColumns], ['Private columns', csvPrivateColumns]] as const) {
            const columns = element('fieldset', undefined, 'tracker-transfer-columns');
            columns.append(element('legend', legend));
            for (const [id, title] of options) {
                const control = input('checkbox');
                control.checked = csvColumns.has(id);
                control.disabled = busy;
                control.addEventListener('change', () => {
                    if (control.checked) csvColumns.add(id);
                    else csvColumns.delete(id);
                    const preview = host.querySelector<HTMLElement>('[data-csv-preview]');
                    if (preview) preview.textContent = previewColumns();
                    const button = host.querySelector<HTMLButtonElement>('[data-download-csv]');
                    if (button) button.disabled = !csvColumns.size;
                });
                columns.append(label(title, control));
            }
            host.append(columns);
        }
        const columns = element('p', previewColumns(), 'tracker-muted');
        columns.dataset.csvPreview = '';
        const csv = action('Download tracker CSV', () => { void download('csv'); }, 'tracker-button tracker-primary');
        csv.dataset.downloadCsv = '';
        csv.disabled = busy || !csvColumns.size;
        host.append(columns, group(csv), element('h3', 'Private JSON backup'));
        host.append(element('p', 'Includes your progress, shortlist, notes, contacts, custom fields, source observations and change history. Restore it into a separate private collection.', 'tracker-muted'));
        const json = action('Download private backup', () => { void download('json'); });
        json.disabled = busy;
        host.append(group(json));
    }

    function render(focus = false) {
        host.hidden = !mode;
        if (!mode) { host.replaceChildren(); return; }
        const back = action('Back to saved homes', () => { close(); props.onClose(); }, 'tracker-button tracker-transfer-back');
        back.disabled = busy;
        const title = element('h2', mode === 'export' ? 'Export saved homes' :
            backup ? 'Restore private backup' : view === 'results' ? 'Import results' : view === 'review' ? 'Review import' : 'Import file');
        title.tabIndex = -1;
        host.replaceChildren(back, title);
        if (issue) {
            const error = element('p', issue, 'tracker-transfer-error');
            error.setAttribute('role', 'alert');
            host.append(error);
        }
        if (message || busy) host.append(textStatus(message || 'Working…'));
        if (mode === 'export') renderExport();
        else if (draft?.collectionId && draft.collectionId !== props.collectionId && !draft.attempt) {
            host.append(element('p', 'Open the original collection to access this draft.'), group(action('Discard draft', () => {
                draft = undefined; review = []; view = 'map'; issue = ''; store(draftKey); render(true);
            })));
        } else if (backup) {
            host.append(element('p', backup.file.name + ' · ' + backup.summary.total.toLocaleString() + ' records', 'tracker-muted'));
            host.append(element('p', 'Restore “' + backup.summary.header.name + '” as a separate private collection. It will appear after all records and references have been checked.'));
            const confirm = action(props.signedIn ? (backup.restore.collectionId ? 'Resume restore' : 'Restore as new collection') : 'Sign in to restore',
                () => { void restore(); }, 'tracker-button tracker-primary');
            confirm.disabled = busy;
            const choose = action('Choose a different file', () => { backup = undefined; render(true); });
            choose.disabled = busy;
            host.append(group(confirm, choose));
        } else if (view === 'results') renderResults();
        else {
            if (view === 'map') {
                host.append(element('p', 'Choose a CSV, a listing JSON file, or a private JSON backup.', 'tracker-muted'));
                fileInput.disabled = busy;
                host.append(label('Choose a file', fileInput));
                renderMapping();
            } else renderReview();
            if (draft && !draft.attempt) {
                const discard = action('Discard draft', () => {
                    draft = undefined; review = []; view = 'map'; editFailed = false; issue = ''; store(draftKey); render(true);
                });
                discard.disabled = busy;
                host.append(group(discard));
            }
        }
        if (mode === 'import' && restoreDraft && props.signedIn) {
            if (!backup) host.append(element('p', 'An interrupted restore is saved here. Choose the original backup file to resume.', 'tracker-muted'));
            const remove = action('Discard interrupted restore', () => { void discard(); });
            remove.disabled = busy;
            host.append(group(remove));
        }
        if (focus) title.focus();
    }

    return {
        open,
        close,
        update(next: ImportExportProps) {
            const previous = props;
            props = next;
            if (previous.signedIn && !next.signedIn) {
                generation++;
                busy = false;
                draft = undefined;
                backup = undefined;
                restoreDraft = undefined;
                review = [];
                mode = undefined;
                editFailed = false;
                view = 'map';
                store(draftKey);
                store(restoreKey);
                render();
                return;
            }
            if (!previous.signedIn && next.signedIn && mode === 'import') void findInterruptedRestore();
            const collectionChanged = previous.collectionId !== next.collectionId;
            const boundCollection = draft?.attempt?.collectionId ?? draft?.collectionId;
            if (collectionChanged && previous.collectionId && boundCollection === previous.collectionId && next.collectionId !== boundCollection) {
                generation++;
                busy = false;
                review = [];
                if (!draft?.attempt) view = 'map';
                issue = 'Open the original collection to resume this import.';
                render();
                return;
            }
            if (mode === 'import' && draft && !draft.attempt && view === 'review' &&
                ((!previous.signedIn && next.signedIn) || collectionChanged ||
                    (next.signedIn && previous.customFields?.length !== next.customFields?.length && Object.values(draft.mapping).some(isPrivateField)))) {
                if (busy) { generation++; busy = false; }
                void preview();
            } else if (mode && !busy && (previous.signedIn !== next.signedIn || previous.collectionId !== next.collectionId ||
                previous.collectionName !== next.collectionName || previous.customFields?.length !== next.customFields?.length)) render();
        },
    };
}
