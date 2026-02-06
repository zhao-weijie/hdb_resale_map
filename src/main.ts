/**
 * Main application entry point
 */

import './style.css';
import { DataLoader } from './data/DataLoader';
import { MapView } from './map/MapView';
import { AnalyticsPanel } from './analytics/AnalyticsPanel';

// Detect mobile vs desktop
const isMobile = window.innerWidth < 768;

async function initApp() {
    console.log('🚀 Initializing HDB Resale Analytics...');

    // Show mobile banner if on mobile
    if (isMobile) {
        const banner = document.getElementById('mobile-banner');
        if (banner) {
            banner.style.display = 'block';
        }
    }

    try {
        // Load data
        console.log('📊 Loading data...');
        const dataLoader = new DataLoader();
        await dataLoader.load('data/hdb_data.arrow');
        console.log(`✓ Loaded ${dataLoader.getRecordCount()} transactions`);

        // Initialize map
        console.log('🗺️ Initializing map...');
        const mapView = new MapView('map-container', dataLoader, isMobile);
        await mapView.initialize();
        console.log('✓ Map initialized');

        // Initialize analytics panel (desktop and mobile)
        console.log('📈 Initializing analytics panel...');
        const analyticsPanel = new AnalyticsPanel('analytics-panel', dataLoader, mapView);
        analyticsPanel.render();
        console.log('✓ Analytics panel initialized');

        console.log('✅ Application ready!');
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        alert('Failed to load HDB data. Please check the console for details.');
    }
}

// Start the application
initApp();
