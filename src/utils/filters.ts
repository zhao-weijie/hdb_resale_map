/**
 * Filter utilities for HDB transaction data
 */

import type { HDBTransaction } from '../data/DataLoader';

export interface GlobalFilters {
    date: string;
    flatTypes: string[];
    leaseMin: number;
    leaseMax: number;
    floorMin: number;
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
    return transactions.filter(t => {
        // Flat Type Filter
        if (!filters.flatTypes.includes(t.flat_type)) return false;

        // Lease Filter
        if (t.remaining_lease_years < filters.leaseMin ||
            t.remaining_lease_years > filters.leaseMax) return false;

        // Floor Filter - compare minimum floor against upper bound of storey range
        if (filters.floorMin > 1) {
            const upperBound = parseInt(t.storey_range.split(' TO ')[1]);
            if (upperBound < filters.floorMin) return false;
        }

        // Date Filter - YYYY-MM format, keep transactions from selected month onward
        if (filters.date && filters.date !== 'all') {
            const txDate = new Date(t.transaction_date);
            const txYearMonth = txDate.getFullYear() + '-' + String(txDate.getMonth() + 1).padStart(2, '0');
            if (txYearMonth < filters.date) return false;
        }

        return true;
    });
}
