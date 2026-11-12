import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import geocode_pipeline
from addressing import canonical_address_key


class FakeResponse:
    def __init__(self, results):
        self._results = results

    def raise_for_status(self):
        return None

    def json(self):
        return {'results': self._results}


class GeocodePipelineTests(unittest.TestCase):
    def test_address_key_contract_matches_shared_fixtures(self):
        fixtures = json.loads((Path(__file__).parent / 'address_key_fixtures.json').read_text(encoding='utf-8'))
        for fixture in fixtures:
            self.assertEqual(canonical_address_key(fixture['block'], fixture['street']), fixture['key'])

    def test_unchanged_cached_addresses_make_no_request(self):
        cache = {
            '123|TEST ROAD': {
                'block': '123', 'street_name': 'TEST ROAD', 'status': 'resolved',
                'latitude': 1.3, 'longitude': 103.8, 'postal': '120123',
            },
            '124|TEST ROAD': {
                'block': '124', 'street_name': 'TEST ROAD', 'status': 'not_found',
                'latitude': None, 'longitude': None, 'reason': 'no_results',
            },
        }
        with patch.object(geocode_pipeline, 'load_geocode_cache', return_value=cache), \
                patch.object(geocode_pipeline, 'get_onemap_token', return_value=None), \
                patch.object(geocode_pipeline, 'save_geocode_cache'), \
                patch.object(geocode_pipeline, 'geocode_address') as request:
            result = geocode_pipeline.geocode_addresses([('123', 'TEST ROAD'), ('124', 'TEST ROAD')])
        request.assert_not_called()
        self.assertEqual(result, cache)

    def test_cached_transient_failure_is_retried(self):
        cache = {
            '123|TEST ROAD': {
                'block': '123', 'street_name': 'TEST ROAD', 'status': 'transient_failure',
                'latitude': None, 'longitude': None, 'reason': 'timeout',
            },
        }
        resolved = {
            'block': '123', 'street_name': 'TEST ROAD', 'status': 'resolved',
            'latitude': 1.3, 'longitude': 103.8, 'postal': '120123',
        }
        with patch.object(geocode_pipeline, 'load_geocode_cache', return_value=cache), \
                patch.object(geocode_pipeline, 'get_onemap_token', return_value=None), \
                patch.object(geocode_pipeline, 'save_geocode_cache'), \
                patch.object(geocode_pipeline.time, 'sleep'), \
                patch.object(geocode_pipeline, 'geocode_address', return_value=resolved) as request:
            result = geocode_pipeline.geocode_addresses([('123', 'TEST ROAD')])
        request.assert_called_once_with('123', 'TEST ROAD', None)
        self.assertEqual(result['123|TEST ROAD']['status'], 'resolved')

    def test_cached_postal_mismatch_from_previous_run_is_retried(self):
        cache = {
            '157|TEST ROAD': {
                'block': '157', 'street_name': 'TEST ROAD', 'status': 'ambiguous',
                'latitude': None, 'longitude': None, 'reason': 'cached_postal_mismatch',
            },
        }
        resolved = {
            'block': '157', 'street_name': 'TEST ROAD', 'status': 'resolved',
            'latitude': 1.3, 'longitude': 103.8, 'postal': '521157',
        }
        with patch.object(geocode_pipeline, 'load_geocode_cache', return_value=cache), \
                patch.object(geocode_pipeline, 'get_onemap_token', return_value=None), \
                patch.object(geocode_pipeline, 'save_geocode_cache'), \
                patch.object(geocode_pipeline.time, 'sleep'), \
                patch.object(geocode_pipeline, 'geocode_address', return_value=resolved) as request:
            result = geocode_pipeline.geocode_addresses([('157', 'TEST ROAD')])
        request.assert_called_once_with('157', 'TEST ROAD', None)
        self.assertEqual(result['157|TEST ROAD']['status'], 'resolved')

    def test_postal_code_validation_handles_hdb_block_suffix_forms(self):
        self.assertTrue(geocode_pipeline.validate_postal_code('6', '560006'))
        self.assertTrue(geocode_pipeline.validate_postal_code('39', '120039'))
        self.assertTrue(geocode_pipeline.validate_postal_code('157', '521157'))
        self.assertTrue(geocode_pipeline.validate_postal_code('12A', '321012'))
        self.assertTrue(geocode_pipeline.validate_postal_code('1A', '085101'))
        self.assertTrue(geocode_pipeline.validate_postal_code('1', '591501'))
        self.assertTrue(geocode_pipeline.validate_postal_code('1001', '731001'))
        self.assertFalse(geocode_pipeline.validate_postal_code('157', '521158'))

    def test_legacy_registry_is_migrated_to_canonical_status_entries(self):
        legacy = {' 123 |Test  Road': {
            'block': ' 123 ', 'street_name': 'Test  Road', 'latitude': 1.3,
            'longitude': 103.8, 'postal': '120123',
        }}
        with tempfile.TemporaryDirectory() as directory:
            cache_file = Path(directory) / 'addresses.json'
            cache_file.write_text(json.dumps(legacy), encoding='utf-8')
            with patch.object(geocode_pipeline, 'CACHE_FILE', cache_file):
                cache = geocode_pipeline.load_geocode_cache()
        self.assertEqual(cache['123|TEST ROAD']['status'], 'resolved')

    def test_cached_errors_are_removed_even_without_new_lookups(self):
        cached_error = 'https://example.invalid/search?token=synthetic-secret'
        legacy = {
            '123|TEST ROAD': {
                'block': '123', 'street_name': 'TEST ROAD', 'latitude': 1.3,
                'longitude': 103.8, 'postal': '120123', 'address': '123 TEST ROAD',
            },
            '124|TEST ROAD': {
                'block': '124', 'street_name': 'TEST ROAD', 'latitude': None,
                'longitude': None, 'status': 'transient_failure',
                'reason': cached_error, 'error': cached_error,
                'unrecognized_metadata': {'request': cached_error},
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_file = Path(directory) / 'addresses.json'
            cache_file.write_text(json.dumps(legacy), encoding='utf-8')
            with patch.object(geocode_pipeline, 'CACHE_FILE', cache_file), \
                    patch.object(geocode_pipeline, 'get_onemap_token', return_value=None), \
                    patch.object(geocode_pipeline, 'geocode_address') as request, \
                    redirect_stdout(StringIO()) as output:
                result = geocode_pipeline.geocode_addresses([('123', 'TEST ROAD')])
            persisted = cache_file.read_text(encoding='utf-8')
        request.assert_not_called()
        self.assertNotIn('synthetic-secret', persisted)
        self.assertNotIn('synthetic-secret', output.getvalue())
        self.assertNotIn('unrecognized_metadata', persisted)
        self.assertEqual(json.loads(persisted), result)
        self.assertEqual(result['123|TEST ROAD']['address'], '123 TEST ROAD')
        self.assertEqual(result['124|TEST ROAD']['status'], 'transient_failure')

    def test_one_map_429_keeps_token_out_of_query_and_cache(self):
        token = 'synthetic-secret'
        response = geocode_pipeline.requests.Response()
        response.status_code = 429
        response.url = f'https://example.invalid/search?token={token}'
        with tempfile.TemporaryDirectory() as directory:
            cache_file = Path(directory) / 'addresses.json'
            with patch.object(geocode_pipeline, 'CACHE_FILE', cache_file), \
                    patch.object(geocode_pipeline, 'get_onemap_token', return_value=token), \
                    patch.object(geocode_pipeline.requests, 'get', return_value=response) as request, \
                    patch.object(geocode_pipeline.time, 'sleep'), \
                    redirect_stdout(StringIO()) as output:
                result = geocode_pipeline.geocode_addresses([('123', 'TEST ROAD')])
            persisted = cache_file.read_text(encoding='utf-8')
        self.assertNotIn('token', request.call_args.kwargs['params'])
        self.assertEqual(request.call_args.kwargs['headers'], {'Authorization': token})
        self.assertNotIn(token, persisted)
        self.assertNotIn(token, output.getvalue())
        self.assertEqual(result['123|TEST ROAD']['status'], 'transient_failure')
        self.assertEqual(result['123|TEST ROAD']['reason'], 'rate_limited')

    def test_token_request_failure_logs_no_response_details(self):
        response = geocode_pipeline.requests.Response()
        response.status_code = 403
        response.url = 'https://example.invalid/auth?secret=synthetic-secret'
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(geocode_pipeline, 'TOKEN_CACHE_FILE', Path(directory) / 'token.json'), \
                    patch.object(geocode_pipeline, 'ONEMAP_EMAIL', 'user@example.invalid'), \
                    patch.object(geocode_pipeline, 'ONEMAP_PASSWORD', 'synthetic-password'), \
                    patch.object(geocode_pipeline.requests, 'post', return_value=response), \
                    redirect_stdout(StringIO()) as output:
                self.assertIsNone(geocode_pipeline.get_onemap_token())
        self.assertNotIn('synthetic-secret', output.getvalue())
        self.assertIn('HTTP error', output.getvalue())

    def test_ambiguous_result_is_recorded_without_coordinates(self):
        candidates = [
            {'POSTAL': '120123', 'LATITUDE': '1.3', 'LONGITUDE': '103.8'},
            {'POSTAL': '130123', 'LATITUDE': '1.31', 'LONGITUDE': '103.81'},
        ]
        with patch.object(geocode_pipeline.requests, 'get', return_value=FakeResponse(candidates)):
            result = geocode_pipeline.geocode_address('123', 'TEST ROAD')
        self.assertEqual(result['status'], 'ambiguous')
        self.assertIsNone(result['latitude'])

    def test_address_extraction_includes_rental_only_address(self):
        import pandas as pd
        resale = pd.DataFrame([{'block': '1', 'street_name': 'Resale Road'}])
        rental = pd.DataFrame([{'block': '2', 'street_name': 'Rental Road'}])
        union = set(geocode_pipeline.extract_unique_addresses(resale)) | set(geocode_pipeline.extract_unique_addresses(rental))
        self.assertEqual(union, {('1', 'RESALE ROAD'), ('2', 'RENTAL ROAD')})


if __name__ == '__main__':
    unittest.main()
