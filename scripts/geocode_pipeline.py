"""
HDB Resale Data Geocoding Pipeline

Fetches the latest HDB resale transaction data, geocodes unique addresses
via OneMap API, and creates a cached lookup table for subsequent runs.

With OneMap API credentials, you get 250 requests/minute rate limit.
"""

import json
import time
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import requests
import pandas as pd
from dotenv import load_dotenv


# Load environment variables
load_dotenv()

# Configuration
ONEMAP_EMAIL = os.getenv("ONEMAP_EMAIL")
ONEMAP_PASSWORD = os.getenv("ONEMAP_PASSWORD")
ONEMAP_TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken"
ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search"
RATE_LIMIT_DELAY = 0.2035  # 210ms between requests (~285 req/min, under 290/min limit as of Oct 2025)
OUTPUT_DIR = Path(__file__).parent.parent / "data"
CACHE_FILE = OUTPUT_DIR / "addresses_geocoded.json"
RAW_DATA_FILE = OUTPUT_DIR / "hdb_resale_raw.csv"
TOKEN_CACHE_FILE = Path(__file__).parent / ".onemap_token.json"


def get_onemap_token() -> Optional[str]:
    """
    Get OneMap API authentication token
    
    Returns:
        Access token string, or None if credentials not configured
    """
    if not ONEMAP_EMAIL or not ONEMAP_PASSWORD:
        print("⚠️  No OneMap credentials found. Using unauthenticated API (lower rate limit)")
        print("   To increase rate limit, add ONEMAP_EMAIL and ONEMAP_PASSWORD to .env file")
        return None
    
    # Check if we have a cached valid token
    if TOKEN_CACHE_FILE.exists():
        try:
            with open(TOKEN_CACHE_FILE, 'r') as f:
                token_data = json.load(f)
                expiry = token_data.get('expiry_time', 0)
                if time.time() < expiry:
                    print(f"✓ Using cached OneMap token (expires in {int((expiry - time.time()) / 60)} minutes)")
                    return token_data.get('access_token')
        except:
            pass
    
    # Get new token
    print("🔑 Authenticating with OneMap API...")
    try:
        response = requests.post(
            ONEMAP_TOKEN_URL,
            json={
                "email": ONEMAP_EMAIL,
                "password": ONEMAP_PASSWORD
            }
        )
        response.raise_for_status()
        data = response.json()
        
        access_token = data.get('access_token')
        expiry_time = time.time() + (3 * 24 * 60 * 60)  # Token valid for 3 days
        
        # Cache the token
        with open(TOKEN_CACHE_FILE, 'w') as f:
            json.dump({
                'access_token': access_token,
                'expiry_time': expiry_time
            }, f)
        
        print("✓ Successfully authenticated with OneMap API (290 req/min limit)")
        return access_token
        
    except requests.exceptions.HTTPError as e:
        print(f"❌ Failed to authenticate with OneMap API: {e}")
        print("   Check your credentials in .env file")
        print("   Falling back to unauthenticated API")
        return None
    except Exception as e:
        print(f"❌ Error during authentication: {e}")
        print("   Falling back to unauthenticated API")
        return None


def fetch_hdb_data() -> pd.DataFrame:
    """
    Load HDB resale data from local CSV file
    
    Returns:
        DataFrame with all HDB resale transactions (2017-present)
    """
    print("Loading HDB resale data from local CSV...")
    
    # Look for the CSV file in scripts directory first, then project root
    csv_filename = "ResaleflatpricesbasedonregistrationdatefromJan2017onwards.csv"
    csv_paths = [
        Path(__file__).parent / csv_filename,  # scripts directory
        Path(__file__).parent.parent / csv_filename,  # project root
    ]
    
    csv_path = None
    for path in csv_paths:
        if path.exists():
            csv_path = path
            break
    
    if csv_path is None:
        raise FileNotFoundError(
            f"CSV file not found: {csv_filename}\n"
            f"Searched in:\n"
            f"  - {csv_paths[0]}\n"
            f"  - {csv_paths[1]}\n"
            "Please ensure the HDB resale CSV is in one of these locations."
        )
    
    df = pd.read_csv(csv_path)
    print(f"✓ Loaded {len(df)} total transactions from {csv_path}")
    
    # Save to data directory for consistency
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(RAW_DATA_FILE, index=False)
    print(f"✓ Copied to {RAW_DATA_FILE}")
    
    return df


def extract_unique_addresses(df: pd.DataFrame) -> List[Tuple[str, str]]:
    """
    Extract unique (block, street_name) combinations
    
    Returns:
        List of (block, street_name) tuples
    """
    print("\nExtracting unique addresses...")
    
    # Combine block and street_name
    unique_addresses = df[["block", "street_name"]].drop_duplicates()
    
    addresses = [
        (row["block"], row["street_name"]) 
        for _, row in unique_addresses.iterrows()
    ]
    
    print(f"✓ Found {len(addresses)} unique addresses to geocode")
    return addresses


def load_geocode_cache() -> Dict[str, Dict]:
    """
    Load existing geocoding cache if available
    
    Returns:
        Dictionary mapping address key to geocode result
    """
    if CACHE_FILE.exists():
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            cache = json.load(f)
            print(f"✓ Loaded {len(cache)} cached geocodes from {CACHE_FILE}")
            return cache
    return {}


def save_geocode_cache(cache: Dict[str, Dict]):
    """Save geocoding cache to disk"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)
    print(f"✓ Saved geocode cache to {CACHE_FILE}")


def make_address_key(block: str, street_name: str) -> str:
    """Create a consistent key for address lookup"""
    return f"{block}|{street_name}"


def geocode_address(block: str, street_name: str, token: Optional[str] = None) -> Dict:
    """
    Geocode a single address using OneMap API
    
    Args:
        block: HDB block number
        street_name: Street name
        token: Optional OneMap API authentication token
    
    Returns:
        Dict with lat, lng, or None if not found
    """
    search_query = f"{block} {street_name}"
    
    params = {
        "searchVal": search_query,
        "returnGeom": "Y",
        "getAddrDetails": "Y"
    }
    
    # Add token to params if available
    if token:
        params["token"] = token
    
    try:
        response = requests.get(ONEMAP_SEARCH_URL, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        results = data.get("results", [])
        
        if results:
            # Take the first result
            result = results[0]
            return {
                "block": block,
                "street_name": street_name,
                "latitude": float(result["LATITUDE"]),
                "longitude": float(result["LONGITUDE"]),
                "postal": result.get("POSTAL", ""),
                "address": result.get("ADDRESS", "")
            }
        else:
            return {
                "block": block,
                "street_name": street_name,
                "latitude": None,
                "longitude": None,
                "error": "No results found"
            }
            
    except Exception as e:
        return {
            "block": block,
            "street_name": street_name,
            "latitude": None,
            "longitude": None,
            "error": str(e)
        }


def geocode_addresses(addresses: List[Tuple[str, str]]) -> Dict[str, Dict]:
    """
    Geocode all addresses with caching and rate limiting
    
    Returns:
        Dictionary mapping address key to geocode result
    """
    print("\nGeocoding addresses...")
    
    # Get authentication token
    token = get_onemap_token()
    
    cache = load_geocode_cache()
    
    to_geocode = [
        addr for addr in addresses 
        if make_address_key(addr[0], addr[1]) not in cache
    ]
    
    if not to_geocode:
        print("✓ All addresses already cached!")
        return cache
    
    print(f"  {len(to_geocode)} new addresses to geocode")
    print(f"  Estimated time: ~{len(to_geocode) * RATE_LIMIT_DELAY / 60:.1f} minutes")
    
    for i, (block, street_name) in enumerate(to_geocode, 1):
        key = make_address_key(block, street_name)
        
        # Geocode with token if available
        result = geocode_address(block, street_name, token)
        cache[key] = result
        
        # Progress update every 100 addresses
        if i % 100 == 0:
            total_success = sum(1 for v in cache.values() if v.get("latitude") is not None)
            print(f"  Current batch: {i}/{len(to_geocode)} processed")
            print(f"  Total cache: {total_success}/{len(cache)} addresses ({100*total_success/len(cache):.1f}% success)")
            # Save intermediate results
            save_geocode_cache(cache)
        
        # Rate limiting
        time.sleep(RATE_LIMIT_DELAY)
    
    # Final save
    save_geocode_cache(cache)
    
    # Summary
    success_count = sum(1 for v in cache.values() if v.get("latitude") is not None)
    print(f"\n✓ Geocoding complete: {success_count}/{len(cache)} addresses successfully geocoded ({100*success_count/len(cache):.1f}%)")
    
    return cache


def main():
    """Main pipeline execution"""
    print("=" * 60)
    print("HDB Resale Geocoding Pipeline")
    print("=" * 60)
    
    # Step 1: Fetch data
    df = fetch_hdb_data()
    
    # Step 2: Extract unique addresses
    addresses = extract_unique_addresses(df)
    
    # Step 3: Geocode addresses
    geocode_cache = geocode_addresses(addresses)
    
    print("\n" + "=" * 60)
    print("Pipeline complete!")
    print(f"Raw data: {RAW_DATA_FILE}")
    print(f"Geocode cache: {CACHE_FILE}")
    print("=" * 60)


if __name__ == "__main__":
    main()
