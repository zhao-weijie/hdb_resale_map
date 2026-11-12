/**
 * PostalSearch - Helper to search postal codes using OneMap API
 */

export interface StartResult {
    SEARCHVAL: string;
    BLK_NO: string;
    ROAD_NAME: string;
    BUILDING: string;
    ADDRESS: string;
    POSTAL: string;
    X: string;
    Y: string;
    LATITUDE: string;
    LONGITUDE: string;
}

export class PostalSearch {
    private static API_URL = 'https://www.onemap.gov.sg/api/common/elastic/search';

    private static async request(query: string, page: number): Promise<{ results: StartResult[]; totalNumPages?: number }> {
        const url = new URL(this.API_URL);
        url.searchParams.set('searchVal', query);
        url.searchParams.set('returnGeom', 'Y');
        url.searchParams.set('getAddrDetails', 'Y');
        url.searchParams.set('pageNum', String(page));
        const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`OneMap lookup is unavailable (${response.status}).`);
        const data = await response.json();
        if (!Array.isArray(data.results)) throw new Error('OneMap did not return address results.');
        return data;
    }

    static async exactPostal(postalCode: string): Promise<StartResult[]> {
        const first = await this.request(postalCode, 1);
        const results = [...first.results];
        const pages = first.totalNumPages ?? 1;
        if (!Number.isInteger(pages) || pages > 10) throw new Error('OneMap returned too many postal matches.');
        for (let page = 2; page <= pages; page += 1) results.push(...(await this.request(postalCode, page)).results);
        return results.filter((result) => result.POSTAL === postalCode);
    }

    /**
     * Search for a postal code or address
     * @param query Postal code (e.g. "123456") or address string
     * @returns Promise<StartResult | null> The first/best match or null
     */
    static async search(query: string): Promise<StartResult | null> {
        if (!query || query.length < 3) return null;

        try {
            return (await this.request(query, 1)).results[0] ?? null;
        } catch (error) {
            console.error('OneMap API Search Error:', error);
            return null;
        }
    }
}
