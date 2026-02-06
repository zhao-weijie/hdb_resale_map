"""
HDB Resale Arrow Builder

Joins geocoded addresses with transaction data, calculates derived fields,
and exports to Apache Arrow format for efficient client-side loading.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Tuple, Dict
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


# Configuration
DATA_DIR = Path(__file__).parent.parent / "data"
RAW_DATA_FILE = DATA_DIR / "hdb_resale_raw.csv"
GEOCODE_CACHE = DATA_DIR / "addresses_geocoded.json"
OUTPUT_ARROW = DATA_DIR / "hdb_data.arrow"
OUTPUT_PARQUET = DATA_DIR / "hdb_data.parquet"  # Alternative format


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
    
    print(f"  ✓ Calculated derived fields: price_psm, price_psf, remaining_lease_years")
    
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
        'longitude'
    ]
    
    export_df = df[columns_to_export].copy()
    
    # Convert to Arrow Table
    table = pa.Table.from_pandas(export_df)
    
    # Write Arrow IPC file (Feather v2 format)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    
    with pa.OSFile(str(OUTPUT_ARROW), 'wb') as sink:
        with pa.ipc.new_file(sink, table.schema) as writer:
            writer.write_table(table)
    
    arrow_size_mb = OUTPUT_ARROW.stat().st_size / (1024 * 1024)
    print(f"  ✓ Saved Arrow file: {OUTPUT_ARROW} ({arrow_size_mb:.2f} MB)")
    
    # Also export as Parquet (alternative, often smaller)
    pq.write_table(table, OUTPUT_PARQUET, compression='snappy')
    parquet_size_mb = OUTPUT_PARQUET.stat().st_size / (1024 * 1024)
    print(f"  ✓ Saved Parquet file: {OUTPUT_PARQUET} ({parquet_size_mb:.2f} MB)")
    
    # Print statistics
    print(f"\n  Data summary:")
    print(f"    Transactions: {len(export_df):,}")
    print(f"    Date range: {export_df['month'].min()} to {export_df['month'].max()}")
    print(f"    Towns: {export_df['town'].nunique()}")
    print(f"    Flat types: {export_df['flat_type'].nunique()}")
    print(f"    Price range: ${export_df['resale_price'].min():,.0f} - ${export_df['resale_price'].max():,.0f}")
    print(f"    PSF range: ${export_df['price_psf'].min():.0f} - ${export_df['price_psf'].max():.0f}")


def main():
    """Main build execution"""
    print("=" * 60)
    print("HDB Resale Arrow Builder")
    print("=" * 60)
    
    # Load data
    df, geocode_cache = load_data()
    
    # Join and enrich
    enriched_df = join_and_enrich_data(df, geocode_cache)
    
    # Export
    export_to_arrow(enriched_df)
    
    print("\n" + "=" * 60)
    print("Build complete!")
    print(f"Output: {OUTPUT_ARROW}")
    print("=" * 60)


if __name__ == "__main__":
    main()
