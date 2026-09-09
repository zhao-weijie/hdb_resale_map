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
│   ├── deploy.yml        # Deploy to GitHub Pages on push to main
│   └── update-data.yml   # Auto-update data every Friday 00:00 UTC
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

## Data Updates

Data is automatically refreshed every Friday via GitHub Actions (`update-data.yml`). The workflow:

1. Downloads the latest HDB resale transactions from [data.gov.sg](https://data.gov.sg)
2. Geocodes any new addresses via the OneMap API (typically none — all HDB blocks are already cached)
3. Rebuilds yearly Arrow files and the manifest from the full dataset, removing obsolete partitions
4. Commits generated data changes to `main`; the deployment workflow runs after a successful update

To trigger a manual update, use the **workflow_dispatch** option in the GitHub Actions tab.

## License

MIT
