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

    /**
     * Search for a postal code or address
     * @param query Postal code (e.g. "123456") or address string
     * @returns Promise<StartResult | null> The first/best match or null
     */
    static async search(query: string): Promise<StartResult | null> {
        if (!query || query.length < 3) return null;

        try {
            const url = new URL(this.API_URL);
            url.searchParams.append('searchVal', query);
            url.searchParams.append('returnGeom', 'Y');
            url.searchParams.append('getAddrDetails', 'Y');
            url.searchParams.append('pageNum', '1');

            const response = await fetch(url.toString());
            const data = await response.json();

            if (data.found > 0 && data.results.length > 0) {
                return data.results[0]; // Return top result
            }
            return null;
        } catch (error) {
            console.error('OneMap API Search Error:', error);
            return null;
        }
    }
}
