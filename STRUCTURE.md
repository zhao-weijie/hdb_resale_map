# Project Structure - Current State

## ✅ Everything is set up correctly!

Raw CSV input is cached in `scripts/data/`. The pipeline writes the manifest and yearly Arrow files directly to `public/data/`.

```
hdb_resale_map/
├── scripts/                          # Python data pipeline
│   ├── .env                          # OneMap credentials (gitignored)
│   ├── .onemap_token.json           # Token cache (gitignored)
│   ├── geocode_pipeline.py
│   ├── build_arrow.py
│   ├── requirements.txt
│   ├── data/                         # Generated raw data cache (HERE, not root)
│   │   └── hdb_resale_raw.csv       # 23 MB
│   └── ResaleflatpricesbasedonregistrationdatefromJan2017onwards.csv
│
├── public/                           # Static assets for web app
│   └── data/
│       ├── manifest.json            # Year URLs and metadata
│       └── hdb_data_<year>-<hash>.arrow # Yearly transaction partitions
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

1. **Raw data cache** → `scripts/data/` (works fine from scripts directory)
2. **Web app data** → `public/data/manifest.json` and the yearly Arrow files
3. **Source code** → `src/` with all modules in place

## Next Steps

You're ready to run the web app! Just:

```bash
# Install Node dependencies (if not done yet)
npm install

# Start dev server
npm run dev
```

Then open http://localhost:5173/hdb_resale_map/ to see your HDB Resale Analytics map!
