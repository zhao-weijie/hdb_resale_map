import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

import build_rental
from build_rental import known_classifications, normalise_flat_type, normalise_month, normalise_rentals


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

    def test_registry_contains_only_explicitly_verified_river_peaks_blocks(self):
        classifications = known_classifications()
        self.assertEqual(len(classifications), 8)
        self.assertEqual(
            {(entry['block'], entry['street_name']) for entry in classifications},
            {
                ('36', 'KELANTAN ROAD'), ('36A', 'KELANTAN ROAD'),
                ('36B', 'KELANTAN ROAD'), ('36C', 'KELANTAN ROAD'),
                ('37', 'WELD ROAD'), ('37A', 'WELD ROAD'),
                ('37B', 'WELD ROAD'), ('37C', 'WELD ROAD'),
            },
        )
        self.assertTrue(all(entry['category'] == 'plh' for entry in classifications))
        self.assertTrue(all(entry['wholeFlatRental'] == 'prohibited' for entry in classifications))
        self.assertTrue(all(len(entry['evidenceUrls']) == 2 for entry in classifications))

    def test_generated_at_is_real_build_time_and_stable_for_identical_content(self):
        source = pd.DataFrame([{
            'rent_approval_date': '2025-01', 'town': 'Town', 'block': '123',
            'street_name': 'Test Road', 'flat_type': '4 Room', 'monthly_rent': 3200,
        }])
        with tempfile.TemporaryDirectory() as temporary_directory:
            public_dir = Path(temporary_directory)
            with patch.object(build_rental, 'PUBLIC_DATA_DIR', public_dir), \
                    patch.object(build_rental, 'MANIFEST_FILE', public_dir / 'rental_manifest.json'), \
                    patch.object(build_rental, 'CLASSIFICATION_REGISTRY_FILE', public_dir / 'rental_classifications.json'), \
                    patch.object(build_rental, 'utc_now', side_effect=['2026-09-25T01:02:03Z', '2026-09-25T04:05:06Z']):
                first_payload, first_manifest = build_rental.build_dataset(source, '2021-01')
                build_rental.write_outputs(first_manifest)
                second_payload, second_manifest = build_rental.build_dataset(source, '2021-01')

                changed_source = source.copy()
                changed_source.loc[0, 'monthly_rent'] = 3300
                changed_payload, _ = build_rental.build_dataset(changed_source, '2021-01')

        self.assertEqual(first_payload['generatedAt'], '2026-09-25T01:02:03Z')
        self.assertEqual(second_payload['generatedAt'], first_payload['generatedAt'])
        self.assertEqual(second_manifest['sha256'], first_manifest['sha256'])
        self.assertEqual(changed_payload['generatedAt'], '2026-09-25T04:05:06Z')


if __name__ == '__main__':
    unittest.main()
