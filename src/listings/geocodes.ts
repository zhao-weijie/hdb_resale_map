import { isValidCoordinate, type Coordinate } from '../spatial/selection';
import { PostalSearch } from '../tools/PostalSearch';

export interface BlockLookup extends Coordinate {
    postalCode: string;
    block: string;
    streetName: string;
    address: string;
    method: 'dataset' | 'onemap';
    version: string;
}

type Block = Omit<BlockLookup, 'method' | 'version'>;
type DictionaryEntry = Coordinate & { block: string; street_name: string; postal: string; address: string };

let dictionaryPromise: Promise<Map<string, BlockLookup[]>> | undefined;
const postalCache = new Map<string, Promise<BlockLookup | null>>();

export async function sha256(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getDictionary(): Promise<Map<string, BlockLookup[]>> {
    dictionaryPromise ??= (async () => {
        const response = await fetch('data/addresses_geocoded.json', { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('The public block lookup is unavailable.');
        const content = await response.text();
        const version = `dictionary:${await sha256(content)}`;
        const blocks = new Map<string, BlockLookup[]>();
        for (const entry of Object.values(JSON.parse(content) as Record<string, DictionaryEntry>)) {
            if (!/^\d{6}$/.test(entry.postal) || !entry.block || !entry.street_name || !isValidCoordinate(entry)) continue;
            const block: BlockLookup = {
                postalCode: entry.postal,
                block: entry.block,
                streetName: entry.street_name,
                address: entry.address,
                latitude: entry.latitude,
                longitude: entry.longitude,
                method: 'dataset',
                version,
            };
            const matches = blocks.get(entry.postal) ?? [];
            if (!matches.some((existing) => sameBlock(existing, block))) matches.push(block);
            blocks.set(entry.postal, matches);
        }
        return blocks;
    })().catch((error) => {
        dictionaryPromise = undefined;
        throw error;
    });
    return dictionaryPromise;
}

function sameBlock(a: Block, b: Block): boolean {
    return a.block === b.block && a.streetName.toUpperCase() === b.streetName.toUpperCase()
        && a.latitude === b.latitude && a.longitude === b.longitude;
}

async function resolvePostal(postalCode: string): Promise<BlockLookup | null> {
    const matches = (await getDictionary()).get(postalCode);
    if (matches?.length) return matches.length === 1 ? matches[0] : null;

    const results = await PostalSearch.exactPostal(postalCode);
    const blocks: Block[] = [];
    for (const result of results) {
        const block = {
            postalCode,
            block: result.BLK_NO.trim(),
            streetName: result.ROAD_NAME.trim(),
            address: result.ADDRESS.trim(),
            latitude: Number(result.LATITUDE),
            longitude: Number(result.LONGITUDE),
        };
        if (!block.block || block.block === 'NIL' || !block.streetName || block.streetName === 'NIL'
            || !result.LATITUDE.trim() || !result.LONGITUDE.trim() || !isValidCoordinate(block)) continue;
        if (!blocks.some((existing) => sameBlock(existing, block))) blocks.push(block);
    }
    if (blocks.length !== 1) return null;
    const block = blocks[0];
    return { ...block, method: 'onemap', version: `onemap:${await sha256(JSON.stringify(block))}` };
}

export function lookupPostal(postalCode: string, retry = false): Promise<BlockLookup | null> {
    if (!/^\d{6}$/.test(postalCode)) return Promise.resolve(null);
    if (retry) postalCache.delete(postalCode);
    let cached = postalCache.get(postalCode);
    if (!cached) {
        cached = resolvePostal(postalCode).catch((error) => {
            if (postalCache.get(postalCode) === cached) postalCache.delete(postalCode);
            throw error;
        });
        postalCache.set(postalCode, cached);
    }
    return cached;
}

export function addressWithUnit(address?: string | null, unit?: string | null): string {
    if (!address) return unit ?? '';
    if (!unit) return address;
    const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, '').replace(/#/g, '');
    return normalize(address).includes(normalize(unit)) ? address : `${address} ${unit}`;
}
