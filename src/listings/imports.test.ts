import { expect, test } from 'vitest';
import { isPrivateField, normalizeRow } from './imports';

const mapping = { URL: 'url', Star: 'shortlisted', Stage: 'progress' };
const url = 'https://example.test/listing/shortlist';

test('an explicit false clears the shortlist while a blank cell omits the flag', () => {
    expect(isPrivateField('shortlisted')).toBe(true);
    const csv = normalizeRow({ URL: url, Star: 'No' }, mapping, '', []);
    expect(csv.issues).toEqual([]);
    expect(csv.row.buyerPatch).toMatchObject({ shortlisted: false });

    const json = normalizeRow({ URL: url, Star: false, Stage: 'Offer submitted' }, mapping, '', []);
    expect(json.issues).toEqual([]);
    expect(json.row.buyerPatch).toMatchObject({ progress: 'offer_submitted', shortlisted: false });

    const blank = normalizeRow({ URL: url, Star: '' }, mapping, '', []);
    expect(blank.issues).toEqual([]);
    expect(blank.row.buyerPatch).toBeUndefined();
});
