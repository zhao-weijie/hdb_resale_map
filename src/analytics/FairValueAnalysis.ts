/**
 * FairValueAnalysis - Calculates fair value estimates using regression coefficients
 */

import type { HDBTransaction } from '../data/DataLoader';

export interface RegressionCoefficients {
    intercept: number;
    features: {
        storey_midpoint: number;
        remaining_lease_years: number;
        mrt_distance_km: number;
        floor_area_sqm: number;
        flat_type_encoded: number;
    };
    flat_type_mapping: Record<string, string>;
    r_squared: number;
    latest_price_index: number;
    latest_quarter: string;
    n_samples: number;
    summary_stats: {
        storey_midpoint: { mean: number; std: number };
        remaining_lease_years: { mean: number; std: number };
        mrt_distance_km: { mean: number; std: number };
        floor_area_sqm: { mean: number; std: number };
    };
}

export interface FactorImpact {
    feature: string;
    label: string;
    value: number;
    percentImpact: number;
    comparedToMean: string;
}

export interface FairValueResult {
    predictedPricePsf: number;
    adjustedPricePsf: number;
    priceDifference: number;
    percentDifference: number;
    factorImpacts: FactorImpact[];
}

export class FairValueAnalysis {
    private coefficients: RegressionCoefficients | null = null;

    async loadCoefficients(): Promise<void> {
        try {
            const response = await fetch('data/regression_coefficients.json');
            if (!response.ok) {
                throw new Error(`Failed to load coefficients: ${response.status}`);
            }
            this.coefficients = await response.json();
            console.log('Loaded regression coefficients:', this.coefficients);
        } catch (error) {
            console.error('Error loading regression coefficients:', error);
        }
    }

    isReady(): boolean {
        return this.coefficients !== null;
    }

    getCoefficients(): RegressionCoefficients | null {
        return this.coefficients;
    }

    /**
     * Get the encoded value for a flat type
     */
    private getFlatTypeEncoded(flatType: string): number {
        if (!this.coefficients) return 3; // Default to 4-ROOM

        const reverseMapping: Record<string, number> = {};
        for (const [key, value] of Object.entries(this.coefficients.flat_type_mapping)) {
            reverseMapping[value] = parseInt(key);
        }
        return reverseMapping[flatType] ?? 3;
    }

    /**
     * Adjust a transaction price to current market using price index (in PSF)
     */
    getAdjustedPricePsf(transaction: HDBTransaction): number {
        if (!this.coefficients) return transaction.price_psf;

        const latestIndex = this.coefficients.latest_price_index;
        const transactionIndex = transaction.price_index ?? 100;

        return transaction.price_psf * (latestIndex / transactionIndex);
    }

    /**
     * Predict fair price PSM using regression model
     */
    predictPricePsm(
        storeyMidpoint: number,
        remainingLeaseYears: number,
        mrtDistanceKm: number,
        floorAreaSqm: number,
        flatType: string
    ): number {
        if (!this.coefficients) return 0;

        const flatTypeEncoded = this.getFlatTypeEncoded(flatType);
        const coef = this.coefficients.features;

        // Log-linear model: log(price_psm) = intercept + sum(coef * feature)
        const logPricePsm = this.coefficients.intercept +
            coef.storey_midpoint * storeyMidpoint +
            coef.remaining_lease_years * remainingLeaseYears +
            coef.mrt_distance_km * mrtDistanceKm +
            coef.floor_area_sqm * floorAreaSqm +
            coef.flat_type_encoded * flatTypeEncoded;

        return Math.exp(logPricePsm);
    }

    /**
     * Calculate factor impacts for a transaction compared to dataset mean
     */
    getFactorImpacts(transaction: HDBTransaction): FactorImpact[] {
        if (!this.coefficients) return [];

        const coef = this.coefficients.features;
        const stats = this.coefficients.summary_stats;

        const storeyMidpoint = (transaction as any).storey_midpoint ?? 8;
        const mrtDistanceKm = ((transaction as any).mrt_distance_m ?? 500) / 1000;

        const impacts: FactorImpact[] = [
            {
                feature: 'storey_midpoint',
                label: 'Storey',
                value: storeyMidpoint,
                percentImpact: (Math.exp(coef.storey_midpoint * (storeyMidpoint - stats.storey_midpoint.mean)) - 1) * 100,
                comparedToMean: storeyMidpoint > stats.storey_midpoint.mean ? 'above average' : 'below average'
            },
            {
                feature: 'remaining_lease_years',
                label: 'Lease Remaining',
                value: transaction.remaining_lease_years,
                percentImpact: (Math.exp(coef.remaining_lease_years * (transaction.remaining_lease_years - stats.remaining_lease_years.mean)) - 1) * 100,
                comparedToMean: transaction.remaining_lease_years > stats.remaining_lease_years.mean ? 'above average' : 'below average'
            },
            {
                feature: 'mrt_distance_km',
                label: 'MRT Distance',
                value: mrtDistanceKm,
                percentImpact: (Math.exp(coef.mrt_distance_km * (mrtDistanceKm - stats.mrt_distance_km.mean)) - 1) * 100,
                comparedToMean: mrtDistanceKm < stats.mrt_distance_km.mean ? 'closer than average' : 'farther than average'
            },
            {
                feature: 'floor_area_sqm',
                label: 'Floor Area',
                value: transaction.floor_area_sqm,
                percentImpact: (Math.exp(coef.floor_area_sqm * (transaction.floor_area_sqm - stats.floor_area_sqm.mean)) - 1) * 100,
                comparedToMean: transaction.floor_area_sqm > stats.floor_area_sqm.mean ? 'larger than average' : 'smaller than average'
            }
        ];

        return impacts;
    }

    /**
     * Calculate price distribution statistics for a set of transactions
     */
    getPriceDistribution(transactions: HDBTransaction[]): {
        min: number;
        max: number;
        median: number;
        q1: number;
        q3: number;
        mean: number;
        std: number;
    } {
        if (transactions.length === 0) {
            return { min: 0, max: 0, median: 0, q1: 0, q3: 0, mean: 0, std: 0 };
        }

        const adjustedPrices = transactions.map(t => this.getAdjustedPricePsf(t)).sort((a, b) => a - b);
        const n = adjustedPrices.length;

        const mean = adjustedPrices.reduce((sum, p) => sum + p, 0) / n;
        const variance = adjustedPrices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / n;

        return {
            min: adjustedPrices[0],
            max: adjustedPrices[n - 1],
            median: adjustedPrices[Math.floor(n / 2)],
            q1: adjustedPrices[Math.floor(n * 0.25)],
            q3: adjustedPrices[Math.floor(n * 0.75)],
            mean,
            std: Math.sqrt(variance)
        };
    }

    /**
     * Generate histogram data for price distribution
     */
    getHistogramData(transactions: HDBTransaction[], bins: number = 15): { label: string; count: number }[] {
        if (transactions.length === 0) return [];

        const adjustedPrices = transactions.map(t => this.getAdjustedPricePsf(t));
        const min = Math.min(...adjustedPrices);
        const max = Math.max(...adjustedPrices);
        const binWidth = (max - min) / bins;

        const histogram: { label: string; count: number }[] = [];
        for (let i = 0; i < bins; i++) {
            const binStart = min + i * binWidth;
            const binEnd = binStart + binWidth;
            const count = adjustedPrices.filter(p => p >= binStart && (i === bins - 1 ? p <= binEnd : p < binEnd)).length;
            histogram.push({
                label: `$${Math.round(binStart)}`,
                count
            });
        }

        return histogram;
    }
}
