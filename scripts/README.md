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
- Loads your provided CSV file
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

Joins geocoded addresses with transactions and exports to Arrow format.

```bash
python build_arrow.py
```

**Output:**
- `data/hdb_data.arrow` - Main data file (Arrow IPC format)
- `data/hdb_data.parquet` - Alternative format (often smaller)

**Duration:** ~1 minute

## Data Format

The final Arrow file contains:
- **~600,000+ transactions** from 2017-present
- **Coordinates:** latitude, longitude
- **Pricing:** resale_price, price_psm, price_psf
- **Property details:** town, flat_type, floor_area_sqm, storey_range
- **Lease info:** lease_commence_date, remaining_lease_years
- **Temporal:** month, transaction_date

## Updating Data

To refresh with the latest data from data.gov.sg:

```bash
# Re-run both scripts
python geocode_pipeline.py
python build_arrow.py
```

The geocoding cache will ensure only new addresses are geocoded.
