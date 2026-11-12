import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { BACKUP_FORMAT, BACKUP_TABLES, csvCell, type BackupFile, type BackupTable, type PortableRecord } from './imports';

type Header = FunctionReturnType<typeof api.backups.exportHeader>;
type Row = { table: BackupTable; payload: PortableRecord };
const maxChunkBytes = 250 * 1024;
const maxRecordCharacters = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const tables = new Set<string>(BACKUP_TABLES);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): never {
    throw new Error('This file is not a complete version 1 listing tracker backup.');
}

/** Read a bounded JSON value at a time. Only a header or one backup record is buffered. */
class JsonFileReader {
    private readonly reader: ReadableStreamDefaultReader<string>;
    private text = '';
    private index = 0;
    private ended = false;

    constructor(file: File) {
        this.reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    }

    close() { return this.reader.cancel(); }

    private async fill() {
        if (this.index < this.text.length) return true;
        if (this.ended) return false;
        const { value, done } = await this.reader.read();
        this.text = value ?? '';
        this.index = 0;
        this.ended = done;
        return !done;
    }

    async next() {
        while (await this.fill()) {
            while (/[\t\r\n ]/.test(this.text[this.index] ?? '')) this.index++;
            if (this.index < this.text.length) return this.text[this.index];
        }
        return '';
    }

    async expect(token: string) {
        if (await this.next() !== token) malformed();
        this.index++;
    }

    async value(): Promise<unknown> {
        const first = await this.next();
        if (!first || '}] ,:'.includes(first)) malformed();
        const composite = first === '{' || first === '[';
        const primitive = !composite && first !== '"';
        let depth = 0;
        let quoted = false;
        let escaped = false;
        let size = 0;
        const pieces: string[] = [];
        let finished = false;
        while (!finished && await this.fill()) {
            const start = this.index;
            while (this.index < this.text.length) {
                const char = this.text[this.index];
                if (primitive && /[,}\]\s]/.test(char)) { finished = true; break; }
                this.index++;
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (char === '\\') escaped = true;
                    else if (char === '"') { quoted = false; if (!composite) { finished = true; break; } }
                } else if (char === '"') quoted = true;
                else if (char === '{' || char === '[') depth++;
                else if (char === '}' || char === ']') {
                    if (--depth === 0) { finished = true; break; }
                }
            }
            const piece = this.text.slice(start, this.index);
            size += piece.length;
            if (size > maxRecordCharacters) throw new Error('One backup record exceeds the restore size limit.');
            pieces.push(piece);
        }
        if (!finished && !primitive) malformed();
        try { return JSON.parse(pieces.join('')); }
        catch { return malformed(); }
    }
}

export async function inspectBackup(file: File, onRow?: (row: Row, offset: number) => Promise<void>) {
    const reader = new JsonFileReader(file);
    const header: Record<string, unknown> = {};
    const used = new Set<string>();
    const usedTables = new Set<string>();
    let total = 0;
    try {
        await reader.expect('{');
        while (await reader.next() !== '}') {
            const field = await reader.value();
            if (typeof field !== 'string' || used.has(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) malformed();
            used.add(field);
            await reader.expect(':');
            if (field !== 'records') header[field] = await reader.value();
            else {
                await reader.expect('{');
                while (await reader.next() !== '}') {
                    const table = await reader.value();
                    if (typeof table !== 'string' || !tables.has(table) || usedTables.has(table)) malformed();
                    usedTables.add(table);
                    await reader.expect(':');
                    await reader.expect('[');
                    while (await reader.next() !== ']') {
                        const payload = await reader.value();
                        if (!isObject(payload) || typeof payload.publicId !== 'string' || !uuidPattern.test(payload.publicId)) malformed();
                        if (onRow) await onRow({ table: table as BackupTable, payload: payload as PortableRecord }, total);
                        total++;
                        if (await reader.next() === ']') break;
                        await reader.expect(',');
                        if (await reader.next() === ']') malformed();
                    }
                    await reader.expect(']');
                    if (await reader.next() === '}') break;
                    await reader.expect(',');
                    if (await reader.next() === '}') malformed();
                }
                await reader.expect('}');
            }
            if (await reader.next() === '}') break;
            await reader.expect(',');
            if (await reader.next() === '}') malformed();
        }
        await reader.expect('}');
        if (await reader.next() || usedTables.size !== tables.size || header.format !== BACKUP_FORMAT || header.formatVersion !== 1 ||
            header.schemaVersion !== 1 || header.normalizationVersion !== 1 || !isObject(header.collection) ||
            typeof header.collection.name !== 'string' || !isObject(header.collection.trackerView) ||
            typeof header.collectionPublicId !== 'string' || !uuidPattern.test(header.collectionPublicId) ||
            ![header.contentRevision, header.exportedAt, header.collection.createdAt].every(Number.isSafeInteger)) malformed();
        const { collection, collectionPublicId, contentRevision, exportedAt } = header as unknown as Omit<BackupFile, 'records'>;
        return {
            total,
            header: { name: collection.name, trackerView: collection.trackerView, createdAt: collection.createdAt, collectionPublicId, contentRevision, exportedAt } as Header,
        };
    } finally {
        await reader.close().catch(() => undefined);
    }
}

export async function backupFileHash(file: File): Promise<string> {
    // Hash fixed-size byte slices, then hash their ordered digests to avoid buffering a large backup.
    const pieces = [];
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
        pieces.push(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.slice(offset, offset + 1024 * 1024).arrayBuffer())));
    }
    const joined = new Uint8Array(pieces.length * 32);
    pieces.forEach((piece, index) => joined.set(piece, index * 32));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function applyBackup(
    client: ConvexClient, file: File, summary: Awaited<ReturnType<typeof inspectBackup>>,
    restoreKey: string, fileHash: string,
    onState: (message: string, collectionId: Id<'collections'>) => void,
) {
    let state = await client.mutation(api.backups.beginRestore, {
        restoreKey, fileHash, header: summary.header, expectedCount: summary.total,
    });
    const collectionId = state.collectionId;
    onState('Preparing the private collection…', collectionId);
    if (state.state === 'discarding') throw new Error('Discard this interrupted restore before starting again.');
    if (state.state === 'uploading') {
        let pending: Row[] = [];
        let bytes = 0;
        let start = 0;
        const flush = async () => {
            if (!pending.length) return;
            state = await client.mutation(api.backups.uploadPage, { collectionId, offset: start, rows: pending });
            onState('Uploaded ' + state.receivedCount.toLocaleString() + ' of ' + state.expectedCount.toLocaleString() + ' records…', collectionId);
            pending = [];
            bytes = 0;
        };
        await inspectBackup(file, async (row, offset) => {
            if (offset < state.receivedCount) return;
            const size = encoder.encode(JSON.stringify(row)).length;
            if (pending.length && (bytes + size > maxChunkBytes || pending.length === 25)) await flush();
            if (offset < state.receivedCount) return;
            if (!pending.length) start = offset;
            pending.push(row);
            bytes += size;
        });
        await flush();
    }
    while (state.state !== 'complete') {
        state = await client.mutation(api.backups.advanceRestore, { collectionId });
        const activity = state.state === 'inserting' ? 'Restoring records' :
            state.state === 'linking' ? 'Reconnecting history' : 'Validating restored homes';
        onState(activity + '…', collectionId);
    }
    return collectionId;
}

export async function discardBackup(client: ConvexClient, collectionId: Id<'collections'>) {
    while (!await client.mutation(api.backups.discardRestore, { collectionId })) { /* bounded server pages */ }
}

async function readPages(
    client: ConvexClient, collectionId: Id<'collections'>, header: Header, table: BackupTable,
    onPage: (page: PortableRecord[]) => void,
) {
    let cursor: string | null = null;
    let done = false;
    while (!done) {
        const page: { rows: unknown[]; cursor: string; done: boolean } = await client.query(api.backups.exportPage, {
            collectionId, contentRevision: header.contentRevision, table, cursor,
        });
        onPage(page.rows as PortableRecord[]);
        cursor = page.cursor;
        done = page.done;
    }
}

async function verifySnapshot(client: ConvexClient, collectionId: Id<'collections'>, header: Header) {
    const end = await client.query(api.backups.exportHeader, { collectionId });
    if (end.contentRevision !== header.contentRevision) throw new Error('The collection changed during export. Download a fresh copy.');
}

export async function exportBackup(client: ConvexClient, collectionId: Id<'collections'>, onTable: (table: string) => void) {
    const header = await client.query(api.backups.exportHeader, { collectionId });
    const { name, trackerView, createdAt, collectionPublicId, contentRevision, exportedAt } = header;
    const envelope = {
        format: BACKUP_FORMAT, formatVersion: 1, schemaVersion: 1, normalizationVersion: 1,
        exportedAt, collectionPublicId, contentRevision, collection: { name, trackerView, createdAt },
    };
    const pieces = [JSON.stringify(envelope).slice(0, -1), ',\n"records":{\n'];
    for (const [index, table] of BACKUP_TABLES.entries()) {
        onTable(table);
        pieces.push(index ? ',\n' : '', JSON.stringify(table) + ':[\n');
        let first = true;
        await readPages(client, collectionId, header, table, page => {
            for (const row of page) {
                if (!first) pieces.push(',\n');
                pieces.push(JSON.stringify(row));
                first = false;
            }
        });
        pieces.push('\n]');
    }
    await verifySnapshot(client, collectionId, header);
    pieces.push('\n}}\n');
    return new Blob(pieces, { type: 'application/json' });
}

export const csvPublicColumns = [
    ['url', 'Listing URL'], ['portal', 'Source portal'], ['externalListingId', 'Listing ID'],
    ['ask', 'Asking price (SGD)'], ['observedAt', 'Asking observed date'], ['area', 'Area (sqm)'],
    ['type', 'Flat type'], ['floor', 'Floor'], ['model', 'Flat model'],
    ['completionYear', 'Completion year'], ['leaseYear', 'Lease commencement year'], ['availability', 'Availability'],
] as const;
export const csvPrivateColumns = [
    ['address', 'Full address and postal code'], ['unit', 'Unit number'],
    ['contacts', 'Agent contacts (JSON)'], ['progress', 'Progress'], ['shortlisted', 'Shortlisted'],
    ['viewing', 'Next viewing'], ['lastContact', 'Last contact'],
    ['notes', 'Private notes (JSON)'], ['comparison', 'Comparison attachments (JSON)'],
    ['custom', 'Custom values (JSON)'],
] as const;

const object = (value: unknown) => isObject(value) ? value : {};
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
const iso = (time: unknown) => typeof time === 'number' ? new Date(time).toISOString() : undefined;
const structured = (items: unknown[]) => items.length ? JSON.stringify(items) : undefined;

export async function exportCsv(client: ConvexClient, collectionId: Id<'collections'>, columns: Set<string>) {
    const header = await client.query(api.backups.exportHeader, { collectionId });
    const data = new Map<BackupTable, PortableRecord[]>();
    const requested = new Set<BackupTable>(['candidates', 'sourceListings']);
    if (columns.has('contacts')) requested.add('contacts');
    if (columns.has('notes') || columns.has('comparison')) requested.add('notes');
    if (columns.has('custom')) requested.add('customFields');
    for (const table of requested) {
        const rows: PortableRecord[] = [];
        await readPages(client, collectionId, header, table, page => { rows.push(...page); });
        data.set(table, rows);
    }
    await verifySnapshot(client, collectionId, header);
    const bySource = new Map(data.get('sourceListings')?.map(row => [row.publicId, row]));
    const firstSource = new Map<string, PortableRecord>();
    for (const source of data.get('sourceListings') ?? []) {
        if (typeof source.candidateId === 'string' && !firstSource.has(source.candidateId)) firstSource.set(source.candidateId, source);
    }
    const group = (table: BackupTable, selected: (row: PortableRecord) => boolean) => {
        const index = new Map<string, PortableRecord[]>();
        for (const row of data.get(table) ?? []) {
            if (!selected(row) || typeof row.candidateId !== 'string') continue;
            const list = index.get(row.candidateId) ?? [];
            list.push(row);
            index.set(row.candidateId, list);
        }
        return index;
    };
    const contacts = group('contacts', row => row.state === 'active');
    const notes = group('notes', row => row.state === 'active');
    const fields = new Map(data.get('customFields')?.map(row => [row.publicId, row]));
    const selected = [...csvPublicColumns, ...csvPrivateColumns].filter(([id]) => columns.has(id));
    const lines = [selected.map(([, label]) => csvCell(label)).join(',')];
    for (const candidate of data.get('candidates') ?? []) {
        if (candidate.recordState !== 'active') continue;
        const source = bySource.get(String(candidate.preferredSourceListingId)) ?? firstSource.get(candidate.publicId);
        const current = object(source?.current);
        const override = object(candidate.buyerFacts);
        const fact = (key: string) => key in override ? object(override[key]).value : object(current[key]).value;
        const floor = object(fact('floor'));
        const location = object(candidate.location);
        const asking = object(current.askingPriceCents);
        const associatedNotes = notes.get(candidate.publicId) ?? [];
        const values: Record<string, unknown> = {
            url: source?.url, portal: source?.portalDisplayName ?? source?.portal, externalListingId: source?.externalListingId,
            ask: typeof asking.value === 'number' ? asking.value / 100 : undefined,
            observedAt: iso(asking.observedAt), area: object(fact('area')).sqm, type: fact('flatType'),
            floor: floor.kind === 'range' ? String(floor.min) + '–' + String(floor.max) : floor.value,
            model: fact('flatModel'), completionYear: fact('completionYear'), leaseYear: fact('leaseCommencementYear'),
            availability: object(source?.availability).value,
            address: [location.rawAddress, location.postalCode].filter(Boolean).join(' · '), unit: location.unitNumber,
            progress: candidate.progress, shortlisted: candidate.shortlisted ? 'Yes' : 'No',
            viewing: iso(candidate.nextViewingAt), lastContact: iso(candidate.lastContactAt),
            contacts: structured((contacts.get(candidate.publicId) ?? []).map(row => ({
                name: row.name, phone: row.phoneRaw ?? row.phoneE164, agency: row.agency, whatsapp: row.whatsappE164,
            }))),
            notes: structured(associatedNotes.map(row => ({ kind: row.kind, body: row.body, occurredAt: iso(row.occurredAt) }))),
            comparison: structured(associatedNotes.map(row => row.comparisonContext).filter(Boolean)),
            custom: structured((Array.isArray(candidate.customValues) ? candidate.customValues : []).map(object).map(value => {
                const field = fields.get(String(value.fieldId));
                const option = Array.isArray(field?.options) ? field.options.map(object).find(option => option.id === value.optionId) : undefined;
                return { field: field?.label ?? value.fieldId, value: option?.label ?? value.value };
            })),
        };
        lines.push(selected.map(([id]) => csvCell(scalar(values[id]))).join(','));
    }
    return new Blob(['\uFEFF', lines.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' });
}

export function downloadFile(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
