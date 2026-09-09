import type { HDBTransaction } from '../data/DataLoader';

export type TransactionMetric = 'price' | 'price_psf';

export interface TransactionStats {
    min: number;
    max: number;
    median: number;
    mean: number;
    std: number;
}

type MetricCache = Partial<Record<TransactionMetric, TransactionStats | null>>;

const statsCache = new WeakMap<HDBTransaction[], MetricCache>();

export function getTransactionStats(
    transactions: HDBTransaction[],
    metric: TransactionMetric
): TransactionStats | null {
    let cachedMetrics = statsCache.get(transactions);
    if (cachedMetrics && metric in cachedMetrics) return cachedMetrics[metric] ?? null;

    const values = transactions.map((transaction) =>
        metric === 'price' ? transaction.resale_price : transaction.price_psf
    );
    let stats: TransactionStats | null = null;

    if (values.length > 0) {
        values.sort((a, b) => a - b);
        const count = values.length;
        const mean = values.reduce((sum, value) => sum + value, 0) / count;
        const middle = Math.floor(count / 2);
        const median = count % 2 === 0
            ? (values[middle - 1] + values[middle]) / 2
            : values[middle];
        const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
        stats = {
            min: values[0],
            max: values[count - 1],
            median,
            mean,
            std: Math.sqrt(variance),
        };
    }

    if (!cachedMetrics) {
        cachedMetrics = {};
        statsCache.set(transactions, cachedMetrics);
    }
    cachedMetrics[metric] = stats;
    return stats;
}
