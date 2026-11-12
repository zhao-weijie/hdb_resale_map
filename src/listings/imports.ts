import { progressLabels } from './progress';

type Cell = string | number | boolean | null;
type ImportIssue = { field: string; message: string };

export const IMPORT_LIMIT = 1_000;
export const IMPORT_BYTES = 10 * 1024 * 1024;
export const BACKUP_FORMAT = 'hdb-listing-tracker';
export const BACKUP_TABLES = [
    'customFields', 'candidates', 'sourceListings', 'sourceIdentities', 'importRuns',
    'sourceObservations', 'contacts', 'notes', 'importItems', 'changeEvents',
] as const;
export type BackupTable = typeof BACKUP_TABLES[number];
export type PortableRecord = { publicId: string; [key: string]: unknown };
export type BackupFile = {
    format: typeof BACKUP_FORMAT;
    formatVersion: 1;
    exportedAt: number;
    collectionPublicId: string;
    contentRevision: number;
    schemaVersion: 1;
    normalizationVersion: 1;
    collection: { name: string; trackerView: unknown; createdAt: number };
    records: Record<BackupTable, PortableRecord[]>;
};

export type TrackerFile = {
    format: 'csv' | 'json_tracker';
    columns: string[];
    rows: { number: number; line?: number; cells: Record<string, Cell> }[];
};

export const fields = [
    ['url', 'Listing URL'], ['portal', 'Source portal'], ['externalListingId', 'Listing ID'],
    ['trackerRowKey', 'Stable tracker row ID'], ['title', 'Home label'],
    ['rawAddress', 'Full address'], ['postalCode', 'Postal code'], ['unitNumber', 'Unit number'],
    ['askingPrice', 'Asking price (SGD)'], ['askingPriceCents', 'Asking price (SGD cents)'], ['observedAt', 'Observed date or time'],
    ['flatType', 'Flat type'], ['area', 'Area'], ['areaUnit', 'Area unit'], ['floor', 'Floor or range'],
    ['flatModel', 'Flat model'], ['completionYear', 'Completion year'],
    ['leaseCommencementYear', 'Lease commencement year'], ['availability', 'Availability'],
    ['description', 'Description'], ['contactName', 'Agent name'], ['phoneRaw', 'Agent phone number'],
    ['agency', 'Agency'], ['whatsappE164', 'WhatsApp (international number)'],
    ['progress', 'Private progress'], ['shortlisted', 'Private shortlist'], ['note', 'New private note'],
] as const;
export const areaUnits = ['sqm', 'sqft'] as const;
export type AreaUnit = typeof areaUnits[number];
export type CustomField = {
    publicId: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'checkbox' | 'single_select';
    options: { id: string; label: string; archived: boolean }[];
    state: string;
};

const aliases: Record<string, string[]> = {
    url: ['url', 'listing url', 'source url', 'link', 'listing link', 'source.url'],
    portal: ['portal', 'source', 'source portal', 'source.portal'],
    externalListingId: ['listing id', 'external listing id', 'externalListingId', 'source.externalListingId'],
    trackerRowKey: ['tracker row id', 'stable tracker row id', 'row id', 'trackerRowKey', 'source.trackerRowKey'],
    title: ['title', 'home label'],
    rawAddress: ['address', 'full address', 'rawAddress', 'source.facts.rawAddress', 'facts.rawAddress', 'location.rawAddress'],
    postalCode: ['postal code', 'postal', 'postcode', 'postalCode', 'source.facts.postalCode', 'facts.postalCode', 'location.postalCode'],
    unitNumber: ['unit', 'unit number', 'floor/unit', 'unitNumber', 'source.facts.unitNumber', 'facts.unitNumber', 'location.unitNumber'],
    askingPrice: ['price', 'asking price', 'asking price (SGD)', 'price (SGD)', 'askingPrice'],
    askingPriceCents: ['askingPriceCents', 'source.facts.askingPriceCents', 'facts.askingPriceCents'],
    observedAt: ['observed', 'observed date', 'asking observed date', 'observed date or time', 'observed at', 'observedAt', 'source.observedAt'],
    flatType: ['flat type', 'room type', 'flatType', 'source.facts.flatType', 'facts.flatType'],
    area: ['area', 'area (sqm)', 'area (sqft)', 'area (m²)', 'area (ft²)', 'size', 'size (sqft)', 'floor area', 'source.facts.area.originalValue', 'facts.area.originalValue'],
    areaUnit: ['area unit', 'areaUnit', 'source.facts.area.originalUnit', 'facts.area.originalUnit'],
    floor: ['floor', 'floor range', 'storey', 'source.facts.floor.value', 'facts.floor.value'],
    flatModel: ['flat model', 'model', 'flatModel', 'source.facts.flatModel', 'facts.flatModel'],
    completionYear: ['completion year', 'year built', 'completionYear', 'source.facts.completionYear', 'facts.completionYear'],
    leaseCommencementYear: ['lease commencement', 'lease commencement year', 'lease start', 'leaseCommencementYear', 'source.facts.leaseCommencementYear', 'facts.leaseCommencementYear'],
    availability: ['availability', 'source.facts.availability', 'facts.availability'],
    description: ['description', 'listing description', 'source.description'],
    contactName: ['agent', 'agent name', 'contact name', 'contactName'],
    phoneRaw: ['phone', 'phone number', 'agent phone', 'agent phone number', 'phoneRaw'],
    agency: ['agency'],
    whatsappE164: ['whatsapp', 'whatsapp number', 'whatsappE164'],
};
const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9²]+/g, '');
const blank = (value: Cell | undefined) => value === undefined || value === null || (typeof value === 'string' && !value.trim());
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const privateFields = new Set(['shortlisted', 'progress', 'note']);
export const isPrivateField = (field: string) => privateFields.has(field) || field.startsWith('custom.');
export function suggestMapping(columns: string[]): Record<string, string> {
    const mapping: Record<string, string> = {};
    const used = new Set<string>();
    for (const column of columns) {
        const name = normalizeName(column);
        const match = Object.entries(aliases).find(([, candidates]) => candidates.some(alias => normalizeName(alias) === name));
        if (!match || used.has(match[0])) continue;
        mapping[column] = match[0];
        used.add(match[0]);
    }
    return mapping;
}

function csvRecords(input: string): { number: number; cells: string[] }[] {
    const rows: { number: number; cells: string[] }[] = [];
    let cells: string[] = [];
    let cell = '';
    let line = 1;
    let rowLine = 1;
    let quoted = false;
    let closed = false;
    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        if (quoted) {
            if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
            else if (char === '"') { quoted = false; closed = true; }
            else {
                if (char === '\n' || (char === '\r' && input[index + 1] !== '\n')) line++;
                cell += char;
            }
            continue;
        }
        if (char === ',' || char === '\r' || char === '\n') {
            cells.push(cell);
            cell = '';
            closed = false;
            if (char !== ',') {
                if (char === '\r' && input[index + 1] === '\n') index++;
                if (cells.some(value => value.trim())) rows.push({ number: rowLine, cells });
                if (rows.length > IMPORT_LIMIT + 1) throw new Error('Choose a CSV with at most 1,000 listing rows.');
                cells = [];
                rowLine = ++line;
            }
        } else if (closed || (char === '"' && cell !== '')) {
            throw new Error('Unexpected quote or text after a quoted cell on CSV line ' + line + '.');
        } else if (char === '"') {
            quoted = true;
        } else {
            cell += char;
        }
    }
    if (quoted) throw new Error('Close the quoted cell starting on CSV line ' + rowLine + '.');
    cells.push(cell);
    if (cells.some(value => value.trim())) rows.push({ number: rowLine, cells });
    return rows;
}

function flatten(value: Record<string, unknown>, target: Record<string, Cell>, path = '', depth = 0): void {
    if (depth > 8) throw new Error('A JSON listing is nested too deeply to map.');
    for (const [key, cell] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('This JSON contains a reserved column name.');
        const column = path ? path + '.' + key : key;
        if (record(cell)) flatten(cell, target, column, depth + 1);
        else if (cell === null || ['number', 'string', 'boolean'].includes(typeof cell)) target[column] = cell as Cell;
    }
}

export function readTrackerFile(input: string, format: TrackerFile['format']): TrackerFile {
    input = input.replace(/^\uFEFF/, '');
    if (new TextEncoder().encode(input).length > IMPORT_BYTES) throw new Error('Choose a listing file up to 10 MiB.');
    let columns: string[];
    let rows: TrackerFile['rows'];
    if (format === 'csv') {
        const parsed = csvRecords(input);
        if (!parsed.length) throw new Error('The CSV has no header row.');
        columns = parsed[0].cells.map(header => header.trim());
        if (new Set(columns).size !== columns.length || columns.some(header => !header || ['__proto__', 'prototype', 'constructor'].includes(header))) {
            throw new Error('Give every CSV column a distinct, non-empty name.');
        }
        rows = parsed.slice(1).map(({ cells, number: line }, index) => {
            if (cells.length !== columns.length) throw new Error('CSV line ' + line + ' has a different number of cells from the header.');
            return { number: index + 2, line, cells: Object.fromEntries(columns.map((header, index) => [header, cells[index]])) };
        });
    } else {
        const parsed: unknown = JSON.parse(input);
        const data = record(parsed) ? parsed.listings ?? parsed.rows : parsed;
        if (!Array.isArray(data)) throw new Error('Use a JSON array of listing objects, or a JSON file with a listings array.');
        if (data.length > IMPORT_LIMIT) throw new Error('Choose a JSON file with at most 1,000 listing rows.');
        rows = data.map((value, index) => {
            if (!record(value)) throw new Error('JSON row ' + (index + 1) + ' must be an object.');
            const cells: Record<string, Cell> = Object.create(null);
            flatten(value, cells);
            return { number: index + 1, cells };
        });
        columns = [...new Set(rows.flatMap(row => Object.keys(row.cells)))];
    }
    if (!rows.length || !columns.length) throw new Error('The file has no listing rows.');
    if (rows.length > IMPORT_LIMIT) throw new Error('Choose a file with at most 1,000 listing rows.');
    if (columns.length > 100 || columns.some(column => column.length > 120)) throw new Error('Use up to 100 columns with names up to 120 characters.');
    return { columns, rows, format };
}

function numberCell(input: string): number | undefined {
    const value = input.trim().replace(/\u2212/g, '-');
    if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?:[\u00a0\u202f ]\d{3})+)(?:\.\d+)?$/.test(value)) return undefined;
    const parsed = Number(value.replace(/[,\u00a0\u202f ]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
}

function areaUnit(input: string): AreaUnit | undefined {
    const value = input.trim().toLowerCase().replace(/[\s.^]/g, '').replace('²', '2');
    if (['sqm', 'm2', 'squaremetres', 'squaremeters'].includes(value)) return 'sqm';
    if (['sqft', 'ft2', 'squarefeet', 'sf'].includes(value)) return 'sqft';
}

function dateOnly(value: string): boolean {
    const timestamp = Date.parse(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString().slice(0, 10) === value;
}

function observationTime(value: string): number | undefined {
    if (dateOnly(value)) return Date.parse(value + 'T00:00:00+08:00');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && dateOnly(value.slice(0, 10))) {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) return timestamp;
    }
    if (/^\d{12,13}$/.test(value)) return Number(value);
}

const progressValues = Object.keys(progressLabels) as Array<keyof typeof progressLabels>;
const availabilityValues = ['active_as_observed', 'no_longer_observed', 'confirmed_unavailable', 'unknown'] as const;
const flatTypes = ['1 ROOM', '2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'] as const;
type CustomValue = { fieldId: string } & (
    { type: 'text' | 'date'; value: string } | { type: 'number'; value: number } |
    { type: 'checkbox'; value: boolean } | { type: 'single_select'; optionId: string }
);
type SourceFacts = {
    rawAddress?: string; postalCode?: string; unitNumber?: string; askingPriceCents?: number;
    area?: { sqm: number; originalValue: number; originalUnit: AreaUnit };
    floor?: { kind: 'exact'; value: number } | { kind: 'range'; min: number; max: number };
    flatType?: typeof flatTypes[number]; flatTypeRaw?: string; flatModel?: string; completionYear?: number; leaseCommencementYear?: number;
    availability?: typeof availabilityValues[number];
};
export type NormalizedRow = {
    title?: string;
    source: {
        url?: string; portal?: string; externalListingId?: string; trackerRowKey?: string;
        observedAt?: number; facts: SourceFacts; description?: string;
        contacts?: [{ name?: string; phoneRaw?: string; agency?: string; whatsappE164?: string }];
        acceptUndatedAsCurrent?: boolean;
    };
    buyerPatch?: { progress?: keyof typeof progressLabels; shortlisted?: boolean; customValues?: CustomValue[] };
    note?: { body: string };
};
export function normalizeRow(
    cells: Record<string, Cell>, mapping: Record<string, string>, fallbackUnit: AreaUnit | '',
    customFields: CustomField[],
): { row: NormalizedRow; issues: ImportIssue[] } {
    const input = Object.fromEntries(Object.entries(mapping).filter(([, field]) => field)
        .map(([column, field]) => [field, cells[column]]));
    const get = (field: string) => blank(input[field]) ? undefined : String(input[field]).trim();
    const issues: ImportIssue[] = [];
    const issue = (field: string, message: string) => { issues.push({ field, message }); };
    const booleanValue = (field: string) => {
        const value = get(field);
        if (!value) return undefined;
        if (/^(true|yes|1)$/i.test(value)) return true;
        if (/^(false|no|0)$/i.test(value)) return false;
        issue(field, 'Use Yes or No.');
        return undefined;
    };
    const text = (field: string, limit: number, preserve = false) => {
        const value = get(field);
        const result = preserve && value ? String(input[field]) : value;
        if (result && result.length > limit) issue(field, 'Use at most ' + limit.toLocaleString('en-SG') + ' characters.');
        return result;
    };
    const facts: SourceFacts = {};
    const row: NormalizedRow = { source: { facts } };
    const { source } = row;
    row.title = text('title', 120);
    source.url = text('url', 2048);
    if (source.url) {
        try {
            const url = new URL(source.url);
            if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
        } catch { issue('url', 'Enter a valid HTTP(S) listing URL.'); }
    }
    source.portal = text('portal', 120);
    source.externalListingId = text('externalListingId', 240);
    source.trackerRowKey = text('trackerRowKey', 240);
    if (!source.url && !source.trackerRowKey && !(source.portal && source.externalListingId)) {
        issue('url', 'Enter a listing URL, or identify an existing listing by its portal and ID or stable tracker row ID.');
    }
    facts.rawAddress = text('rawAddress', 500);
    facts.unitNumber = text('unitNumber', 60);
    const postal = get('postalCode');
    if (postal) {
        if (/^\d{6}$/.test(postal)) facts.postalCode = postal;
        else issue('postalCode', 'Use six digits, including leading zeroes.');
    }
    const rawCents = get('askingPriceCents');
    const ask = get('askingPrice');
    if (ask) {
        const value = numberCell(ask.replace(/^(?:SGD\s*\$?|S\$|\$)\s*/i, ''));
        const cents = value === undefined ? NaN : Math.round(value * 100);
        if (!Number.isSafeInteger(cents) || cents <= 0) issue('askingPrice', 'Enter a positive SGD amount such as S$680,000.');
        else facts.askingPriceCents = cents;
    } else if (rawCents) {
        const cents = numberCell(rawCents);
        if (cents === undefined || !Number.isSafeInteger(cents) || cents <= 0) issue('askingPriceCents', 'Enter a positive whole number of SGD cents.');
        else facts.askingPriceCents = cents;
    }
    const area = get('area');
    if (area) {
        const pieces = /^([+\-]?[\d,.\s\u00a0\u202f]+)\s*(.*)$/.exec(area);
        const originalValue = pieces && numberCell(pieces[1]);
        const explicit = get('areaUnit');
        const column = Object.entries(mapping).find(([, field]) => field === 'area')?.[0];
        const unitInHeader = column?.match(/\(([^)]+)\)$/)?.[1];
        const reportedUnit = pieces?.[2] || explicit;
        const originalUnit = reportedUnit ? areaUnit(reportedUnit) : (unitInHeader && areaUnit(unitInHeader)) || fallbackUnit;
        if (!originalValue || originalValue <= 0) issue('area', 'Enter a positive area such as 91 m² or 980 sqft.');
        else if (!originalUnit) issue('areaUnit', 'Choose square metres or square feet for this area.');
        else if (pieces?.[2] && explicit && areaUnit(explicit) !== originalUnit) issue('areaUnit', 'The cell and its area unit column disagree.');
        else facts.area = { sqm: originalUnit === 'sqft' ? originalValue / 10.7639104167 : originalValue, originalValue, originalUnit };
    }
    const floor = get('floor');
    if (floor) {
        const match = /^(\d{1,3})(?:\s*(?:-|–|—|to)\s*(\d{1,3}))?$/i.exec(floor);
        if (!match || Number(match[1]) < 1 || (match[2] && Number(match[2]) < Number(match[1]))) {
            issue('floor', 'Enter an exact floor or a range such as 07–09.');
        } else {
            facts.floor = match[2] ? { kind: 'range', min: Number(match[1]), max: Number(match[2]) } : { kind: 'exact', value: Number(match[1]) };
        }
    }
    const flatType = get('flatType');
    if (flatType) {
        const normalized = flatType.toUpperCase().replace(/\s*-\s*(?=ROOM)/, ' ').replace(/\s+ROOMS$/, ' ROOM');
        facts.flatType = flatTypes.find(type => type === normalized);
        if (!facts.flatType) facts.flatTypeRaw = text('flatType', 120);
    }
    facts.flatModel = text('flatModel', 120);
    for (const field of ['completionYear', 'leaseCommencementYear'] as const) {
        const value = get(field);
        if (!value) continue;
        if (!/^\d{4}$/.test(value) || Number(value) < 1800 || Number(value) > 2200) issue(field, 'Enter a four-digit year.');
        else facts[field] = Number(value);
    }
    const choice = <T extends string>(field: string, choices: readonly T[]): T | undefined => {
        const value = get(field);
        if (!value) return undefined;
        const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
        const found = choices.find(option => option === normalized);
        if (!found) issue(field, 'Choose one of ' + choices.map(option => option.replace(/_/g, ' ')).join(', ') + '.');
        return found;
    };
    facts.availability = choice('availability', availabilityValues);
    const observed = get('observedAt');
    if (observed) {
        source.observedAt = observationTime(observed);
        if (source.observedAt === undefined) issue('observedAt', 'Use YYYY-MM-DD (Singapore time) or an ISO timestamp with its time zone.');
    }
    source.description = text('description', 30_000, true);
    const contact = {
        name: text('contactName', 120),
        phoneRaw: text('phoneRaw', 80),
        agency: text('agency', 120),
        whatsappE164: text('whatsappE164', 18),
    };
    if (contact.whatsappE164 && !/^\+[1-9]\d{6,14}$/.test(contact.whatsappE164)) issue('whatsappE164', 'Include the country code, for example +6591234567.');
    if (Object.values(contact).some(Boolean)) source.contacts = [contact];
    const progress = choice('progress', progressValues);
    const shortlisted = booleanValue('shortlisted');
    const customValues: CustomValue[] = [];
    for (const field of customFields) {
        const key = 'custom.' + field.publicId;
        const value = get(key);
        if (!value) continue;
        const fieldId = field.publicId;
        switch (field.type) {
            case 'text': {
                const original = text(key, 2000, true);
                if (original) customValues.push({ fieldId, type: 'text', value: original });
                break;
            }
            case 'number': {
                const numeric = numberCell(value);
                if (numeric === undefined) issue(key, 'Enter a number.');
                else customValues.push({ fieldId, type: 'number', value: numeric });
                break;
            }
            case 'date':
                if (dateOnly(value)) customValues.push({ fieldId, type: 'date', value });
                else issue(key, 'Use YYYY-MM-DD.');
                break;
            case 'checkbox': {
                const checked = booleanValue(key);
                if (checked !== undefined) customValues.push({ fieldId, type: 'checkbox', value: checked });
                break;
            }
            case 'single_select': {
                const options = field.options.filter(option => !option.archived && (option.id === value || option.label.toLowerCase() === value.toLowerCase()));
                if (options.length === 1) customValues.push({ fieldId, type: 'single_select', optionId: options[0].id });
                else issue(key, 'Enter a unique active option label.');
            }
        }
    }
    if (progress || shortlisted !== undefined || customValues.length) row.buyerPatch = { progress, shortlisted, customValues };
    const note = text('note', 10_000, true);
    if (note) row.note = { body: note };
    // The same serialized shape is used for preview, retries and the Convex wire.
    return { row: JSON.parse(JSON.stringify(row)) as NormalizedRow, issues };
}

export async function hashFile(file: File): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function csvCell(value: string | number | boolean | null | undefined): string {
    let text = String(value ?? '');
    if (typeof value === 'string' && (/^[\t\r\n]/.test(text) || /^\s*[=+\-@]/u.test(text))) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
