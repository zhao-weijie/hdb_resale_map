import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PolygonLayer } from '@deck.gl/layers';
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import maplibregl from 'maplibre-gl';

export type ColorMode = 'price' | 'price_psf';

export class MapView {
    private map: maplibregl.Map | null = null;
    private deckOverlay: MapboxOverlay | null = null;
    private dataLoader: DataLoader;
    private containerElement: HTMLElement;
    private selectionCircle: any = null;
    private selectionRect: any = null;

    private isMobile: boolean;
    private colorMode: ColorMode = 'price_psf';
    private selectedTransactions: HDBTransaction[] | null = null;

    constructor(containerId: string, dataLoader: DataLoader, isMobile: boolean) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Container ${containerId} not found`);
        }
        this.containerElement = container;
        this.dataLoader = dataLoader;
        this.isMobile = isMobile;
    }

    async initialize(): Promise<void> {
        // Singapore center coordinates
        const SINGAPORE_CENTER = { longitude: 103.8198, latitude: 1.3521 };

        // 1. Initialize MapLibre directly (owns the context)
        this.map = new maplibregl.Map({
            container: this.containerElement,
            style: 'https://www.onemap.gov.sg/maps/json/raster/mbstyle/Grey.json',
            center: [SINGAPORE_CENTER.longitude, SINGAPORE_CENTER.latitude],
            zoom: 11,
            pitch: 0,
            bearing: 0,
            attributionControl: false, // We'll add it manually
            maxBounds: [
                [103.55, 1.13], // Southwest coordinates
                [104.15, 1.49]  // Northeast coordinates
            ]
        });

        // Add attribution manually since OneMap style might miss it
        this.map.addControl(new maplibregl.AttributionControl({
            customAttribution: 'Map data © <a href="https://www.onemap.gov.sg/" target="_blank">OneMap</a>'
        }));

        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

        // 2. Initialize Deck.gl Overlay
        this.deckOverlay = new MapboxOverlay({
            interleaved: true, // Optimizes rendering
            layers: [this.createLayer()]
        });

        // 3. Add Overlay to Map
        this.map.addControl(this.deckOverlay as any);

        // Wait for map load
        await new Promise<void>((resolve) => {
            this.map?.on('load', () => resolve());
        });

        console.log("✓ Map initialized with OneMap basemap");
    }

    /**
     * Enable/disable selection mode (changes cursor)
     */
    setSelectionMode(active: boolean): void {
        if (active) {
            this.containerElement.classList.add('selection-active');
            this.map?.dragPan.disable();
        } else {
            this.containerElement.classList.remove('selection-active');
            this.map?.dragPan.enable();
        }
    }

    /**
     * Set callbacks for drag selection interaction
     */
    setOnDragSelection(callbacks: {
        onStart: (lat: number, lng: number) => void;
        onMove: (lat: number, lng: number) => void;
        onEnd: (lat: number, lng: number) => void;
    }): void {
        if (!this.map) return;

        const canvas = this.map.getCanvas();
        let isDragging = false;

        this.map.on('mousedown', (e) => {
            if (canvas.style.cursor === 'crosshair' || this.containerElement.classList.contains('selection-active')) {
                // Ensure we only trigger if we are in selection mode
                // Double check class or passed state? 
                // We rely on setSelectionMode being called first.
                // The cursor check is a good proxy.
                if (this.containerElement.classList.contains('selection-active')) {
                    isDragging = true;
                    this.map?.dragPan.disable();
                    callbacks.onStart(e.lngLat.lat, e.lngLat.lng);
                }
            }
        });

        this.map.on('mousemove', (e) => {
            if (isDragging) {
                callbacks.onMove(e.lngLat.lat, e.lngLat.lng);
            }
        });

        const endDrag = (e: any) => {
            if (isDragging) {
                isDragging = false;
                callbacks.onEnd(e.lngLat.lat, e.lngLat.lng);
            }
        };

        this.map.on('mouseup', endDrag);
    }

    /**
     * Get current map bounds
     */
    getBounds(): { north: number, south: number, east: number, west: number } | null {
        if (!this.map) return null;
        const bounds = this.map.getBounds();
        return {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
    }

    getIsMobile(): boolean {
        return this.isMobile;
    }

    /**
     * Set selection type (radial or rect)
     */
    setSelectionType(_type: 'radial' | 'rect'): void {
        // this.selectionType = type;
        // Logic to switch visual cues (e.g. cursor, shapes)
    }

    /**
     * Fly to specific location
     */
    flyTo(lat: number, lng: number): void {
        this.map?.flyTo({
            center: [lng, lat],
            zoom: 15,
            essential: true
        });
    }

    /**
     * Update map with filtered data
     */
    setFilteredData(transactions: import('../data/DataLoader').HDBTransaction[]): void {
        if (!this.map) return;

        // Convert to GeoJSON
        const geojson: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: transactions.map(t => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [t.longitude, t.latitude]
                },
                properties: {
                    ...t,
                    // Ensure numeric content for data-driven styling if needed
                    resale_price: t.resale_price,
                    price_psf: t.price_psf
                }
            }))
        };

        const source = this.map.getSource('transactions') as maplibregl.GeoJSONSource;
        if (source) {
            source.setData(geojson);
        }
    }

    /**
     * Set callback for map movement (pan/zoom)
     */
    setOnMapMove(callback: () => void): void {
        this.map?.on('move', callback);
        this.map?.on('moveend', callback); // Ensure final state is captured
    }

    private createLayer() {
        const allData = this.dataLoader.getAllData();

        const layers: any[] = [];

        // Always color by the selected mode
        const getValue = this.colorMode === 'price'
            ? (d: HDBTransaction) => d.resale_price
            : (d: HDBTransaction) => d.price_psf;

        let minValue = Infinity;
        let maxValue = -Infinity;
        for (const d of allData) {
            const value = getValue(d);
            if (value < minValue) minValue = value;
            if (value > maxValue) maxValue = value;
        }

        // When there's a selection, show unselected data as faded
        const selectedSet = this.selectedTransactions
            ? new Set(this.selectedTransactions.map(t => `${t.latitude}-${t.longitude}-${t.resale_price}`))
            : null;

        // Unified visualization for Desktop & Mobile
        layers.push(new ScatterplotLayer({
            id: 'scatterplot-layer',
            data: allData,
            getPosition: (d: HDBTransaction) => [d.longitude, d.latitude],
            getRadius: this.isMobile ? 65 : 50,
            getFillColor: (d: HDBTransaction) => {
                const value = getValue(d);
                const normalized = (value - minValue) / (maxValue - minValue);

                let rgba: [number, number, number, number];
                if (normalized < 0.5) {
                    const t = normalized * 2;
                    rgba = [0, Math.floor(191 * t + 64), Math.floor(255 - 191 * t), 255];
                } else {
                    const t = (normalized - 0.5) * 2;
                    rgba = [Math.floor(255 * t), Math.floor(255 - 191 * t), 0, 255];
                }

                // Fade out unselected points when there's a selection
                if (selectedSet && !selectedSet.has(`${d.latitude}-${d.longitude}-${d.resale_price}`)) {
                    rgba[3] = 60; // Make unselected very transparent
                }
                return rgba;
            },
            opacity: 1, // Use RGBA alpha instead
            pickable: true,
            radiusMinPixels: this.isMobile ? 3 : 2,
            radiusMaxPixels: 30,
            onHover: () => { },
        }));

        // Add selection circle if active
        if (this.selectionCircle) {
            layers.push(
                new ScatterplotLayer({
                    id: 'selection-circle',
                    data: [this.selectionCircle],
                    pickable: false,
                    stroked: true,
                    filled: true,
                    getFillColor: [59, 130, 246, 40], // Light blue transparent
                    getLineColor: [59, 130, 246, 255], // Solid blue border
                    getLineWidth: 2,
                    lineWidthMinPixels: 2,
                    getPosition: (d: any) => d.position,
                    getRadius: (d: any) => d.radius,
                    radiusUnits: 'meters'
                })
            );
        }



        // Add selection rectangle if active
        if (this.selectionRect) {
            layers.push(
                new PolygonLayer({
                    id: 'selection-rect',
                    data: [this.selectionRect],
                    pickable: false,
                    stroked: true,
                    filled: true,
                    getFillColor: [59, 130, 246, 40],
                    getLineColor: [59, 130, 246, 255],
                    getLineWidth: 2,
                    lineWidthMinPixels: 2,
                    getPolygon: (d: any) => d.polygon,
                })
            );
        }

        return layers;
    }


    updateSelectionCircle(centerLat: number, centerLng: number, radiusMeters: number): void {
        this.selectionCircle = { position: [centerLng, centerLat], radius: radiusMeters };
        // Clear rect when updating circle
        this.selectionRect = null;
        this.updateLayers();
    }

    updateSelectionRect(startLat: number, startLng: number, endLat: number, endLng: number): void {
        const minLng = Math.min(startLng, endLng);
        const maxLng = Math.max(startLng, endLng);
        const minLat = Math.min(startLat, endLat);
        const maxLat = Math.max(startLat, endLat);

        this.selectionRect = {
            polygon: [
                [minLng, minLat],
                [maxLng, minLat],
                [maxLng, maxLat],
                [minLng, maxLat]
            ]
        };
        // Clear circle when updating rect
        this.selectionCircle = null;
        this.updateLayers();
    }

    clearSelectionCircle(): void {
        this.selectionCircle = null;
        this.updateLayers();
    }

    clearSelectionRect(): void {
        this.selectionRect = null;
        this.updateLayers();
    }

    setColorMode(mode: ColorMode): void {
        this.colorMode = mode;
        this.updateLayers();
    }

    setSelectedTransactions(transactions: HDBTransaction[] | null): void {
        this.selectedTransactions = transactions;
        this.updateLayers();
    }

    private updateLayers(): void {
        if (this.deckOverlay) {
            this.deckOverlay.setProps({
                layers: [this.createLayer()],
            });
        }
    }

    getColorMode(): ColorMode {
        return this.colorMode;
    }
}
