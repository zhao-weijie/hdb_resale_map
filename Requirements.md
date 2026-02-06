#Product Requirement Document: HDB Resale Analytics SPA
1. Project Overview
Objective: Build a high-performance, client-side Single Page Application (SPA) that overlays the 2017–Present HDB Resale dataset onto a map of Singapore. Core Value: Enable prospective buyers to define custom geographic areas (circular or street-aligned) to analyze price trends, volume, and value-for-money metrics without server-side latency.

2. User Persona
The Savvy Buyer (27–40 years old):

Motivation: Wants to maximize "bang for buck" (Good location/amenities vs. price).

Anxiety: Fears buying at a market peak or purchasing a "value trap" (rapidly depreciating lease).

Behavior: Detail-oriented. Wants to compare specific clusters of blocks against the general town average.

3. Functional Requirements
3.1 Data Pipeline & Ingestion
Source Data: HDB Resale Prices (CSV format). Scope: Jan 2017 to Present.

Geocoding: System must include a pre-processing script to map "Block + Street Name" to Latitude/Longitude.

Calculated Fields: The pipeline must generate Price per SQM and Price per SQFT and Remaining Lease (Years) for all records before visualization.

Updatability: The application must support data updates by simply replacing the source data file/asset, without requiring code refactoring.

3.2 Map Visualization
Base Map: High-contrast, clean map of Singapore (e.g., OneMap or similar dark/light mode suited for data overlay).

Desktop View: Render individual transaction points. Color coding should represent Resale Price or Price psf (user toggleable).

Mobile View: Render a density heatmap only. Overlay a modal/banner advising the user to visit the desktop site for granular analysis.

3.3 Spatial Querying (Desktop Only)
Interaction Model: Users draw a shape on the map to "filter" the dataset. The selection persists until cleared.

Shape A: Radial Selection: User clicks a center point and drags to define a radius (e.g., "Within 500m of this MRT").

Shape B: Oriented Bounding Box: User defines a rectangular selection that must be rotatable.

Rationale: HDB blocks are often aligned to a street grid that is diagonal to the North-South axis. Standard bounding boxes are insufficient.

Visual Feedback: The selected area must be visually distinct (highlighted), and points outside the area should visually recede (dimmed or hidden).

3.4 Analytics & Charting
Trigger: Analysis generation is discrete (User clicks "Analyze Selection" or "Refresh"). It is not real-time as the user draws (to prevent UI jank).

Primary Visualization: Time-series line/area chart.

X-Axis: Time (Month/Year).

Y-Axis: Toggle between Resale Price and Price psf.

Multi-Dimensional Analysis:

The user must be able to segment the data by Storey Range, Floor Area, or Remaining Lease.

Stretch Goal: A 3D Scatter or Bubble chart plotting Price (Y) vs Lease Remaining (X) vs Floor Area (Size).

4. Technical Constraints & Performance Contracts
4.1 Rendering & Performance
Rendering Engine: Must use WebGL (or WebGPU) to render 100,000+ points. DOM-based rendering (SVG/Divs for points) is strictly prohibited due to performance costs.

Frame Rate: Map panning/zooming must maintain 60fps on average consumer hardware.

Latency: Calculation of analytics for a selected subset (e.g., 1,000 points) must be near-instant (<200ms) on the client side.

4.2 Data Strategy
Loading Strategy: The application must not load the raw CSV into the browser memory. It must utilize a binary, tiled, or compressed format (e.g., Protocol Buffers, Vector Tiles, or Parquet) to allow efficient querying of the >20MB dataset.

Spatial Indexing: Spatial queries (Point-in-Polygon) must utilize a spatial index (e.g., R-Tree, Quadtree, or KD-Tree) to ensure O(log n) search performance.

4.3 Hosting & Operations
Cost: $0 operational cost.

Architecture: 100% Static. No backend API servers. No database instances.

Platform: Must be deployable to GitHub Pages, Vercel, or Netlify.

5. Implementation Roadmap (Agent Instructions)
Data Prep Script (Python/Node): Create a script to fetch the HDB CSV, geocode it against OneMap API, and convert it into the required optimized binary/tiled format.

Core Map (SPA): Initialize the WebGL map engine. Load the optimized data layer.

Selection Logic: Implement the drawing tools (specifically the rotatable box) and the spatial indexing logic to filter the visible data.

Analytics Module: Build the charting engine to ingest the filtered data and render the time-series trends.

Mobile Guardrails: Implement the viewport width check to switch between "Interactive Mode" (Desktop) and "Heatmap Mode" (Mobile).