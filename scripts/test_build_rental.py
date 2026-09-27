import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

import build_rental
from build_rental import normalise_flat_type, normalise_month, normalise_rentals


def resolved_registry(*addresses):
    return {
        address: {
            'status': 'resolved', 'latitude': 1.3, 'longitude': 103.8,
            'block': address.split('|')[0], 'street_name': address.split('|')[1],
        }
        for address in addresses
    }


class RentalBuilderTests(unittest.TestCase):
    def test_normalises_documented_month_and_flat_type_forms(self):
        self.assertEqual(normalise_month('2025-02'), '2025-02')
        self.assertEqual(normalise_month('2025-02-15'), '2025-02')
        self.assertEqual(normalise_month('not a date'), '')
        self.assertEqual(normalise_flat_type('4-Room'), '4 ROOM')
        self.assertEqual(normalise_flat_type('multi generation'), 'MULTI-GENERATION')

    def test_rejects_invalid_rows_and_preserves_duplicate_observations(self):
        source = pd.DataFrame([
            {'rent_approval_date': '2025-01', 'town': ' Town ', 'block': ' 123 ', 'street_name': ' Test Road ', 'flat_type': '4-Room', 'monthly_rent': '3200'},
            {'rent_approval_date': '2025-01', 'town': ' Town ', 'block': ' 123 ', 'street_name': ' Test Road ', 'flat_type': '4-Room', 'monthly_rent': '3200'},
            {'rent_approval_date': '2020-12', 'town': 'Town', 'block': '123', 'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3000},
            {'rent_approval_date': 'bad', 'town': 'Town', 'block': '123', 'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3000},
            {'rent_approval_date': '2025-03', 'town': 'Town', 'block': '123', 'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 0},
        ])

        records, rejected = normalise_rentals(source, '2021-01')

        self.assertEqual(records, [
            ['2025-01', 'TOWN', '123', 'TEST ROAD', '4 ROOM', 3200.0],
            ['2025-01', 'TOWN', '123', 'TEST ROAD', '4 ROOM', 3200.0],
        ])
        self.assertEqual(rejected, {'invalid': 2, 'beforeStart': 1})

    def test_generated_at_is_real_build_time_and_stable_for_identical_content(self):
        source = pd.DataFrame([{
            'rent_approval_date': '2025-01', 'town': 'Town', 'block': '123',
            'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3200,
        }])
        with tempfile.TemporaryDirectory() as temporary_directory:
            public_dir = Path(temporary_directory)
            with patch.object(build_rental, 'PUBLIC_DATA_DIR', public_dir), \
                    patch.object(build_rental, 'MANIFEST_FILE', public_dir / 'rental_manifest.json'), \
                    patch.object(build_rental, 'utc_now', side_effect=['2026-09-25T01:02:03Z', '2026-09-25T04:05:06Z']):
                registry = resolved_registry('123|TEST ROAD')
                first_payload, first_manifest = build_rental.build_dataset(source, '2021-01', registry)
                build_rental.write_outputs(first_manifest)
                second_payload, second_manifest = build_rental.build_dataset(source, '2021-01', registry)

                changed_source = source.copy()
                changed_source.loc[0, 'monthly_rent'] = 3300
                changed_payload, _ = build_rental.build_dataset(changed_source, '2021-01', registry)

        self.assertEqual(first_payload['generatedAt'], '2026-09-25T01:02:03Z')
        self.assertNotIn('classifications', first_payload)
        self.assertNotIn('classificationRegistry', first_payload)
        self.assertEqual(second_payload['generatedAt'], first_payload['generatedAt'])
        self.assertEqual(second_manifest['sha256'], first_manifest['sha256'])
        self.assertEqual(changed_payload['generatedAt'], '2026-09-25T04:05:06Z')
        self.assertEqual(first_payload['version'], 2)
        self.assertEqual(first_payload['records'][0][-1], 0)
        self.assertEqual(first_manifest['coverage']['resolvedPercent'], 100)

    def test_coverage_gate_is_strictly_greater_than_99_5_percent(self):
        rows = []
        for index in range(200):
            rows.append({
                'rent_approval_date': '2025-01', 'town': 'Town', 'block': str(index),
                'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3200,
            })
        source = pd.DataFrame(rows)
        registry = resolved_registry(*(f'{index}|TEST ROAD' for index in range(199)))
        registry['199|TEST ROAD'] = {'status': 'ambiguous', 'reason': 'no_postal_match'}

        with self.assertRaisesRegex(ValueError, r'>99\.5%'):
            build_rental.build_dataset(source, '2021-01', registry)

        source = pd.concat([source, pd.DataFrame([{
            'rent_approval_date': '2025-01', 'town': 'Town', 'block': '0',
            'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3300,
        }])], ignore_index=True)
        payload, manifest = build_rental.build_dataset(source, '2021-01', registry)
        self.assertEqual(len(payload['records']), 201)
        self.assertEqual(manifest['coverage']['resolvedRows'], 200)
        self.assertEqual(manifest['coverage']['byStatus'], {'resolved': 200, 'ambiguous': 1})
        self.assertEqual(manifest['coverage']['unresolvedByReason'], {'no_postal_match': 1})

    def test_location_dictionary_preserves_duplicate_observations(self):
        source = pd.DataFrame([
            {'rent_approval_date': '2025-01', 'town': 'Town', 'block': '123', 'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3200},
            {'rent_approval_date': '2025-01', 'town': 'Town', 'block': '123', 'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3200},
        ])
        payload, manifest = build_rental.build_dataset(source, '2021-01', resolved_registry('123|TEST ROAD'))
        self.assertEqual(len(payload['locations']), 1)
        self.assertEqual(len(payload['records']), 2)
        self.assertEqual(payload['records'][0], payload['records'][1])
        self.assertEqual(manifest['addressCoverage']['uniqueAddresses'], 1)


if __name__ == '__main__':
    unittest.main()
