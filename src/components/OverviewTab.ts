/**
 * OverviewTab - Displays overview statistics and price trend charts
 */

import type { Chart } from 'chart.js';
import type { HDBTransaction } from '../data/DataLoader';
import type { RentalOverviewModel } from '../analytics/rentalOverview';
import { summarize } from '../rental/model';
import { getTransactionStats } from '../utils/transactionStats';

type OverviewMode = 'resale' | 'rental';

export class OverviewTab {
    private chart: Chart | null = null;
    private chartConstructorPromise: Promise<typeof import('chart.js').Chart> | null = null;
    private renderVersion = 0;
    private chartMode: OverviewMode | null = null;

    constructor() { }

    render(): string {
        return `
        <div id="analytics-overview">
            <div id="stats-content"></div>
            <div class="chart-container">
                <canvas id="trend-chart"></canvas>
                <div id="trend-chart-placeholder" class="chart-placeholder hidden">
                    <div class="placeholder-content">
                        <i data-lucide="bar-chart-2"></i>
                        <p>No data</p>
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

        // Calculate shared statistics from actual transaction prices
        const psfStats = getTransactionStats(data, 'price_psf');
        if (!psfStats) return;
        const avgPrice = data.reduce((sum, t) => sum + t.resale_price, 0) / data.length;

        statsContent.innerHTML = `
            <table class="stats-table">
                <tr>
                    <td class="stats-label">Avg Price</td>
                    <td class="stats-value">$${Math.round(avgPrice).toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="stats-label">Avg PSF</td>
                    <td class="stats-value">$${Math.round(psfStats.mean)}</td>
                </tr>
                <tr>
                    <td class="stats-label">Median PSF</td>
                    <td class="stats-value">$${Math.round(psfStats.median)}</td>
                </tr>
                <tr>
                    <td class="stats-label">Transactions</td>
                    <td class="stats-value">${data.length.toLocaleString()}</td>
                </tr>
            </table>
        `;
    }

    renderRentalStats(model: RentalOverviewModel): void {
        const statsContent = document.getElementById('stats-content');
        if (!statsContent) return;
        if (!model.summary) {
            statsContent.innerHTML = `<p class="no-data">${model.selected ? 'No rental records in selected area' : 'No rental records'}</p>${this.coverageNote(model)}`;
            return;
        }
        const { median, q1, q3, count } = model.summary;
        statsContent.innerHTML = `
            <table class="stats-table">
                <tr><td class="stats-label">Median Rent</td><td class="stats-value">${money(median)}</td></tr>
                <tr><td class="stats-label">IQR</td><td class="stats-value">${money(q1)}–${money(q3)}</td></tr>
                <tr><td class="stats-label">Rental Records</td><td class="stats-value">${count.toLocaleString()}</td></tr>
            </table>
            ${this.coverageNote(model)}
        `;
    }

    async renderChart(data: HDBTransaction[]): Promise<void> {
        return this.renderBoxPlot('resale', data, (row) => row.transaction_date, (row) => row.price_psf,
            'No transactions match current filters');
    }

    async renderRentalChart(model: RentalOverviewModel): Promise<void> {
        return this.renderBoxPlot('rental', [...model.records],
            (row) => new Date(`${row.month}-01T00:00:00Z`), (row) => row.monthly_rent,
            model.selected ? 'No rental records in selected area' : 'No rental records');
    }

    private async renderBoxPlot<T>(
        mode: OverviewMode,
        data: T[],
        dateOf: (row: T) => Date,
        valueOf: (row: T) => number,
        emptyText: string,
    ): Promise<void> {
        const renderVersion = ++this.renderVersion;
        const canvas = document.getElementById('trend-chart') as HTMLCanvasElement;
        const placeholder = document.getElementById('trend-chart-placeholder');

        if (!canvas || !placeholder) return;

        if (!data || data.length === 0) {
            placeholder.classList.remove('hidden');
            placeholder.querySelector('p')!.textContent = emptyText;
            canvas.style.display = 'none';
            if (this.chart) {
                this.chart.destroy();
                this.chart = null;
                this.chartMode = null;
            }
            return;
        }

        placeholder.classList.add('hidden');
        canvas.style.display = 'block';

        let ChartConstructor: typeof import('chart.js').Chart;
        try {
            ChartConstructor = await this.loadChartConstructor();
        } catch (error) {
            console.error('Failed to load overview chart:', error);
            placeholder.classList.remove('hidden');
            placeholder.querySelector('p')!.textContent = 'Unable to load chart';
            canvas.style.display = 'none';
            return;
        }
        if (renderVersion !== this.renderVersion || !canvas.isConnected) return;

        // Group by quarter
        const quarters = new Map<string, number[]>();
        data.forEach(row => {
            const date = dateOf(row);
            const q = Math.floor(date.getMonth() / 3) + 1;
            const key = `${date.getFullYear()}-Q${q}`;
            if (!quarters.has(key)) quarters.set(key, []);
            quarters.get(key)!.push(valueOf(row));
        });

        const sortedQuarters = Array.from(quarters.keys()).sort();

        // Calculate box plot stats for each quarter
        const boxPlotData = sortedQuarters.map(q => {
            const prices = quarters.get(q)!.sort((a, b) => a - b);
            const n = prices.length;
            const summary = summarize(prices)!;
            const { q1, q3, median } = summary;
            const iqr = q3 - q1;
            const lowerFence = q1 - 1.5 * iqr;
            const upperFence = q3 + 1.5 * iqr;

            const outliers = prices.filter(p => p < lowerFence || p > upperFence);
            const inRange = prices.filter(p => p >= lowerFence && p <= upperFence);

            return {
                min: inRange.length > 0 ? inRange[0] : prices[0],
                q1,
                median,
                mean: prices.reduce((sum, p) => sum + p, 0) / n,
                q3,
                max: inRange.length > 0 ? inRange[inRange.length - 1] : prices[n - 1],
                outliers
            };
        });

        // Update existing chart in-place if possible, otherwise create new
        if (this.chart && this.chartMode === mode) {
            this.chart.data.labels = sortedQuarters;
            this.chart.data.datasets[0].data = boxPlotData as any;
            this.chart.update('none'); // 'none' mode skips animations for faster updates
        } else {
            this.chart?.destroy();
            const rental = mode === 'rental';
            this.chart = new ChartConstructor(canvas, {
                type: 'boxplot',
                data: {
                    labels: sortedQuarters,
                    datasets: [{
                        label: rental ? 'Monthly Rent' : 'Price PSF',
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
                            text: rental ? 'Monthly Rent by Quarter' : 'Price Distribution Over Time (PSF)'
                        },
                        tooltip: {
                            callbacks: {
                                label: (context: any) => {
                                    const d = context.raw;
                                    if (!d) return '';
                                    return [
                                        `Median: ${money(d.median)}`,
                                        `Mean: ${money(d.mean)}`,
                                        `Q1: ${money(d.q1)}  Q3: ${money(d.q3)}`,
                                        `Min: ${money(d.min)}  Max: ${money(d.max)}`,
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
                            title: { display: true, text: rental ? 'Monthly Rent ($)' : 'Price PSF ($)' }
                        },
                        x: {
                            title: { display: true, text: 'Quarter' }
                        }
                    }
                }
            } as any);
            this.chartMode = mode;
        }
    }

    private coverageNote(model: RentalOverviewModel): string {
        if (!model.selected || model.unresolvedExcluded === 0) return '';
        const count = model.unresolvedExcluded.toLocaleString();
        return `<p class="overview-coverage-note">${count} unmapped ${model.unresolvedExcluded === 1 ? 'record' : 'records'} excluded</p>`;
    }

    private loadChartConstructor(): Promise<typeof import('chart.js').Chart> {
        if (!this.chartConstructorPromise) {
            this.chartConstructorPromise = Promise.all([
                import('chart.js'),
                import('@sgratzl/chartjs-chart-boxplot'),
            ]).then(([chartModule, boxPlotModule]) => {
                const { Chart, CategoryScale, LinearScale, Tooltip, Title } = chartModule;
                Chart.register(
                    CategoryScale,
                    LinearScale,
                    Tooltip,
                    Title,
                    boxPlotModule.BoxPlotController,
                    boxPlotModule.BoxAndWiskers,
                );
                return Chart;
            });
        }
        return this.chartConstructorPromise;
    }


    destroy(): void {
        this.renderVersion++;
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
            this.chartMode = null;
        }
    }

}

function money(value: number): string {
    return `$${Math.round(value).toLocaleString()}`;
}
