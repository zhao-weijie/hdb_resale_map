# Project Structure - Current State

## ✅ Everything is set up correctly!

Your folder structure is actually fine - the data ended up in `scripts/data/` instead of the root `data/`, but that doesn't matter since you've already copied the Arrow file to where it needs to be.

```
hdb_resale_map/
├── scripts/                          # Python data pipeline
│   ├── .env                          # OneMap credentials (gitignored)
│   ├── .onemap_token.json           # Token cache (gitignored)
│   ├── geocode_pipeline.py
│   ├── build_arrow.py
│   ├── requirements.txt
│   ├── data/                         # Generated data files (HERE, not root)
│   │   ├── addresses_geocoded.json  # 2.46 MB
│   │   ├── hdb_resale_raw.csv       # 23 MB  
│   │   ├── hdb_data.arrow          # 25.2 MB ✓
│   │   └── hdb_data.parquet        # 4.2 MB (alternative)
│   └── ResaleflatpricesbasedonregistrationdatefromJan2017onwards.csv
│
├── public/                           # Static assets for web app
│   └── data/
│       └── hdb_data.arrow           # 25.2 MB ✓ COPIED HERE - WEB APP WILL LOAD THIS
│
├── src/                              # TypeScript source code
│   ├── main.ts
│   ├── style.css
│   ├── data/
│   │   └── DataLoader.ts
│   ├── map/
│   │   └── MapView.ts
│   ├── tools/
│   │   └── RadialSelection.ts
│   └── analytics/
│       └── AnalyticsPanel.ts
│
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md
└── Requirements.md
```

## ✅ Key Points

1. **Data pipeline output** → `scripts/data/` (works fine from scripts directory)
2. **Web app data** → `public/data/hdb_data.arrow` ✓ **Already copied!**
3. **Source code** → `src/` with all modules in place

## Next Steps

You're ready to run the web app! Just:

```bash
# Install Node dependencies (if not done yet)
npm install

# Start dev server
npm run dev
```

Then open http://localhost:5173 to see your HDB Resale Analytics map!
