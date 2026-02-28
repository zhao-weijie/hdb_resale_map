# HDB Resale Analytics SPA

An interactive, high-performance map visualization of Singapore HDB resale transactions (2017-present) with spatial querying and time-series analytics.

## Features

- 🗺️ **WebGL Map Visualization** - Renders 100,000+ transactions smoothly using Deck.gl
- 🎯 **Radial Selection** - Draw circular areas to analyze specific neighborhoods
- 📊 **Time-Series Analytics** - View price trends over time
- 📱 **Mobile-Optimized** - Heatmap view for mobile devices
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

# Build Arrow data file (~1 min)
python scripts/build_arrow.py
```

This creates `public/data/hdb_data.arrow` which the web app loads.

**Note:** `geocode_pipeline.py` will automatically download the latest HDB resale CSV and resale price index from data.gov.sg if no local CSV is found. To use a local CSV instead, place it in `scripts/` as `ResaleflatpricesbasedonregistrationdatefromJan2017onwards.csv`.

### 3. Run Development Server

```bash
npm run dev
```

Open browser to http://localhost:5173

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
│   ├── build_arrow.py        # Joins geocodes + exports Arrow file
│   └── requirements.txt
├── public/data/          # Static data files served with the app
│   ├── hdb_data.arrow
│   ├── hdb_data.parquet
│   ├── addresses_geocoded.json
│   └── HDBResalePriceIndex1Q2009100Quarterly.csv
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

1. Downloads the latest HDB resale transactions and price index from [data.gov.sg](https://data.gov.sg)
2. Geocodes any new addresses via the OneMap API (typically none — all HDB blocks are already cached)
3. Rebuilds `public/data/hdb_data.arrow` from the full dataset (~1 min)
4. Commits changed files and pushes to `main`, triggering a redeployment

To trigger a manual update, use the **workflow_dispatch** option in the GitHub Actions tab.

## License

MIT
