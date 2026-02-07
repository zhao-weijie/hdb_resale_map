/**
 * Main application entry point
 */

import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DataLoader } from './data/DataLoader';
import { MapView } from './map/MapView';
import { AnalyticsPanel } from './analytics/AnalyticsPanel';

// Detect mobile vs desktop
const isMobile = window.innerWidth < 768;

async function initApp() {
    console.log('🚀 Initializing HDB Resale Analytics...');

    // Show mobile banner if on mobile
    // Show mobile banner if on mobile
    if (isMobile) {
        const banner = document.getElementById('mobile-banner');
        if (banner) {
            banner.style.display = 'flex'; // Changed to flex for layout

            // Close logic
            const closeBtn = document.createElement('button');
            closeBtn.id = 'mobile-banner-close';
            closeBtn.innerHTML = '<i data-lucide="x"></i>';
            closeBtn.onclick = () => {
                banner.style.display = 'none';
            };
            banner.appendChild(closeBtn);
            // @ts-ignore
            if (window.lucide) window.lucide.createIcons();
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
        await analyticsPanel.init(); // Load fair value analysis coefficients
        console.log('✓ Analytics panel initialized');

        console.log('✅ Application ready!');

        // Hide loading overlay
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('fade-out');
            setTimeout(() => {
                loadingOverlay.style.display = 'none';
            }, 500);
        }

    } catch (error) {
        console.error('❌ Failed to initialize application:', error);

        // Show error in loading overlay
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <i data-lucide="alert-circle" style="color: var(--color-danger); width: 48px; height: 48px; margin-bottom: 16px;"></i>
                    <h3 style="margin-bottom: 8px;">Failed to load application</h3>
                    <p style="color: var(--color-text-muted);">Please check your connection and try again.</p>
                </div>
            `;
            // @ts-ignore
            if (window.lucide) window.lucide.createIcons();
        } else {
            alert('Failed to load HDB data. Please check the console for details.');
        }
    }
}

// Start the application
initApp();
