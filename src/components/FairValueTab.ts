/**
 * FairValueTab - Displays fair value analysis with histograms and factor impacts
 */

import { Chart, registerables } from 'chart.js';
import { BoxPlotController, BoxAndWiskers } from '@sgratzl/chartjs-chart-boxplot';
import type { HDBTransaction } from '../data/DataLoader';
import { FairValueAnalysis } from '../analytics/FairValueAnalysis';

Chart.register(...registerables, BoxPlotController, BoxAndWiskers);

export class FairValueTab {
    private fairValueAnalysis: FairValueAnalysis;
    private chart: Chart | null = null;
    private selectedFeature: 'storey' | 'lease' | 'mrt' | 'flat_type' = 'storey';

    constructor(fairValueAnalysis: FairValueAnalysis) {
        this.fairValueAnalysis = fairValueAnalysis;
    }

    render(): string {
        return `
        <div class="tab-content" id="tab-fairvalue">
            <div class="fair-value-content">
                <div id="fv-distribution">
                     <h3 style="font-size: 13px;">Price Distribution 
                        <span class="tooltip-trigger" data-tooltip="Prices adjusted via HDB Resale Price Index">
                            <i data-lucide="info"></i>
                        </span>
                     </h3>
                     <div class="fv-stats" id="fv-stats"></div>
                     
                     <div class="input-wrapper" style="margin: 12px 0;">
                        <select id="fv-feature-select">
                            <option value="storey">Group by Storey Range</option>
                            <option value="lease">Group by Lease Remaining</option>
                            <option value="mrt">Group by MRT Distance</option>
                            <option value="flat_type">Group by Flat Type</option>
                        </select>
                     </div>
                     
                     <div class="chart-container">
                        <canvas id="fv-histogram"></canvas>
                         <div id="fv-chart-placeholder" class="chart-placeholder hidden">
                            <div class="placeholder-content">
                                <i data-lucide="bar-chart-2"></i>
                                <p>Select an area to view<br>fair value analysis</p>
                            </div>
                        </div>
                     </div>
                </div>
            </div>
        </div>
        `;
    }

    bindEvents(): void {
        const featureSelect = document.getElementById('fv-feature-select') as HTMLSelectElement;
        featureSelect?.addEventListener('change', () => {
            this.selectedFeature = featureSelect.value as any;
            const currentData = (globalThis as any).__currentFairValueData;
            if (currentData) {
                this.renderFairValue(currentData);
            }
        });
    }

    renderFairValue(data: HDBTransaction[]): void {
        this.renderFairValueStats(data);
        this.renderFairValueChart(data);
        // NOTE: Factor Impact removed - was showing incorrect/misleading data
        // TODO: Re-implement with proper statistical analysis in future refactoring
    }

    private renderFairValueStats(data: HDBTransaction[]): void {
        const statsDiv = document.getElementById('fv-stats');
        if (!statsDiv) return;

        if (!data || data.length === 0) {
            statsDiv.innerHTML = '<p class="no-data">Select an area to view fair value analysis</p>';
            return;
        }

        const adjustedPrices = data.map(t => this.fairValueAnalysis.getAdjustedPricePsf(t)).sort((a, b) => a - b);
        const n = adjustedPrices.length;
        const median = adjustedPrices[Math.floor(n / 2)];
        const q1 = adjustedPrices[Math.floor(n * 0.25)];
        const q3 = adjustedPrices[Math.floor(n * 0.75)];
        const min = adjustedPrices[0];
        const max = adjustedPrices[n - 1];

        statsDiv.innerHTML = `
            <table class="stats-table">
                <tr>
                    <td class="stats-label">Median PSF</td>
                    <td class="stats-value">$${Math.round(median).toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="stats-label">25th - 75th %</td>
                    <td class="stats-value">$${Math.round(q1).toLocaleString()} - $${Math.round(q3).toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="stats-label">Range</td>
                    <td class="stats-value">$${Math.round(min).toLocaleString()} - $${Math.round(max).toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="stats-label">Transactions</td>
                    <td class="stats-value">${data.length.toLocaleString()}</td>
                </tr>
            </table>
        `;
    }

    private renderFairValueChart(data: HDBTransaction[]): void {
        const canvas = document.getElementById('fv-histogram') as HTMLCanvasElement;
        const placeholder = document.getElementById('fv-chart-placeholder');

        if (!canvas || !placeholder) return;

        if (!data || data.length === 0) {
            placeholder.classList.remove('hidden');
            canvas.style.display = 'none';
            if (this.chart) {
                this.chart.destroy();
                this.chart = null;
            }
            return;
        }

        placeholder.classList.add('hidden');
        canvas.style.display = 'block';

        // Group transactions by selected feature
        const distribution = this.aggregateByFeature(data, this.selectedFeature);

        const featureLabels: Record<string, string> = {
            storey: 'Storey Range',
            lease: 'Lease Remaining (Years)',
            mrt: 'MRT Distance (m)',
            flat_type: 'Flat Type',
        };

        const boxPlotData = distribution.map(d => ({
            min: d.min,
            q1: d.q1,
            median: d.median,
            q3: d.q3,
            max: d.max,
            mean: d.mean,
            outliers: d.outliers
        }));

        // Update existing chart in-place if possible, otherwise create new
        if (this.chart) {
            this.chart.data.labels = distribution.map(d => d.label);
            this.chart.data.datasets[0].data = boxPlotData as any;
            // Update title and x-axis label for feature change
            (this.chart.options.plugins as any).title.text = `Price Distribution by ${featureLabels[this.selectedFeature]}`;
            (this.chart.options.scales as any).x.title.text = featureLabels[this.selectedFeature];
            this.chart.update('none'); // 'none' mode skips animations for faster updates
        } else {
            this.chart = new Chart(canvas, {
                type: 'boxplot',
                data: {
                    labels: distribution.map(d => d.label),
                    datasets: [{
                        label: 'Price PSF',
                        data: boxPlotData,
                        backgroundColor: 'rgba(59, 130, 246, 0.3)',
                        borderColor: 'rgb(59, 130, 246)',
                        borderWidth: 1,
                        outlierBackgroundColor: 'rgba(59, 130, 246, 0.6)',
                        outlierBorderColor: 'rgb(59, 130, 246)',
                        outlierRadius: 3,
                        medianColor: 'rgb(37, 99, 235)',
                        meanBackgroundColor: 'rgba(16, 185, 129, 0.6)',
                        meanBorderColor: 'rgb(16, 185, 129)',
                        meanRadius: 4,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        title: {
                            display: true,
                            text: `Price Distribution by ${featureLabels[this.selectedFeature]}`
                        },
                        tooltip: {
                            callbacks: {
                                label: (context: any) => {
                                    const d = context.raw;
                                    if (!d) return '';
                                    return [
                                        `Median: $${Math.round(d.median)}`,
                                        `Mean: $${Math.round(d.mean)}`,
                                        `Q1: $${Math.round(d.q1)}  Q3: $${Math.round(d.q3)}`,
                                        `Min: $${Math.round(d.min)}  Max: $${Math.round(d.max)}`,
                                        `Count: ${distribution[context.dataIndex].count}`,
                                        d.outliers && d.outliers.length > 0 ? `Outliers: ${d.outliers.length}` : ''
                                    ].filter(s => s !== '');
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: false,
                            grace: '5%',
                            title: { display: true, text: 'Price PSF ($)' }
                        },
                        x: {
                            title: { display: true, text: featureLabels[this.selectedFeature] }
                        }
                    }
                }
            } as any);
        }
    }

    private aggregateByFeature(transactions: HDBTransaction[], feature: string): Array<{
        label: string;
        min: number;
        q1: number;
        median: number;
        mean: number;
        q3: number;
        max: number;
        count: number;
        outliers: number[];
    }> {
        const groups = new Map<string, number[]>();

        transactions.forEach(t => {
            let key: string;
            switch (feature) {
                case 'storey':
                    const storey = t.storey_midpoint;
                    if (storey <= 3) key = '1-3';
                    else if (storey <= 6) key = '4-6';
                    else if (storey <= 9) key = '7-9';
                    else if (storey <= 12) key = '10-12';
                    else if (storey <= 15) key = '13-15';
                    else if (storey <= 20) key = '16-20';
                    else key = '21+';
                    break;
                case 'lease':
                    const lease = t.remaining_lease_years;
                    if (lease < 50) key = '<50';
                    else if (lease < 60) key = '50-59';
                    else if (lease < 70) key = '60-69';
                    else if (lease < 80) key = '70-79';
                    else if (lease < 90) key = '80-89';
                    else key = '90+';
                    break;
                case 'mrt':
                    const mrt = t.mrt_distance_m;
                    if (mrt < 300) key = '<300m';
                    else if (mrt < 500) key = '300-500m';
                    else if (mrt < 750) key = '500-750m';
                    else if (mrt < 1000) key = '750m-1km';
                    else key = '>1km';
                    break;
                case 'flat_type':
                default:
                    key = t.flat_type;
                    break;
            }
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(this.fairValueAnalysis.getAdjustedPricePsf(t));
        });

        const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
            if (feature === 'storey') {
                const order = ['1-3', '4-6', '7-9', '10-12', '13-15', '16-20', '21+'];
                return order.indexOf(a) - order.indexOf(b);
            } else if (feature === 'lease') {
                const order = ['<50', '50-59', '60-69', '70-79', '80-89', '90+'];
                return order.indexOf(a) - order.indexOf(b);
            } else if (feature === 'mrt') {
                const order = ['<300m', '300-500m', '500-750m', '750m-1km', '>1km'];
                return order.indexOf(a) - order.indexOf(b);
            } else {
                return a.localeCompare(b);
            }
        });

        return sortedKeys.map(key => {
            const prices = groups.get(key)!.sort((a, b) => a - b);
            const n = prices.length;
            const q1 = prices[Math.floor(n * 0.25)];
            const q3 = prices[Math.floor(n * 0.75)];
            const iqr = q3 - q1;
            const lowerFence = q1 - 1.5 * iqr;
            const upperFence = q3 + 1.5 * iqr;

            const outliers = prices.filter(p => p < lowerFence || p > upperFence);
            const inRange = prices.filter(p => p >= lowerFence && p <= upperFence);

            return {
                label: key,
                min: inRange.length > 0 ? inRange[0] : prices[0],
                q1,
                median: prices[Math.floor(n * 0.5)],
                mean: prices.reduce((sum, p) => sum + p, 0) / n,
                q3,
                max: inRange.length > 0 ? inRange[inRange.length - 1] : prices[n - 1],
                count: n,
                outliers
            };
        });
    }

    private renderFactors(data: HDBTransaction[]): void {
        const factorsDiv = document.getElementById('fv-factors-content');
        if (!factorsDiv) return;

        if (!data || data.length === 0) {
            factorsDiv.innerHTML = '';
            return;
        }

        // Calculate average characteristics
        const avgStorey = data.reduce((sum, t) => sum + Number(t.storey_midpoint), 0) / data.length;
        const avgLease = data.reduce((sum, t) => sum + Number(t.remaining_lease_years), 0) / data.length;
        const avgMrtDist = data.reduce((sum, t) => sum + Number(t.mrt_distance_m), 0) / data.length / 1000;

        factorsDiv.innerHTML = `
            <div class="factor-list">
                <div class="factor-item">
                    <span>Avg Storey:</span>
                    <strong>${avgStorey.toFixed(1)}</strong>
                </div>
                <div class="factor-item">
                    <span>Avg Lease:</span>
                    <strong>${avgLease.toFixed(1)} yrs</strong>
                </div>
                <div class="factor-item">
                    <span>Avg MRT Dist:</span>
                    <strong>${(avgMrtDist * 1000).toFixed(0)}m</strong>
                </div>
            </div>
        `;
    }

    destroy(): void {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
