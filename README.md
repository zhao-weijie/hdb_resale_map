# HDB Resale Analytics SPA

An interactive, high-performance map visualization of Singapore HDB resale transactions (2017-present) with spatial querying and time-series analytics.

## Features

- 🗺️ **WebGL Map Visualization** - Renders 100,000+ transactions smoothly using Deck.gl
- 🎯 **Radial Selection** - Draw circular areas to analyze specific neighborhoods
- 📊 **Time-Series Analytics** - View price trends over time
- 📱 **Mobile-Optimized** - Map and viewport statistics for mobile devices
- 💾 **Static public map** - Deployable to GitHub Pages. Saved homes use a separate Convex backend.
- 🚀 **Apache Arrow** - Efficient binary data format for fast loading

## Quick Start

### 1. Install Dependencies

```bash
# Python dependencies (for data pipeline)
cd scripts
pip install -r requirements.txt

# Node.js dependencies (for web app)
cd ..
npm install
```

### 2. Prepare Data

```bash
# Run geocoding pipeline (downloads data from data.gov.sg, geocodes addresses via OneMap)
# First run: ~1 hour. Subsequent runs: fast, only new addresses are geocoded.
python scripts/geocode_pipeline.py

# Build yearly Arrow data files
python scripts/build_arrow.py

# Build whole-flat rental evidence from the source already downloaded above
HDB_RENTAL_CSV=scripts/data/hdb_rental_raw.csv python scripts/build_rental.py
```

This creates `public/data/manifest.json` and content-hashed yearly Arrow files. The app loads only years required by the default or saved date filter, fetching older history when requested. Prices shown are actual transaction prices, without regression estimates or price-index adjustment.

**Note:** `geocode_pipeline.py` downloads the latest resale and rental CSVs from data.gov.sg by default. To test with local files, set `HDB_RESALE_CSV` and `HDB_RENTAL_CSV`.

### 3. Run Development Server

```bash
npm run dev
```

Open browser to http://localhost:5173/hdb_resale_map/

### 4. Build for Production

```bash
npm run build
```

Output will be in `dist/` directory, ready for deployment.

### Enable Saved homes

Use Node 24 for the Convex CLI. Run `npx convex dev` and select the existing Convex project to develop against your own deployment. Set the public `VITE_CONVEX_URL` in `.env.local` to that deployment's HTTPS URL. For GitHub Pages, set the repository Actions variable `VITE_CONVEX_URL` to the production deployment URL.

Set `SITE_URL` to the corresponding site URL, including `/hdb_resale_map/`. Configure `JWT_PRIVATE_KEY` and `JWKS` on each deployment using the [Convex Auth key setup](https://labs.convex.dev/auth/setup/manual#configure-private-and-public-key). Set `AUTH_RESEND_KEY` and `AUTH_RESEND_FROM` on the deployment using a Resend key and verified sender. Keep these server credentials and any deploy key out of the frontend and repository. The login form sends an eight-digit code to the user's email.

Run `npx convex deploy` from an authenticated terminal to release the backend. The GitHub Pages workflow uses the configured public URL at build time. The public transaction map also runs without a Convex configuration.

New sign-in codes share a deployment-wide budget of 60 requests per UTC day by default. Set the optional server-side `AUTH_OTP_DAILY_SEND_LIMIT` to an integer from 1 to 1,000 to match the deployment's mail budget. The count includes admitted requests that fail to deliver. A hashed client IP bucket can request up to 15 new codes per UTC day. Calls without an IP share one bucket with the same limit. Shorter send and verification limits also apply, and repeat requests preserve a code while it is valid.

IP-based limits depend on trustworthy request metadata. For a self-hosted deployment, restrict backend access to a trusted proxy that replaces forwarded IP headers. The shared deployment budget applies across source buckets. [Convex request metadata](https://docs.convex.dev/api/modules/server#requestmetadata)

Signed-in tracker mutations share a per-account budget of 120 per minute with capacity for a burst of 120. A backup restore can stage up to 50,000 records and 64 MiB. The hourly cleanup expires unfinished restores after 48 hours of inactivity. Some older in-progress uploads require a restart if the server cannot reconstruct their size within a bounded read.

## Project Structure

```
hdb_resale_map/
├── .github/workflows/
│   └── deploy.yml        # Refresh data and deploy GitHub Pages
├── scripts/              # Data pipeline (Python)
│   ├── geocode_pipeline.py   # Downloads data + geocodes addresses
│   ├── build_arrow.py        # Joins geocodes + exports yearly Arrow files
│   └── requirements.txt
├── public/data/          # Static data files served with the app
│   ├── manifest.json
│   ├── hdb_data_<year>-<hash>.arrow
│   ├── addresses_geocoded.json
│   └── upcoming_mop.geojson
├── src/                  # Web application (TypeScript)
│   ├── main.ts
│   ├── data/
│   │   └── DataLoader.ts
│   ├── map/
│   │   └── MapView.ts
│   ├── tools/
│   │   └── RadialSelection.ts
│   └── analytics/
│       └── AnalyticsPanel.ts
├── index.html
├── package.json
└── vite.config.ts
```

## Technologies

- **Map**: Deck.gl + MapLibre GL
- **Data Format**: Apache Arrow
- **Spatial Index**: RBush (R-Tree)
- **Charts**: Chart.js
- **Build**: Vite + TypeScript

## Rental yield and cash flow

The map's **Colour by** control supports monthly whole-flat rent, estimated rent per square foot, gross rental yield, and monthly property cash surplus alongside the existing resale price modes. Rental comparisons use one active flat type at a time. Open a block to compare its selected flat types and substitute a target purchase price, rent, floor area, or Annual Value.

All map metrics use a 5th–95th percentile color domain; monthly surplus is symmetric around zero. The scale-bar statistics toggle compares the global median, IQR, and count with the selected circle or rectangle without changing the color domain. Rental scale counts represent unique block/type estimates, while the rental Analytics overview summarizes the underlying source records.

The **heatmap** means the coloured map points, as defined in [GLOSSARY.md](GLOSSARY.md). The selected area persists while switching map metrics, palettes, active rental flat types or selection tools, so price and yield can be compared within the same circle or rectangle. Applying global filters or choosing Clear removes the selected area and its derived selection results.

Rental evidence comes from [HDB's owner-declared rental approvals](https://data.gov.sg/datasets/d_c9f57187485a850908655db0e8cfe651/view), joined to resale transactions by block, street and flat type. These are block/type estimates, not matches to individual units. The rental source contains neither floor area nor storey. Estimated rent PSF uses the median area of resale comparables; floor and lease filters affect purchase-price comparables only.

The default sample window starts in January of the preceding calendar year and ends in the latest month shared by resale and rental data. A same-block rental estimate needs five observations. Where evidence is thin, an estimate may use the same flat type within 500 metres and, when lease metadata exists for both blocks, a ten-year lease-commencement difference, with at least ten observations across three blocks. Identical rental rows are retained because the source has no unit identifiers. Invalid rents and extreme town/type outliers are excluded from estimates; the Analytics overview retains valid positive source rents without statistical outlier removal.

### Scenario assumptions

The default is a purchase today, five years of qualifying occupation, 75% LTV, a 25-year mortgage, illustrative 3% interest, no rent growth, and a 10% operating reserve. Assumptions are editable. The rental-period mortgage payment uses the balance after 60 payments and the remaining loan term, with a separate future interest rate. The 3% rate is a modelling assumption, not a bank quotation or a five-year forecast. 

- Gross yield on purchase cost is annual projected rent divided by the target price.
- Monthly property surplus deducts the full mortgage payment, operating reserve, and estimated non-owner-occupier property tax.
- Property tax uses current IRAS bands and an editable Annual Value; twelve times projected monthly rent is only a default proxy for Annual Value.
- Initial capital includes the equity contribution, Buyer's Stamp Duty and mortgage duty. Cash-flow return on initial capital excludes the first five years' holding cash flows and is not a total investment return.
- Mortgage principal repayment is shown separately as equity accumulation. It remains part of the cash payment but is not treated as an economic expense when describing returns.

The scenario assumes an eligible Singapore-citizen household and no Additional Buyer's Stamp Duty. It excludes personal income tax, CPF funding mechanics, renovation/legal costs, and alternative accommodation. The 10% reserve covers vacancy, agent fees, S&CC and repairs in aggregate; it is not a property-specific expense forecast.

Sources: [HDB resale MOP](https://www.hdb.gov.sg/managing-my-home/selling-a-flat/eligibility), [HDB rental restrictions](https://www.hdb.gov.sg/buying-a-flat/bto-sbf-and-open-booking-of-flats/conditions-after-buying-a-new-flat), [IRAS property tax](https://www.iras.gov.sg/quick-links/tax-rates/property-tax-rates), [BSD](https://www.iras.gov.sg/taxes/stamp-duty/for-property/buying-or-acquiring-property/buyer's-stamp-duty-(bsd)), [mortgage duty](https://www.iras.gov.sg/taxes/stamp-duty/for-property/buying-or-acquiring-property/mortgage-duty).

## Data Updates

Data is automatically refreshed every Friday via GitHub Actions (`deploy.yml`). Pushes to `main` and manual dispatches run the same fresh-data deployment, preventing a code deployment from restoring an older snapshot. The workflow:

1. Downloads the latest HDB resale and whole-flat rental transactions from [data.gov.sg](https://data.gov.sg)
2. Geocodes the union of new resale and rental addresses via the OneMap API
3. Rebuilds yearly Arrow files and the manifest from the full dataset, removing obsolete partitions
4. Reuses the downloaded approvals to rebuild the schema-v2 rental location dictionary, snapshot, and manifest; publication requires greater than 99.5% resolved row coverage
5. Runs the Python and TypeScript test suites, builds the site, and uploads the generated files directly in the GitHub Pages artifact

Generated rental snapshots are ignored by Git and never committed. GitHub Actions caches the latest geocode lookup and rental asset between runs as a performance optimization; the tracked geocode lookup remains a fallback if that cache expires. A failed refresh does not replace the currently deployed Pages site.

To trigger a manual update, use the **workflow_dispatch** option in the GitHub Actions tab.

## License

MIT
