"""
HDB Resale Fair Value - Regression Model Fitting

Fits a linear regression model on historical transaction data to estimate
the impact of key factors on price per square meter.

Uses pre-computed fields from hdb_data.arrow (MRT distance, storey midpoint, price index).
Outputs coefficients to JSON for use in the frontend.
"""

import json
from pathlib import Path
import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import LabelEncoder
import pyarrow.ipc as ipc

# Paths - resolve to absolute paths
SCRIPT_DIR = Path(__file__).resolve().parent
PUBLIC_DATA_DIR = (SCRIPT_DIR.parent / "public" / "data").resolve()
ARROW_FILE = PUBLIC_DATA_DIR / "hdb_data.arrow"
PRICE_INDEX_CSV = PUBLIC_DATA_DIR / "HDBResalePriceIndex1Q2009100Quarterly.csv"
OUTPUT_COEFFICIENTS = PUBLIC_DATA_DIR / "regression_coefficients.json"


def load_price_index() -> dict:
    """Load HDB Resale Price Index and return as quarter -> index mapping."""
    df = pd.read_csv(PRICE_INDEX_CSV)
    return {row['quarter']: row['index'] for _, row in df.iterrows()}


def main():
    print("=" * 60)
    print("HDB Resale - Regression Model Fitting")
    print("=" * 60)
    
    # Load data (now includes pre-computed fields)
    print("\nLoading data from Arrow file...")
    with open(ARROW_FILE, 'rb') as f:
        reader = ipc.open_file(f)
        table = reader.read_all()
    df = table.to_pandas()
    print(f"  ✓ Loaded {len(df)} transactions")
    print(f"  ✓ Columns: {list(df.columns)}")
    
    # Get latest price index for normalization
    price_index_map = load_price_index()
    latest_quarter = max(price_index_map.keys())
    latest_index = price_index_map[latest_quarter]
    print(f"  ✓ Latest price index: {latest_quarter} = {latest_index}")
    
    # Time-adjusted price PSM (normalized to latest index)
    print("\nPreparing features...")
    df['adjusted_price_psm'] = df['price_psm'] * (latest_index / df['price_index'])
    df['log_adjusted_price_psm'] = np.log(df['adjusted_price_psm'])
    df['mrt_distance_km'] = df['mrt_distance_m'] / 1000
    
    # Encode flat type
    le = LabelEncoder()
    df['flat_type_encoded'] = le.fit_transform(df['flat_type'].astype(str))
    flat_type_mapping = {int(i): label for i, label in enumerate(le.classes_)}
    
    print(f"  ✓ Features prepared")
    
    # Prepare regression data
    print("\nFitting regression model...")
    feature_cols = ['storey_midpoint', 'remaining_lease_years', 'mrt_distance_km', 'floor_area_sqm', 'flat_type_encoded']
    
    # Drop rows with missing values
    df_clean = df.dropna(subset=feature_cols + ['log_adjusted_price_psm'])
    print(f"  Using {len(df_clean)} transactions (dropped {len(df) - len(df_clean)} with missing values)")
    
    X = df_clean[feature_cols].values
    y = df_clean['log_adjusted_price_psm'].values
    
    # Fit model
    model = LinearRegression()
    model.fit(X, y)
    
    r_squared = model.score(X, y)
    print(f"  ✓ Model fitted. R² = {r_squared:.4f}")
    
    # Extract coefficients
    coefficients = {
        'intercept': float(model.intercept_),
        'features': {
            'storey_midpoint': float(model.coef_[0]),
            'remaining_lease_years': float(model.coef_[1]),
            'mrt_distance_km': float(model.coef_[2]),
            'floor_area_sqm': float(model.coef_[3]),
            'flat_type_encoded': float(model.coef_[4]),
        },
        'flat_type_mapping': flat_type_mapping,
        'r_squared': r_squared,
        'latest_price_index': float(latest_index),
        'latest_quarter': latest_quarter,
        'n_samples': len(df_clean),
    }
    
    # Interpret coefficients (convert from log scale to percentage impact)
    print("\n  Feature Impacts (per unit increase):")
    for feature, coef in coefficients['features'].items():
        pct_impact = (np.exp(coef) - 1) * 100
        print(f"    {feature}: {pct_impact:+.2f}%")
    
    # Summary statistics for frontend use
    summary_stats = {
        'storey_midpoint': {'mean': float(df_clean['storey_midpoint'].mean()), 'std': float(df_clean['storey_midpoint'].std())},
        'remaining_lease_years': {'mean': float(df_clean['remaining_lease_years'].mean()), 'std': float(df_clean['remaining_lease_years'].std())},
        'mrt_distance_km': {'mean': float(df_clean['mrt_distance_km'].mean()), 'std': float(df_clean['mrt_distance_km'].std())},
        'floor_area_sqm': {'mean': float(df_clean['floor_area_sqm'].mean()), 'std': float(df_clean['floor_area_sqm'].std())},
    }
    coefficients['summary_stats'] = summary_stats
    
    # Save coefficients
    with open(OUTPUT_COEFFICIENTS, 'w', encoding='utf-8') as f:
        json.dump(coefficients, f, indent=2)
    
    print(f"\n  ✓ Saved coefficients to: {OUTPUT_COEFFICIENTS}")
    print("\n" + "=" * 60)
    print("Regression model fitting complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
