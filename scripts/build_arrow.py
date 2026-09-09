"""
HDB Resale Arrow Builder

Joins geocoded addresses with transaction data, calculates derived fields,
and exports to Apache Arrow format for efficient client-side loading.
"""

import hashlib
import json
from pathlib import Path
from typing import Tuple, Dict
import pandas as pd
import numpy as np
import pyarrow as pa


# Configuration
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"  # scripts/data/ for raw data and geocode cache
PUBLIC_DATA_DIR = SCRIPT_DIR.parent / "public" / "data"
RAW_DATA_FILE = DATA_DIR / "hdb_resale_raw.csv"
GEOCODE_CACHE = PUBLIC_DATA_DIR / "addresses_geocoded.json"
MRT_GEOJSON = PUBLIC_DATA_DIR / "LTAMRTStationExitGEOJSON.geojson"
OUTPUT_MANIFEST = PUBLIC_DATA_DIR / "manifest.json"


def load_data() -> Tuple[pd.DataFrame, Dict]:
    """Load raw data and geocode cache"""
    print("Loading data...")
    
    if not RAW_DATA_FILE.exists():
        raise FileNotFoundError(
            f"Raw data file not found: {RAW_DATA_FILE}\n"
            "Please run geocode_pipeline.py first"
        )
    
    if not GEOCODE_CACHE.exists():
        raise FileNotFoundError(
            f"Geocode cache not found: {GEOCODE_CACHE}\n"
            "Please run geocode_pipeline.py first"
        )
    
    df = pd.read_csv(RAW_DATA_FILE)
    print(f"  ✓ Loaded {len(df)} transactions")
    
    with open(GEOCODE_CACHE, 'r', encoding='utf-8') as f:
        geocode_cache = json.load(f)
    print(f"  ✓ Loaded {len(geocode_cache)} geocoded addresses")
    
    return df, geocode_cache


def make_address_key(block: str, street_name: str) -> str:
    """Create consistent address key"""
    return f"{block}|{street_name}"


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two points in meters."""
    R = 6371000  # Earth radius in meters
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    delta_phi = np.radians(lat2 - lat1)
    delta_lambda = np.radians(lon2 - lon1)
    
    a = np.sin(delta_phi / 2) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(delta_lambda / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c


def load_mrt_stations() -> list:
    """Load MRT station exit coordinates from GeoJSON."""
    with open(MRT_GEOJSON, 'r', encoding='utf-8') as f:
        geojson = json.load(f)
    
    stations = []
    for feature in geojson['features']:
        coords = feature['geometry']['coordinates']
        stations.append({
            'name': feature['properties']['STATION_NA'],
            'longitude': coords[0],
            'latitude': coords[1]
        })
    return stations


def calculate_mrt_distance(lat: float, lon: float, mrt_stations: list) -> float:
    """Calculate distance to nearest MRT exit in meters."""
    min_distance = float('inf')
    for station in mrt_stations:
        dist = haversine_distance(lat, lon, station['latitude'], station['longitude'])
        if dist < min_distance:
            min_distance = dist
    return min_distance


def calculate_remaining_lease(lease_commence_date: int, month: str) -> float:
    """
    Calculate remaining lease in years
    
    Args:
        lease_commence_date: Year lease started
        month: Transaction month (YYYY-MM format)
    
    Returns:
        Remaining lease in years (99 - age at transaction)
    """
    try:
        transaction_year = int(month.split('-')[0])
        years_elapsed = transaction_year - lease_commence_date
        return max(0, 99 - years_elapsed)  # HDB leases are 99 years
    except:
        return None


def join_and_enrich_data(df: pd.DataFrame, geocode_cache: dict) -> pd.DataFrame:
    """
    Join transaction data with geocodes and calculate derived fields
    """
    print("\nEnriching data...")
    
    # Add geocoding
    df['address_key'] = df.apply(
        lambda row: make_address_key(row['block'], row['street_name']), 
        axis=1
    )
    
    df['latitude'] = df['address_key'].apply(
        lambda key: geocode_cache.get(key, {}).get('latitude')
    )
    df['longitude'] = df['address_key'].apply(
        lambda key: geocode_cache.get(key, {}).get('longitude')
    )
    
    # Filter out failed geocodes
    before_count = len(df)
    df = df[df['latitude'].notna() & df['longitude'].notna()].copy()
    after_count = len(df)
    print(f"  ✓ Joined geocodes: {after_count}/{before_count} transactions have valid coordinates")
    
    # Calculate price per square meter
    df['price_psm'] = df['resale_price'] / df['floor_area_sqm']
    
    # Calculate price per square foot
    df['price_psf'] = df['resale_price'] / (df['floor_area_sqm'] * 10.764)  # 1 sqm = 10.764 sqft
    
    # Calculate remaining lease
    df['remaining_lease_years'] = df.apply(
        lambda row: calculate_remaining_lease(row['lease_commence_date'], row['month']),
        axis=1
    )
    
    # Convert month to datetime for easier time-series analysis
    df['transaction_date'] = pd.to_datetime(df['month'])
    
    # Convert flat_type to categorical for smaller storage
    df['flat_type'] = df['flat_type'].astype('category')
    df['town'] = df['town'].astype('category')
    df['flat_model'] = df['flat_model'].astype('category')
    df['storey_range'] = df['storey_range'].astype('category')
    
    # Calculate MRT distance per unique location (optimized)
    print("  Calculating MRT distances (per unique location)...")
    mrt_stations = load_mrt_stations()
    unique_locations = df[['latitude', 'longitude']].drop_duplicates()
    print(f"    Found {len(unique_locations)} unique locations")
    
    location_to_mrt_dist = {}
    for _, row in unique_locations.iterrows():
        key = (row['latitude'], row['longitude'])
        location_to_mrt_dist[key] = calculate_mrt_distance(row['latitude'], row['longitude'], mrt_stations)
    
    df['mrt_distance_m'] = df.apply(
        lambda row: location_to_mrt_dist[(row['latitude'], row['longitude'])],
        axis=1
    )
    print(f"  ✓ MRT distances calculated")
    
    print(f"  ✓ Calculated derived fields: price_psm, price_psf, remaining_lease_years, mrt_distance_m")
    
    return df


def export_to_arrow(df: pd.DataFrame):
    """
    Export DataFrame to Apache Arrow IPC format
    """
    print("\nExporting to Arrow format...")
    
    # Select and order columns for export
    columns_to_export = [
        'month',
        'transaction_date',
        'town',
        'flat_type',
        'block',
        'street_name',
        'storey_range',
        'floor_area_sqm',
        'flat_model',
        'lease_commence_date',
        'remaining_lease_years',
        'resale_price',
        'price_psm',
        'price_psf',
        'latitude',
        'longitude',
        'mrt_distance_m'
    ]
    
    export_df = df[columns_to_export].copy()
    
    # Convert to Arrow Table
    table = pa.Table.from_pandas(export_df)
    
    # Print statistics
    print(f"\n  Data summary:")
    print(f"    Transactions: {len(export_df):,}")
    print(f"    Date range: {export_df['month'].min()} to {export_df['month'].max()}")
    print(f"    Towns: {export_df['town'].nunique()}")
    print(f"    Flat types: {export_df['flat_type'].nunique()}")
    print(f"    Price range: ${export_df['resale_price'].min():,.0f} - ${export_df['resale_price'].max():,.0f}")
    print(f"    PSF range: ${export_df['price_psf'].min():.0f} - ${export_df['price_psf'].max():.0f}")

    export_yearly_partitions(table)


def export_yearly_partitions(table: pa.Table) -> None:
    """Write one Arrow file per year and a manifest consumed by the web app."""
    month_values = table.column("month").to_pylist()
    if not month_values:
        raise ValueError("Cannot partition an empty Arrow table")

    years = sorted({int(str(month)[:4]) for month in month_values})
    entries = []
    for year in years:
        mask = pa.array([str(month).startswith(f"{year}-") for month in month_values])
        year_table = table.filter(mask)
        year_months = year_table.column("month").to_pylist()
        temporary_path = PUBLIC_DATA_DIR / f".hdb_data_{year}.arrow.tmp"
        with pa.OSFile(str(temporary_path), "wb") as sink:
            with pa.ipc.new_file(sink, year_table.schema) as writer:
                writer.write_table(year_table)
        digest = hashlib.sha256(temporary_path.read_bytes()).hexdigest()
        filename = f"hdb_data_{year}-{digest[:12]}.arrow"
        output_path = PUBLIC_DATA_DIR / filename
        temporary_path.replace(output_path)
        entries.append({
            "year": year,
            "url": filename,
            "rows": year_table.num_rows,
            "minMonth": min(year_months),
            "maxMonth": max(year_months),
            "sha256": digest,
        })
        print(f"  Saved {filename}: {year_table.num_rows:,} transactions")

    manifest = {
        "version": 1,
        "minMonth": min(month_values),
        "maxMonth": max(month_values),
        "years": entries,
    }
    OUTPUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    active_files = {entry["url"] for entry in entries}
    stale_files = [
        *PUBLIC_DATA_DIR.glob("hdb_data_????.arrow"),
        *PUBLIC_DATA_DIR.glob("hdb_data_????-*.arrow"),
    ]
    for stale_file in stale_files:
        if stale_file.name not in active_files:
            stale_file.unlink()
            print(f"  Removed stale partition {stale_file.name}")
    print(f"  Saved manifest: {OUTPUT_MANIFEST}")


def main():
    """Main build execution."""
    print("=" * 60)
    print("HDB Resale Arrow Builder")
    print("=" * 60)

    df, geocode_cache = load_data()
    enriched_df = join_and_enrich_data(df, geocode_cache)
    export_to_arrow(enriched_df)

    print("\n" + "=" * 60)
    print("Build complete!")
    print(f"Output: {OUTPUT_MANIFEST} and yearly Arrow files")
    print("=" * 60)


if __name__ == "__main__":
    main()
