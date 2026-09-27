# Data Pipeline Scripts

Scripts to fetch, geocode, and prepare HDB resale data for the web application.

## Setup

Install Python dependencies:

```bash
pip install -r requirements.txt
```

## Usage

### Step 1: Geocode Pipeline

Fetches HDB resale and whole-flat rental data from data.gov.sg, then geocodes their address union via OneMap API.

```bash
python geocode_pipeline.py
```
- Downloads both source CSVs before geocoding
- Extracts unique canonical `block + street_name` combinations from both sources
- Geocodes via OneMap API with rate limiting
- Caches results to avoid re-geocoding on updates
- **Optional**: Use OneMap API credentials for 250 requests/minute (vs default rate limit)
- **First run**: ~1 hour for full geocoding (or ~50 minutes with API credentials)
- **Subsequent runs**: Only geocodes new addresses (typically <1 minute)

**OneMap API Authentication (Optional but Recommended)**

To increase the geocoding rate limit:

1. Register at https://www.onemap.gov.sg/apidocs/register
2. Edit `scripts/.env` file:
   ```
   ONEMAP_EMAIL=your_email@example.com
   ONEMAP_PASSWORD=your_password
   ```
3. The script will automatically use authentication (250 req/min vs default limit)

### Step 2: Build Arrow

Joins geocoded addresses with transactions and exports yearly Arrow files and a manifest. No model training is performed.

```bash
python build_arrow.py
```

**Output:**
- `../public/data/manifest.json` - Year URLs, row counts, date bounds, and content hashes
- `../public/data/hdb_data_<year>-<hash>.arrow` - One Arrow IPC file per year

The pipeline removes obsolete yearly files. It does not generate an unpartitioned Arrow file.

### Whole-flat rental evidence

Build the separate HDB rental asset when rental evidence changes:

```bash
python build_rental.py
```

It downloads the official [HDB rental transactions dataset](https://data.gov.sg/datasets/d_c9f57187485a850908655db0e8cfe651/view), keeps records from 2021 onward by default, and writes a schema-v2 content-hashed tuple JSON file plus `rental_manifest.json`. The asset stores coordinates once in a location dictionary and gives each source row a location reference (or `null` when unresolved). The manifest reports address and row coverage by resolution status. Publication fails unless more than 99.5% of valid rental rows resolve. `generatedAt` records the UTC build time when canonical content changes; an unchanged source reuses the prior timestamp and asset. Set `HDB_RENTAL_CSV` for a local fixture or `HDB_RENTAL_START_MONTH` to change the retained range. It does not deduplicate source rental observations because the publication has no unit identifier.

The rental snapshot and manifest are deployment outputs and are ignored by Git. The Pages workflow builds them before Vite packages `public/data`; run this script locally before starting the development server when testing rental mode.

**Duration:** ~1 minute

## Data Format

The yearly Arrow files contain:
- **Transactions** from 2017-present
- **Coordinates:** latitude, longitude
- **Pricing:** resale_price, price_psm, price_psf
- **Property details:** town, flat_type, floor_area_sqm, storey_range
- **Lease info:** lease_commence_date, remaining_lease_years
- **Temporal:** month, transaction_date
- **Location detail:** distance to the nearest MRT exit

Prices remain nominal transaction prices; model predictions and price-index adjustment are not included.

## Updating Data

To refresh with the latest data from data.gov.sg:

```bash
# Fetch both sources/geocode, then build both assets
python geocode_pipeline.py
python build_arrow.py
HDB_RENTAL_CSV=scripts/data/hdb_rental_raw.csv python build_rental.py
```

The geocoding cache will ensure only new addresses are geocoded.

To test with a local CSV instead of data.gov.sg, set `HDB_RESALE_CSV=/path/to/file.csv`.
