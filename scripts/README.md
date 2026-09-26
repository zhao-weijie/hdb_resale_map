# Data Pipeline Scripts

Scripts to fetch, geocode, and prepare HDB resale data for the web application.

## Setup

Install Python dependencies:

```bash
pip install -r requirements.txt
```

## Usage

### Step 1: Geocode Pipeline

Fetches HDB resale data from data.gov.sg and geocodes addresses via OneMap API.

```bash
python geocode_pipeline.py
```
- Downloads the latest HDB resale CSV from data.gov.sg
- Extracts unique `block + street_name` combinations (~12,000 addresses)
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

It downloads the official [HDB rental transactions dataset](https://data.gov.sg/datasets/d_c9f57187485a850908655db0e8cfe651/view), keeps records from 2021 onward by default, and writes a content-hashed tuple JSON file plus `rental_manifest.json`. `generatedAt` records the UTC build time when canonical content changes; an unchanged source reuses the prior timestamp and asset. Set `HDB_RENTAL_CSV` for a local fixture or `HDB_RENTAL_START_MONTH` to change the retained range. It does not deduplicate source rental observations because the publication has no unit identifier.

The rental snapshot, manifest, and generated classification registry are deployment outputs and are ignored by Git. The Pages workflow builds them before Vite packages `public/data`; run this script locally before starting the development server when testing rental mode.

`rental_classifications.json` is deliberately incomplete. It currently includes only the verified River Peaks I and II PLH blocks from HDB's [launch annex](https://www.hdb.gov.sg/-/media/hdb-pulse/news/2021/hdb-launches-6299-flats-in-november-2021-bto-and-sbf-exercises/17112021-Annex-A1.pdf) and [address annex](https://www.hdb.gov.sg/-/media/hdb-pulse/news/2022/hdb-awards-2022-oct22/09102022---Corp-PR---Annex---HDB-Awards-2022.pdf). Consumers must treat all unlisted homes as rental eligibility unknown; rental history and fuzzy project matching are not eligibility evidence.

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
# Re-run both scripts
python geocode_pipeline.py
python build_arrow.py
```

The geocoding cache will ensure only new addresses are geocoded.

To test with a local CSV instead of data.gov.sg, set `HDB_RESALE_CSV=/path/to/file.csv`.
