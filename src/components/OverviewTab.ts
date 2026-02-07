/**
 * OverviewTab - Displays overview statistics and price trend charts
 */

import { Chart, registerables } from 'chart.js';
import type { HDBTransaction } from '../data/DataLoader';

Chart.register(...registerables);

export class OverviewTab {
    private chart: Chart | null = null;

    constructor() { }

    render(): string {
        return `
        <div class="tab-content active" id="tab-overview">
            <div id="stats-content"></div>
            <div class="chart-container">
                <canvas id="trend-chart"></canvas>
                <div id="trend-chart-placeholder" class="chart-placeholder hidden">
                    <div class="placeholder-content">
                        <i data-lucide="bar-chart-2"></i>
                        <p>Select an area on the map<br>to view price trends</p>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    renderStats(data: HDBTransaction[]): void {
        const statsContent = document.getElementById('stats-content');
        if (!statsContent) return;

        if (!data || data.length === 0) {
            statsContent.innerHTML = '<p class="no-data">No transactions match current filters</p>';
            return;
        }

        // Calculate PSF-based stats for consistency with Fair Value tab
        const prices = data.map(t => t.price_psf).sort((a, b) => a - b);
        const n = prices.length;
        const median = prices[Math.floor(n / 2)];
        const q1 = prices[Math.floor(n * 0.25)];
        const q3 = prices[Math.floor(n * 0.75)];
        const avgPrice = data.reduce((sum, t) => sum + t.resale_price, 0) / data.length;
        const avgPSF = data.reduce((sum, t) => sum + t.price_psf, 0) / data.length;

        statsContent.innerHTML = `
            <table class="stats-table">
                <tr>
                    <td class="stats-label">Avg Price</td>
                    <td class="stats-value">$${Math.round(avgPrice).toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="stats-label">Avg PSF</td>
                    <td class="stats-value">$${Math.round(avgPSF)}</td>
                </tr>
                <tr>
                    <td class="stats-label">Median PSF</td>
                    <td class="stats-value">$${Math.round(median)}</td>
                </tr>
                <tr>
                    <td class="stats-label">Transactions</td>
                    <td class="stats-value">${data.length.toLocaleString()}</td>
                </tr>
            </table>
        `;
    }

    renderChart(data: HDBTransaction[]): void {
        const canvas = document.getElementById('trend-chart') as HTMLCanvasElement;
        const placeholder = document.getElementById('trend-chart-placeholder');

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

        // Group by quarter
        const quarters = new Map<string, number[]>();
        data.forEach(t => {
            const date = new Date(t.transaction_date);
            const q = Math.floor(date.getMonth() / 3) + 1;
            const key = `${date.getFullYear()}-Q${q}`;
            if (!quarters.has(key)) quarters.set(key, []);
            quarters.get(key)!.push(t.price_psf);
        });

        const sortedQuarters = Array.from(quarters.keys()).sort();

        // Calculate box plot stats for each quarter
        const boxPlotData = sortedQuarters.map(q => {
            const prices = quarters.get(q)!.sort((a, b) => a - b);
            const n = prices.length;
            const q1 = prices[Math.floor(n * 0.25)];
            const q3 = prices[Math.floor(n * 0.75)];
            const iqr = q3 - q1;
            const lowerFence = q1 - 1.5 * iqr;
            const upperFence = q3 + 1.5 * iqr;

            const outliers = prices.filter(p => p < lowerFence || p > upperFence);
            const inRange = prices.filter(p => p >= lowerFence && p <= upperFence);

            return {
                min: inRange.length > 0 ? inRange[0] : prices[0],
                q1,
                median: prices[Math.floor(n * 0.5)],
                mean: prices.reduce((sum, p) => sum + p, 0) / n,
                q3,
                max: inRange.length > 0 ? inRange[inRange.length - 1] : prices[n - 1],
                outliers
            };
        });

        if (this.chart) this.chart.destroy();

        this.chart = new Chart(canvas, {
            type: 'boxplot',
            data: {
                labels: sortedQuarters,
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
                        text: 'Price Distribution Over Time (PSF)'
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
                        title: { display: true, text: 'Quarter' }
                    }
                }
            }
        } as any);
    }

    private calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }

    destroy(): void {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
