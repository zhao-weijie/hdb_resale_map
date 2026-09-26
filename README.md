# HDB Resale Analytics SPA

An interactive, high-performance map visualization of Singapore HDB resale transactions (2017-present) with spatial querying and time-series analytics.

## Features

- 🗺️ **WebGL Map Visualization** - Renders 100,000+ transactions smoothly using Deck.gl
- 🎯 **Radial Selection** - Draw circular areas to analyze specific neighborhoods
- 📊 **Time-Series Analytics** - View price trends over time
- 📱 **Mobile-Optimized** - Map and viewport statistics for mobile devices
- 💾 **100% Static** - Client-side only, deployable to GitHub Pages/Vercel/Netlify
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

# Build whole-flat rental evidence
python scripts/build_rental.py
```

This creates `public/data/manifest.json` and content-hashed yearly Arrow files. The app loads only years required by the default or saved date filter, fetching older history when requested. Prices shown are actual transaction prices, without regression estimates or price-index adjustment.

**Note:** `geocode_pipeline.py` downloads the latest HDB resale CSV from data.gov.sg by default. To test with a local CSV instead, set `HDB_RESALE_CSV=/path/to/file.csv`.

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

Rental evidence comes from [HDB's owner-declared rental approvals](https://data.gov.sg/datasets/d_c9f57187485a850908655db0e8cfe651/view), joined to resale transactions by block, street and flat type. These are block/type estimates, not matches to individual units. The rental source contains neither floor area nor storey. Estimated rent PSF uses the median area of resale comparables; floor and lease filters affect purchase-price comparables only.

The default sample window starts in January of the preceding calendar year and ends in the latest month shared by resale and rental data. A same-block rental estimate needs five observations. Where evidence is thin, a labelled estimate may use the same flat type within 500 metres and a ten-year lease-commencement difference, with at least ten observations across three blocks. Identical rental rows are retained because the source has no unit identifiers. Invalid rents and extreme town/type outliers are excluded; evidence counts and ranges remain visible.

### Scenario assumptions

The default is a purchase today, five years of qualifying occupation, 75% LTV, a 25-year mortgage, illustrative 3% interest, no rent growth, and a 10% operating reserve. Assumptions are editable. The rental-period mortgage payment uses the balance after 60 payments and the remaining loan term, with a separate future interest rate. The 3% rate is a modelling assumption, not a bank quotation or a five-year forecast. Consult [bank package information](https://www.dbs.com.sg/personal/loans/homeloans/hdb-loan) and substitute your own quotation.

- Gross yield on purchase cost is annual projected rent divided by the target price.
- Monthly property surplus deducts the full mortgage payment, operating reserve, and estimated non-owner-occupier property tax.
- Property tax uses current IRAS bands and an editable Annual Value; twelve times projected monthly rent is only a default proxy for Annual Value.
- Initial capital includes the equity contribution, Buyer's Stamp Duty and mortgage duty. Cash-flow return on initial capital excludes the first five years' holding cash flows and is not a total investment return.
- Mortgage principal repayment is shown separately as equity accumulation. It remains part of the cash payment but is not treated as an economic expense when describing returns.

The scenario assumes an eligible Singapore-citizen household and no Additional Buyer's Stamp Duty. It excludes personal income tax, CPF funding mechanics, renovation/legal costs, and alternative accommodation. The 10% reserve covers vacancy, agent fees, S&CC and repairs in aggregate; it is not a property-specific expense forecast.

Whole-flat rental depends on the buyer's own MOP and HDB approval. Plus, Prime and PLH flats prohibit whole-flat rental even after MOP. Unknown project classifications remain explicitly unverified; past rental observations are not proof of eligibility. The existing upcoming-MOP overlay is not used to determine a new buyer's rental start date.

Sources: [HDB resale MOP](https://www.hdb.gov.sg/managing-my-home/selling-a-flat/eligibility), [HDB rental restrictions](https://www.hdb.gov.sg/buying-a-flat/bto-sbf-and-open-booking-of-flats/conditions-after-buying-a-new-flat), [IRAS property tax](https://www.iras.gov.sg/quick-links/tax-rates/property-tax-rates), [BSD](https://www.iras.gov.sg/taxes/stamp-duty/for-property/buying-or-acquiring-property/buyer's-stamp-duty-(bsd)), [mortgage duty](https://www.iras.gov.sg/taxes/stamp-duty/for-property/buying-or-acquiring-property/mortgage-duty).

## Data Updates

Data is automatically refreshed every Friday via GitHub Actions (`deploy.yml`). Pushes to `main` and manual dispatches run the same fresh-data deployment, preventing a code deployment from restoring an older snapshot. The workflow:

1. Downloads the latest HDB resale transactions from [data.gov.sg](https://data.gov.sg)
2. Geocodes any new addresses via the OneMap API (typically none — all HDB blocks are already cached)
3. Rebuilds yearly Arrow files and the manifest from the full dataset, removing obsolete partitions
4. Downloads whole-flat rental approvals and rebuilds the content-hashed rental snapshot and manifest
5. Runs the Python and TypeScript test suites, builds the site, and uploads the generated files directly in the GitHub Pages artifact

Generated rental snapshots are ignored by Git and never committed. GitHub Actions caches the latest geocode lookup and rental asset between runs as a performance optimization; the tracked geocode lookup remains a fallback if that cache expires. A failed refresh does not replace the currently deployed Pages site.

To trigger a manual update, use the **workflow_dispatch** option in the GitHub Actions tab.

## License

MIT
