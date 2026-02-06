import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';
import { ScatterplotLayer } from '@deck.gl/layers';
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import maplibregl from 'maplibre-gl';

export type ColorMode = 'price' | 'price_psf';

export class MapView {
    private map: maplibregl.Map | null = null;
    private deckOverlay: MapboxOverlay | null = null;
    private dataLoader: DataLoader;
    private containerElement: HTMLElement;
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

        this.map.addControl(new maplibregl.NavigationControl());

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
     * Set callback for map movement (pan/zoom)
     */
    setOnMapMove(callback: () => void): void {
        this.map?.on('move', callback);
        this.map?.on('moveend', callback); // Ensure final state is captured
    }

    private createLayer() {
        const allData = this.dataLoader.getAllData();
        const dataToRender = this.selectedTransactions ?? allData;

        const layers: any[] = [];

        // Stack overflow fix included
        const getValue = this.colorMode === 'price'
            ? (d: HDBTransaction) => d.resale_price
            : (d: HDBTransaction) => d.price_psf;

        let minValue = Infinity;
        let maxValue = -Infinity;
        for (const d of dataToRender) {
            const value = getValue(d);
            if (value < minValue) minValue = value;
            if (value > maxValue) maxValue = value;
        }

        // Unified visualization for Desktop & Mobile
        // Heatmap proved problematic on mobile (color saturation), so we use Scatterplot everywhere
        layers.push(new ScatterplotLayer({
            id: 'scatterplot-layer',
            data: dataToRender,
            getPosition: (d: HDBTransaction) => [d.longitude, d.latitude],
            getRadius: this.isMobile ? 65 : 50, // Slightly larger on mobile for visibility
            getFillColor: (d: HDBTransaction) => {
                const value = getValue(d);
                const normalized = (value - minValue) / (maxValue - minValue);

                if (normalized < 0.5) {
                    const t = normalized * 2;
                    return [0, Math.floor(191 * t + 64), Math.floor(255 - 191 * t)];
                } else {
                    const t = (normalized - 0.5) * 2;
                    return [Math.floor(255 * t), Math.floor(255 - 191 * t), 0];
                }
            },
            opacity: this.selectedTransactions ? 0.8 : 0.6,
            pickable: true,
            radiusMinPixels: this.isMobile ? 3 : 2,
            radiusMaxPixels: 30,
            onHover: (info) => {
                if (info.object) {
                    const d = info.object as HDBTransaction;
                }
            },
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

        return layers;
    }

    private selectionCircle: { position: [number, number], radius: number } | null = null;

    updateSelectionCircle(centerLat: number, centerLng: number, radiusMeters: number): void {
        this.selectionCircle = { position: [centerLng, centerLat], radius: radiusMeters };
        this.updateLayers();
    }

    clearSelectionCircle(): void {
        this.selectionCircle = null;
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
