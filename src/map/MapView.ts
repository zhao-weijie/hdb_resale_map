import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PolygonLayer, GeoJsonLayer } from '@deck.gl/layers';
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import maplibregl from 'maplibre-gl';
import { appState } from '../state/AppState';
import { buildColorLookup, type ColorScale } from '../components/ColorScaleBar';
import { getTransactionStats } from '../utils/transactionStats';


export type ColorMode = 'price' | 'price_psf' | 'rent' | 'rent_psf' | 'gross_yield' | 'monthly_surplus';
export interface RentalMapPoint {
    block: string;
    streetName: string;
    flatType: string;
    latitude: number;
    longitude: number;
    /** Values are null for a known block with insufficient rental evidence. */
    rent: number | null;
    rentPsf: number | null;
    grossYield: number | null;
    monthlySurplus: number | null;
    provenance?: 'same_block' | 'nearby' | 'insufficient';
    [key: string]: unknown;
}

export class MapView {
    private map: maplibregl.Map | null = null;
    private deckOverlay: MapboxOverlay | null = null;
    private containerElement: HTMLElement;
    private selectionCircle: any = null;
    private selectionRect: any = null;
    private mopData: any = null; // Store MOP GeoJSON data
    private mopLoadPromise: Promise<void> | null = null;

    private rangeData: HDBTransaction[] | null = null;
    private rangeMode: ColorMode | null = null;
    private rangeMin = 0;
    private rangeMax = 0;
    private selectedData: HDBTransaction[] | null = null;
    private selectedItems: Set<HDBTransaction> | null = null;

    private isMobile: boolean;
    private onPointClickCallback: ((lat: number, lng: number, transaction: HDBTransaction) => void) | null = null;
    private colorLookup: [number, number, number][] = buildColorLookup('viridis');
    private rentalPoints: RentalMapPoint[] = [];
    private rentalDomain: { min: number; max: number; extent?: number } | null = null;
    private onRentalPointClickCallback: ((point: RentalMapPoint) => void) | null = null;

    constructor(containerId: string, _dataLoader: DataLoader, isMobile: boolean) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Container ${containerId} not found`);
        }
        this.containerElement = container;
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

        // Custom click handler for closing popups
        this.map.on('click', () => {
            if (this.activePopup && Date.now() - this.lastPopupTime > 200) {
                this.activePopup.remove();
                this.activePopup = null;
            }
        });
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

        // 2. Initialize Deck.gl Overlay
        this.deckOverlay = new MapboxOverlay({
            interleaved: true, // Optimizes rendering
            layers: this.createLayers()
        });

        // 3. Add Overlay to Map
        this.map.addControl(this.deckOverlay as any);

        // Wait for map load
        await new Promise<void>((resolve) => {
            this.map?.on('load', () => resolve());
        });

        // Subscribe to MOP state changes
        appState.subscribe('displayMopExpiries', (enabled) => {
            if (enabled) void this.loadMopData();
            else this.setMopStatus('');
            this.updateLayers();
        });
        appState.subscribe('mopExpiryDateRange', () => this.updateLayers());
        appState.subscribe('mopProjectTypes', () => this.updateLayers());

        if (appState.get('displayMopExpiries')) void this.loadMopData();

        // Rebuild color lookup table when the scale changes
        appState.subscribe('colorScale', (scale: ColorScale) => {
            this.colorLookup = buildColorLookup(scale);
            this.updateLayers();
        });
        appState.subscribe('colorMode', () => this.updateLayers());
        appState.subscribe('rentalActiveFlatType', () => this.updateLayers());

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
        appState.set('filteredTransactions', transactions);
        appState.set('selectedTransactions', null);
        this.selectedData = null;
        this.selectedItems = null;
        this.selectionCircle = null;
        this.selectionRect = null;
        this.updateLayers();
    }

    /**
     * Set callback for map movement (pan/zoom)
     */
    setOnMapMove(callback: () => void): void {
        this.map?.on('move', callback);
        this.map?.on('moveend', callback); // Ensure final state is captured
    }

    setOnPointClick(callback: (lat: number, lng: number, transaction: HDBTransaction) => void): void {
        this.onPointClickCallback = callback;
    }

    setOnRentalPointClick(callback: (point: RentalMapPoint) => void): void {
        this.onRentalPointClickCallback = callback;
    }

    setRentalPoints(points: RentalMapPoint[]): void {
        this.rentalPoints = points;
        this.updateLayers();
    }

    setRentalDomain(domain: { min: number; max: number; extent?: number } | null): void {
        this.rentalDomain = domain;
        this.updateLayers();
    }

    private createLayers() {
        const dataToRender = appState.get('filteredTransactions');

        const layers: any[] = [];


        // Price modes keep the original individual-transaction map. Rental modes
        // deliberately collapse to one marker per block so overlapping records do
        // not obscure the comparison the buyer is trying to make.
        const colorMode = appState.get('colorMode');
        if (colorMode !== 'price' && colorMode !== 'price_psf') {
            layers.push(...this.createRentalLayers(colorMode));
        } else {
        const getValue = colorMode === 'price'
            ? (d: HDBTransaction) => d.resale_price
            : (d: HDBTransaction) => d.price_psf;

        if (this.rangeData !== dataToRender || this.rangeMode !== colorMode) {
            this.rangeData = dataToRender;
            this.rangeMode = colorMode;
            const stats = getTransactionStats(dataToRender, colorMode);
            this.rangeMin = stats?.min ?? 0;
            this.rangeMax = stats?.max ?? 0;
        }
        const minValue = this.rangeMin;
        const maxValue = this.rangeMax;

        // When there's a selection, show unselected data as faded
        const selectedTransactions = appState.get('selectedTransactions');
        if (this.selectedData !== selectedTransactions) {
            this.selectedData = selectedTransactions;
            this.selectedItems = selectedTransactions
                ? new Set(selectedTransactions)
                : null;
        }
        const selectedSet = this.selectedItems;

        const colorScale = appState.get('colorScale');

        // Unified visualization for Desktop & Mobile
        layers.push(new ScatterplotLayer({
            id: 'scatterplot-layer',
            data: dataToRender,
            getPosition: (d: HDBTransaction) => [d.longitude, d.latitude],
            getRadius: this.isMobile ? 65 : 50,
            getFillColor: (d: HDBTransaction) => {
                const value = getValue(d);
                const normalized = maxValue === minValue
                    ? 0.5
                    : (value - minValue) / (maxValue - minValue);
                const idx = Math.floor(Math.max(0, Math.min(0.9999, normalized)) * 255);
                const [r, g, b] = this.colorLookup[idx];
                const alpha = selectedSet && !selectedSet.has(d)
                    ? 60  // Fade out unselected points when there's a selection
                    : 255;
                return [r, g, b, alpha] as [number, number, number, number];
            },
            // Tell Deck.gl to re-evaluate getFillColor whenever these change
            updateTriggers: {
                getFillColor: [minValue, maxValue, colorMode, colorScale, selectedTransactions]
            },
            opacity: 1, // Use RGBA alpha instead
            pickable: true,
            radiusMinPixels: this.isMobile ? 3 : 2,
            radiusMaxPixels: 30,
            onHover: (info: any) => {
                if (this.containerElement) {
                    this.containerElement.style.cursor = info.object ? 'pointer' : '';
                }
            },
            onClick: (info: any) => {
                if (info && info.object) {
                    if (this.onPointClickCallback) {
                        // Check selection mode state
                        const selectionActive = this.containerElement.classList.contains('selection-active');

                        if (!selectionActive) {
                            const d = info.object as HDBTransaction;
                            this.onPointClickCallback(d.latitude, d.longitude, d);
                            return true; // Stop propagation to map
                        }
                    }
                }
            }
        }));
        }

        // MOP Expiry Layer
        if (this.mopData && appState.get('displayMopExpiries')) {
            const dateRange = appState.get('mopExpiryDateRange');
            const projectTypes = appState.get('mopProjectTypes');

            // Filter features based on date range and project type
            const filteredFeatures = {
                type: "FeatureCollection",
                features: this.mopData.features.filter((f: any) => {
                    const expiry = f.properties.MOP_EXPIRY_DATE;
                    const type = f.properties.PROJECT_TYPE || 'Unknown';

                    const inDateRange = expiry >= dateRange[0] && expiry <= dateRange[1];
                    const inType = projectTypes.includes(type);

                    return inDateRange && inType;
                })
            };

            layers.push(
                new GeoJsonLayer({
                    id: 'mop-expiry-layer',
                    data: filteredFeatures as any,
                    pickable: true,
                    stroked: true,
                    filled: true,
                    getFillColor: [192, 38, 211, 160], // Bright Purple (Fuchsia-600)
                    getLineColor: [255, 255, 255, 200],
                    getLineWidth: 2,
                    lineWidthMinPixels: 1,
                    onClick: (info: any) => {
                        if (info && info.object) {
                            const props = info.object.properties;
                            const html = `
                                <div style="padding: 10px; min-width: 220px;">
                                    <h3 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 600;">${props.PROJECT_NAME}</h3>
                                    <div style="margin-bottom: 8px; font-size: 12px; color: #666;">
                                        ${props.BTO_NAME_SCRAPED ? `<span style="color: #059669;">✓ Verified: ${props.BTO_NAME_SCRAPED}</span>` : '<span style="color: #d97706;">⚠ Unverified Source</span>'}
                                    </div>
                                    
                                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin-bottom: 12px;">
                                        <strong>Type:</strong> <div>${props.PROJECT_TYPE || 'Unknown'}</div>
                                        <strong>Units:</strong> <div>${props.TOTAL_UNITS || 'N/A'}</div>
                                        <strong>MOP Expiry:</strong> <div>${props.MOP_EXPIRY_Q}</div>
                                        <div style="grid-column: 2; font-size: 11px; color: #888;">${props.MOP_EXPIRY_DATE}</div>
                                    </div>

                                    <div style="border-top: 1px solid #eee; padding-top: 8px;">
                                        ${props.BROCHURE_LINK ? `<a href="${props.BROCHURE_LINK}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 500;">View Brochure →</a>` : '<span style="color: #999; font-style: italic;">No Brochure</span>'}
                                    </div>
                                </div>
                            `;
                            this.showPopup(info.coordinate[1], info.coordinate[0], html);
                            return true;
                        }
                    }
                })
            );
        }

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

    private createRentalLayers(mode: Exclude<ColorMode, 'price' | 'price_psf'>): any[] {
        const selectedType = appState.get('rentalActiveFlatType');
        const points = this.rentalPoints.filter((point) => !selectedType || point.flatType === selectedType);
        const getValue = (point: RentalMapPoint): number | null => {
            if (mode === 'rent') return point.rent;
            if (mode === 'rent_psf') return point.rentPsf;
            if (mode === 'gross_yield') return point.grossYield;
            return point.monthlySurplus;
        };
        const values = points.map(getValue).filter((value): value is number =>
            typeof value === 'number' && Number.isFinite(value));
        const sorted = [...values].sort((a, b) => a - b);
        const percentile = (p: number) => {
            if (!sorted.length) return 0;
            const index = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p));
            const lower = Math.floor(index); const upper = Math.ceil(index);
            return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
        };
        const computedLow = percentile(.05);
        const computedHigh = percentile(.95);
        const low = this.rentalDomain?.min ?? computedLow;
        const high = this.rentalDomain?.max ?? computedHigh;
        const extent = this.rentalDomain?.extent ?? Math.max(Math.abs(low), Math.abs(high), 1);
        const color = (point: RentalMapPoint): [number, number, number, number] => {
            const value = getValue(point);
            if (value === null || value === undefined || !Number.isFinite(value)) return [151, 151, 151, 180];
            if (mode === 'monthly_surplus') {
                // Orange → neutral → blue, fixed at zero so profit/loss is legible.
                const ratio = Math.max(-1, Math.min(1, value / extent));
                if (ratio < 0) {
                    const t = ratio + 1;
                    return [Math.round(224 + 31 * t), Math.round(116 + 126 * t), Math.round(43 + 192 * t), 245];
                }
                return [Math.round(255 - 197 * ratio), Math.round(242 - 112 * ratio), Math.round(235 + 15 * ratio), 245];
            }
            const normalized = high === low ? .5 : Math.max(0, Math.min(1, (value - low) / (high - low)));
            const [r, g, b] = this.colorLookup[Math.min(255, Math.floor(normalized * 255))];
            return [r, g, b, 245];
        };
        const layers: any[] = [new ScatterplotLayer({
            id: 'rental-block-layer', data: points, pickable: true, stroked: false,
            getPosition: (d: RentalMapPoint) => [d.longitude, d.latitude],
            getRadius: this.isMobile ? 85 : 68,
            radiusMinPixels: this.isMobile ? 5 : 4, radiusMaxPixels: 28,
            getFillColor: color,
            updateTriggers: { getFillColor: [mode, low, high, extent, this.colorLookup] },
            onHover: (info: any) => { this.containerElement.style.cursor = info.object ? 'pointer' : ''; },
            onClick: (info: any) => {
                if (!info?.object || this.containerElement.classList.contains('selection-active')) return false;
                this.onRentalPointClickCallback?.(info.object as RentalMapPoint);
                return true;
            }
        })];
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

    clearSelectionGeometry(): void {
        if (!this.selectionCircle && !this.selectionRect) return;
        this.selectionCircle = null;
        this.selectionRect = null;
        this.updateLayers();
    }

    setColorMode(mode: ColorMode): void {
        appState.set('colorMode', mode);
        this.updateLayers();
    }

    setSelectedTransactions(transactions: HDBTransaction[] | null): void {
        appState.set('selectedTransactions', transactions);
        this.updateLayers();
    }

    private updateLayers(): void {
        if (this.deckOverlay) {
            this.deckOverlay.setProps({
                layers: this.createLayers(),
            });
        }
    }

    private loadMopData(): Promise<void> {
        if (this.mopData) {
            this.setMopStatus('');
            return Promise.resolve();
        }
        if (this.mopLoadPromise) return this.mopLoadPromise;

        this.setMopStatus('Loading MOP projects…');
        this.mopLoadPromise = fetch('data/upcoming_mop.geojson')
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this.mopData = await response.json();
                this.setMopStatus('');
                this.updateLayers();
                console.log('✓ MOP Data loaded');
            })
            .catch((error) => {
                this.setMopStatus('Could not load MOP projects. Toggle off and on to retry.', true);
                console.warn('Error loading MOP data', error);
            })
            .finally(() => {
                this.mopLoadPromise = null;
            });
        return this.mopLoadPromise;
    }

    private setMopStatus(message: string, isError = false): void {
        const status = document.getElementById('mop-load-status');
        if (!status) return;
        status.textContent = message;
        status.hidden = message.length === 0;
        status.classList.toggle('error-message', isError);
    }

    private activePopup: maplibregl.Popup | null = null;

    showPopup(lat: number, lng: number, htmlContent: string): void {
        console.log('MapView.showPopup called:', lat, lng);
        if (!this.map) {
            console.warn('MapView.showPopup: Map not initialized');
            return;
        }

        // Close existing popup if any
        if (this.activePopup) {
            this.activePopup.remove();
        }

        this.activePopup = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: false, // Keep false to prevent race conditions
            maxWidth: '320px',
            className: 'hdb-popup'
        })
            .setLngLat([lng, lat])
            .setHTML(htmlContent)
            .addTo(this.map);

        this.lastPopupTime = Date.now();
    }

    // Add this property to the class
    private lastPopupTime: number = 0;

    getColorMode(): ColorMode {
        return appState.get('colorMode');
    }

    addControl(control: maplibregl.IControl, position?: maplibregl.ControlPosition): void {
        this.map?.addControl(control, position);
    }
}
