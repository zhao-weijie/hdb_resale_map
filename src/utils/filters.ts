/**
 * Filter utilities for HDB transaction data
 */

import type { HDBTransaction } from '../data/DataLoader';

export interface GlobalFilters {
    date: string;
    flatTypes: string[];
    leaseMin: number;
    leaseMax: number;
}

/**
 * Apply global filters to transaction data
 * @param transactions Array of transactions to filter
 * @param filters Filter criteria to apply
 * @returns Filtered array of transactions
 */
export function applyFilters(
    transactions: HDBTransaction[],
    filters: GlobalFilters
): HDBTransaction[] {
    const now = new Date();

    return transactions.filter(t => {
        // Flat Type Filter
        if (!filters.flatTypes.includes(t.flat_type)) return false;

        // Lease Filter
        if (t.remaining_lease_years < filters.leaseMin ||
            t.remaining_lease_years > filters.leaseMax) return false;

        // Date Filter
        if (filters.date !== 'all') {
            const txDate = new Date(t.transaction_date);
            const diffTime = Math.abs(now.getTime() - txDate.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (filters.date === '6m' && diffDays > 180) return false;
            if (filters.date === '1y' && diffDays > 365) return false;
            if (filters.date === '3y' && diffDays > 365 * 3) return false;
            if (filters.date === '5y' && diffDays > 365 * 5) return false;
        }

        return true;
    });
}
