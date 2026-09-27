import type { HDBTransaction } from '../data/DataLoader';

let nextInstance = 0;

export interface TransactionTableOptions {
    pageSize?: number;
    activeFlatType?: string;
}

export class TransactionTable {
    readonly id = `transaction-table-${++nextInstance}`;
    private page = 0;
    private root: HTMLElement | null = null;

    constructor(private transactions: HDBTransaction[], private options: TransactionTableOptions = {}) {}

    setTransactions(transactions: HDBTransaction[]): void {
        this.transactions = transactions;
        this.page = 0;
        this.renderIntoRoot();
    }

    markup(): string {
        const pageSize = this.options.pageSize ?? 5;
        const totalPages = Math.max(1, Math.ceil(this.transactions.length / pageSize));
        this.page = Math.max(0, Math.min(this.page, totalPages - 1));
        const rows = this.transactions.slice(this.page * pageSize, (this.page + 1) * pageSize).map((row) => {
            const psf = row.resale_price / (row.floor_area_sqm * 10.7639);
            const active = row.flat_type === this.options.activeFlatType ? ' class="active-flat-type"' : '';
            return `<tr${active}><td>${new Date(row.transaction_date).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</td><td>${escapeHtml(row.flat_type)}</td><td>${escapeHtml(row.storey_range)}</td><td>$${(row.resale_price / 1000).toFixed(0)}k</td><td>$${Math.round(psf)}</td></tr>`;
        }).join('');
        const nav = totalPages > 1 ? `<div class="popup-nav"><button type="button" class="popup-nav-btn" data-table-page="${this.page - 1}" ${this.page === 0 ? 'disabled' : ''}>← Prev</button><span class="popup-nav-info">${this.page + 1} / ${totalPages}</span><button type="button" class="popup-nav-btn" data-table-page="${this.page + 1}" ${this.page === totalPages - 1 ? 'disabled' : ''}>Next →</button></div>` : '';
        return `<div id="${this.id}" class="transaction-table"><table class="popover-table"><thead><tr><th>Date</th><th>Type</th><th>Floor</th><th>Price</th><th>PSF</th></tr></thead><tbody>${rows}</tbody></table>${nav}</div>`;
    }

    mount(root: HTMLElement): void {
        this.root = root;
        this.bind();
    }

    private bind(): void {
        this.root?.querySelector(`#${this.id}`)?.addEventListener('click', (event) => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-table-page]');
            if (!button || button.disabled) return;
            this.page = Number(button.dataset.tablePage);
            this.renderIntoRoot();
        });
    }

    private renderIntoRoot(): void {
        if (!this.root) return;
        const current = this.root.querySelector(`#${this.id}`);
        if (!current) return;
        current.outerHTML = this.markup();
        this.bind();
    }
}

function escapeHtml(value: string): string {
    const element = document.createElement('span');
    element.textContent = value;
    return element.innerHTML;
}
