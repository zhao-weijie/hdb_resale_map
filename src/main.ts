import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './icons';
import { DataLoader } from './data/DataLoader';
import { MapView } from './map/MapView';
import { AnalyticsPanel } from './analytics/AnalyticsPanel';
import { ColorScaleBar } from './components/ColorScaleBar';
import { RentalController } from './rental/RentalController';
import { appState } from './state/AppState';
import { applyFilters } from './utils/filters';
import { readSavedFilters } from './utils/savedFilters';

const isMobile = window.innerWidth < 768;

async function initApp() {
    const loading = document.getElementById('loading-overlay');
    // A compact status leaves the basemap usable while transaction history loads.
    loading?.classList.add('loading-status');
    performance.mark('app-start');
    try {
        const filters = readSavedFilters(appState.get('globalFilters'));
        appState.set('globalFilters', filters);
        const dataLoader = new DataLoader();
        const mapView = new MapView('map-container', dataLoader, isMobile);
        const colorScale = new ColorScaleBar();
        const mapReady = mapView.initialize().then(() => {
            performance.mark('basemap-ready');
            mapView.addControl(colorScale, 'top-right');
        });
        const dataReady = (async () => {
            await dataLoader.loadManifest();
            await dataLoader.ensureDateRange(filters.date);
            appState.set('allTransactions', dataLoader.getAllData());
            appState.set('filteredTransactions', applyFilters(dataLoader.getAllData(), filters));
        })();
        await Promise.all([mapReady, dataReady]);
        mapView.setFilteredData(appState.get('filteredTransactions'));
        const analyticsPanel = new AnalyticsPanel('analytics-panel', dataLoader, mapView);
        analyticsPanel.render();
        // Rental evidence is loaded only after the buyer selects a rental metric.
        new RentalController(dataLoader, mapView, colorScale);
        loading?.remove();
        requestAnimationFrame(() => {
            performance.mark('transactions-ready');
            performance.measure('startup-to-transactions', 'app-start', 'transactions-ready');
        });
        console.log(`Application ready: ${dataLoader.getRecordCount()} loaded transactions`);
    } catch (error) {
        console.error('Failed to initialize application:', error);
        if (loading) {
            loading.innerHTML = '<p>Could not load the map or transaction history. Please reload to retry.</p>';
            loading.setAttribute('role', 'alert');
        }
    }
}

void initApp();
