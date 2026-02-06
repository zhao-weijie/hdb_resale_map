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
# Run geocoding pipeline (takes ~1 hour first time)
cd scripts
python geocode_pipeline.py

# Build Arrow data file
python build_arrow.py
```

This will create `data/hdb_data.arrow` which the web app loads.

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
├── scripts/              # Data pipeline (Python)
│   ├── geocode_pipeline.py
│   ├── build_arrow.py
│   └── requirements.txt
├── data/                 # Generated data files
│   ├── hdb_data.arrow   # Main data (created by pipeline)
│   └── addresses_geocoded.json
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
├── public/               # Static assets
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

To update with the latest HDB data:

1. Replace `ResaleflatpricesbasedonregistrationdatefromJan2017onwards.csv` with the new file
2. Run `python scripts/geocode_pipeline.py` (only new addresses will be geocoded)
3. Run `python scripts/build_arrow.py`
4. Copy `data/hdb_data.arrow` to `public/data/` directory
5. Rebuild the app: `npm run build`

## License

MIT
