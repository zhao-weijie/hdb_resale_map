import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PolygonLayer, GeoJsonLayer } from '@deck.gl/layers';
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
// import { HeatmapLayer } from '@deck.gl/aggregation-layers'; // Removed
import type { DataLoader, HDBTransaction } from '../data/DataLoader';
import maplibregl from 'maplibre-gl';
import { appState } from '../state/AppState';
import { buildColorLookup, type ColorScale } from '../components/ColorScaleBar';
import { circleSelection, rectangleSelection, type SpatialSelection } from '../spatial/selection';
import { createMopPopup } from './mopPopup';
import {
    calculateMetricDomain,
    getMetricDefinition,
    metricValue,
    scaleScalar,
    type MapMetric,
    type ScaleDomain,
} from '../metrics';


export type ColorMode = MapMetric;
export interface SavedBlockPin {
    key: string;
    latitude: number;
    longitude: number;
    label: string;
    count: number;
    selected: boolean;
    open: (opener: HTMLButtonElement) => void;
}

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
    private mopData: any = null; // Store MOP GeoJSON data
    private mopLoadPromise: Promise<void> | null = null;

    private rangeData: HDBTransaction[] | null = null;
    private rangeMode: ColorMode | null = null;
    private resaleDomain: ScaleDomain | null = null;

    private isMobile: boolean;
    private onPointClickCallback: ((lat: number, lng: number, transaction: HDBTransaction) => void) | null = null;
    private colorLookup: [number, number, number][] = buildColorLookup('viridis');
    private rentalPoints: RentalMapPoint[] = [];
    private rentalDomain: ScaleDomain | null = null;
    private onRentalPointClickCallback: ((point: RentalMapPoint) => void) | null = null;
    private savedPins = new Map<string, { marker: maplibregl.Marker; button: HTMLButtonElement; pin: SavedBlockPin }>();
    private comparison: { selection: SpatialSelection; rows: HDBTransaction[]; camera?: maplibregl.CameraOptions } | null = null;

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

        // Keep the OneMap credit independent of attribution HTML in the remote style.
        const attribution = document.createElement('div');
        attribution.className = 'maplibregl-ctrl maplibregl-ctrl-attrib';
        const credit = document.createElement('a');
        credit.href = 'https://www.onemap.gov.sg/';
        credit.target = '_blank';
        credit.rel = 'noopener noreferrer';
        credit.textContent = 'OneMap';
        attribution.append('Map data © ', credit);
        this.map.addControl({
            onAdd: () => attribution,
            onRemove: () => attribution.remove(),
        }, 'bottom-left');

        // Custom click handler for closing popups
        this.map.on('click', () => {
            if (this.activePopup && Date.now() - this.lastPopupTime > 200) {
                this.activePopup.remove();
                this.activePopup = null;
            }
        });
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

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
        appState.subscribe('spatialSelection', () => this.updateLayers());

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

    setSavedBlockPins(pins: SavedBlockPin[]): void {
        if (!this.map) return;
        const keys = new Set(pins.map((pin) => pin.key));
        for (const [key, entry] of this.savedPins) {
            if (keys.has(key)) continue;
            entry.marker.remove();
            this.savedPins.delete(key);
        }
        for (const pin of pins) {
            let entry = this.savedPins.get(pin.key);
            if (!entry) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'saved-block-pin';
                button.innerHTML = '<svg aria-hidden="true" width="27" height="33" viewBox="0 0 27 33"><path d="M3 3h21v26l-10.5-6L3 29Z"/></svg><span aria-hidden="true"></span>';
                const marker = new maplibregl.Marker({ element: button, anchor: 'bottom' });
                entry = { marker, button, pin };
                this.savedPins.set(pin.key, entry);
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (!this.containerElement.classList.contains('selection-active')) this.savedPins.get(pin.key)?.pin.open(button);
                });
                marker.setLngLat([pin.longitude, pin.latitude]).addTo(this.map);
            }
            entry.pin = pin;
            entry.marker.setLngLat([pin.longitude, pin.latitude]);
            entry.button.setAttribute('aria-label', pin.label);
            entry.button.setAttribute('aria-pressed', String(pin.selected));
            entry.button.querySelector('span')!.textContent = pin.count > 1 ? String(pin.count) : '';
        }
    }

    revealSavedBlock(lat: number, lng: number): void {
        if (!this.map) return;
        const bounds = this.containerElement.getBoundingClientRect();
        const drawer = document.getElementById('analytics-panel')?.getBoundingClientRect();
        const mobile = window.matchMedia('(max-width: 768px)').matches;
        const left = !mobile && drawer ? Math.max(24, drawer.right - bounds.left + 32) : 24;
        const bottom = mobile && drawer ? Math.max(24, bounds.bottom - drawer.top + 48) : 24;
        const right = bounds.width - 30;
        const top = 46;
        const maxY = bounds.height - bottom;
        if (left > right || top > maxY) return;
        const pin = this.map.project([lng, lat]);
        const x = Math.min(right, Math.max(left, pin.x));
        const y = Math.min(maxY, Math.max(top, pin.y));
        if (x !== pin.x || y !== pin.y) {
            this.map.panBy([pin.x - x, pin.y - y], { duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250 });
        }
    }

    setCompletedSalesComparison(selection: SpatialSelection, rows: HDBTransaction[]): void {
        const camera = this.comparison?.camera ?? (this.map && {
            center: this.map.getCenter(),
            zoom: this.map.getZoom(),
            pitch: this.map.getPitch(),
            bearing: this.map.getBearing(),
            padding: this.map.getPadding(),
        }) ?? undefined;
        this.comparison = { selection, rows, camera };
        this.closePopup();
        this.containerElement.classList.add('showing-sales-comparison');
        this.updateLayers();
    }

    clearCompletedSalesComparison(): void {
        if (!this.comparison) return;
        const camera = this.comparison.camera;
        this.comparison = null;
        if (camera) this.map?.jumpTo(camera);
        this.containerElement.classList.remove('showing-sales-comparison');
        this.updateLayers();
    }

    closePopup(): void {
        this.activePopup?.remove();
        this.activePopup = null;
    }

    /**
     * Update map with filtered data
     */
    setFilteredData(transactions: import('../data/DataLoader').HDBTransaction[]): void {
        appState.set('filteredTransactions', transactions);
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

    setRentalDomain(domain: ScaleDomain | null): void {
        this.rentalDomain = domain;
        this.updateLayers();
    }

    private createLayers() {
        if (this.comparison) {
            return [...this.createSelectionLayers(this.comparison.selection), new ScatterplotLayer({
                id: 'completed-sales-comparison',
                data: this.comparison.rows,
                getPosition: (row: HDBTransaction) => [row.longitude, row.latitude],
                getRadius: 25,
                radiusMinPixels: 4,
                radiusMaxPixels: 13,
                getFillColor: [32, 91, 170, 210],
            })];
        }
        const dataToRender = appState.get('filteredTransactions');

        const layers: any[] = [];

        // Keep the translucent selection under every data layer so it cannot
        // alter the apparent scale colour of points within the geometry.
        layers.push(...this.createSelectionLayers(appState.get('spatialSelection')));


        // Price modes keep the original individual-transaction map. Rental modes
        // deliberately collapse to one marker per block so overlapping records do
        // not obscure the comparison the buyer is trying to make.
        const colorMode = appState.get('colorMode');
        if (colorMode !== 'price' && colorMode !== 'price_psf') {
            layers.push(...this.createRentalLayers(colorMode));
        } else {
        if (this.rangeData !== dataToRender || this.rangeMode !== colorMode) {
            this.rangeData = dataToRender;
            this.rangeMode = colorMode;
            this.resaleDomain = calculateMetricDomain(
                colorMode,
                dataToRender.map((transaction) => metricValue(colorMode, transaction)),
            );
        }
        const domain = this.resaleDomain;

        const colorScale = appState.get('colorScale');

        // Unified visualization for Desktop & Mobile
        layers.push(new ScatterplotLayer({
            id: 'scatterplot-layer',
            data: dataToRender,
            getPosition: (d: HDBTransaction) => [d.longitude, d.latitude],
            getRadius: this.isMobile ? 65 : 50,
            getFillColor: (d: HDBTransaction) => {
                const scalar = scaleScalar(metricValue(colorMode, d), domain);
                if (scalar === null) return [151, 151, 151, 180] as [number, number, number, number];
                const idx = Math.min(255, Math.floor(scalar * 255));
                const [r, g, b] = this.colorLookup[idx];
                return [r, g, b, 255] as [number, number, number, number];
            },
            // Tell Deck.gl to re-evaluate getFillColor whenever these change
            updateTriggers: {
                getFillColor: [domain?.min, domain?.max, colorMode, colorScale]
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
                            const content = createMopPopup(info.object.properties ?? {});
                            this.showPopup(info.coordinate[1], info.coordinate[0], content);
                            return true;
                        }
                    }
                })
            );
        }

        return layers;
    }

    private createSelectionLayers(selection: SpatialSelection): any[] {
        if (selection.kind === 'circle') {
            return [new ScatterplotLayer({
                id: 'selection-circle',
                data: [{
                    position: [selection.center.longitude, selection.center.latitude],
                    radius: selection.radiusMeters
                }],
                pickable: false,
                stroked: true,
                filled: true,
                getFillColor: [59, 130, 246, 12],
                getLineColor: [59, 130, 246, 255],
                getLineWidth: 2,
                lineWidthMinPixels: 2,
                getPosition: (d: any) => d.position,
                getRadius: (d: any) => d.radius,
                radiusUnits: 'meters'
            })];
        }
        if (selection.kind === 'rectangle') {
            const polygon = [
                [selection.west, selection.south],
                [selection.east, selection.south],
                [selection.east, selection.north],
                [selection.west, selection.north]
            ];
            return [new PolygonLayer({
                id: 'selection-rect',
                data: [{ polygon }],
                pickable: false,
                stroked: true,
                filled: true,
                getFillColor: [59, 130, 246, 12],
                getLineColor: [59, 130, 246, 255],
                getLineWidth: 2,
                lineWidthMinPixels: 2,
                getPolygon: (d: any) => d.polygon
            })];
        }
        return [];
    }

    private createRentalLayers(mode: Exclude<ColorMode, 'price' | 'price_psf'>): any[] {
        const selectedType = appState.get('rentalActiveFlatType');
        const points = this.rentalPoints.filter((point) => !selectedType || point.flatType === selectedType);
        const definition = getMetricDefinition(mode);
        const color = (point: RentalMapPoint): [number, number, number, number] => {
            const value = metricValue(mode, point);
            const scalar = scaleScalar(value, this.rentalDomain);
            if (value === null || scalar === null) return [151, 151, 151, 180];
            if (definition.palette === 'diverging') {
                // Orange → neutral → blue, fixed at zero so profit/loss is legible.
                const ratio = scalar * 2 - 1;
                if (ratio < 0) {
                    const t = ratio + 1;
                    return [Math.round(224 + 31 * t), Math.round(116 + 126 * t), Math.round(43 + 192 * t), 245];
                }
                return [Math.round(255 - 197 * ratio), Math.round(242 - 112 * ratio), Math.round(235 + 15 * ratio), 245];
            }
            const [r, g, b] = this.colorLookup[Math.min(255, Math.floor(scalar * 255))];
            return [r, g, b, 245];
        };
        const layers: any[] = [new ScatterplotLayer({
            id: 'rental-block-layer', data: points, pickable: true, stroked: false,
            getPosition: (d: RentalMapPoint) => [d.longitude, d.latitude],
            getRadius: this.isMobile ? 85 : 68,
            radiusMinPixels: this.isMobile ? 5 : 4, radiusMaxPixels: 28,
            getFillColor: color,
            updateTriggers: { getFillColor: [mode, this.rentalDomain?.min, this.rentalDomain?.max, this.colorLookup] },
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
        appState.setSpatialSelection(circleSelection(centerLat, centerLng, radiusMeters));
    }

    updateSelectionRect(startLat: number, startLng: number, endLat: number, endLng: number): void {
        appState.setSpatialSelection(rectangleSelection(startLat, startLng, endLat, endLng));
    }

    clearSelectionCircle(): void {
        if (appState.get('spatialSelection').kind === 'circle') appState.clearSpatialSelection();
    }

    clearSelectionRect(): void {
        if (appState.get('spatialSelection').kind === 'rectangle') appState.clearSpatialSelection();
    }

    clearSelectionGeometry(): void {
        appState.clearSpatialSelection();
    }

    setColorMode(mode: ColorMode): void {
        appState.set('colorMode', mode);
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

    showPopup(lat: number, lng: number, content: HTMLElement): void {
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
            .setDOMContent(content)
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
