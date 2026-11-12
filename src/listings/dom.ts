import { createElement as createIcon, Star } from 'lucide';

export function element<K extends keyof HTMLElementTagNameMap>(
    tag: K, text?: string, className?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

export function action(text: string, run: () => void, className = 'tracker-button'): HTMLButtonElement {
    const button = element('button', text, className);
    button.type = 'button';
    button.addEventListener('click', run);
    return button;
}

export function shortlistButton(title: string, shortlisted: boolean, run: () => void): HTMLButtonElement {
    const button = action('', run, 'tracker-shortlist-toggle');
    button.append(createIcon(Star, { 'aria-hidden': 'true' }));
    button.setAttribute('aria-label', `Shortlist ${title}`);
    button.setAttribute('aria-pressed', String(shortlisted));
    button.title = shortlisted ? 'Remove from shortlist' : 'Add to shortlist';
    return button;
}

export function group(...children: Node[]): HTMLElement {
    const row = element('div', undefined, 'tracker-actions');
    row.append(...children);
    return row;
}

export function label(text: string, control: HTMLElement, ...indicators: Node[]): HTMLLabelElement {
    const wrapper = element('label', undefined, 'tracker-field');
    const caption = element('span', text);
    caption.append(...indicators);
    wrapper.append(caption, control);
    return wrapper;
}

export function input(type = 'text', value: string | null = '', required = false): HTMLInputElement {
    const field = element('input');
    field.type = type;
    field.value = value ?? '';
    field.required = required;
    return field;
}

export function select(values: ReadonlyArray<readonly [string, string]>, value: string): HTMLSelectElement {
    const field = element('select');
    for (const [key, text] of values) field.add(new Option(text, key));
    field.value = value;
    return field;
}

export function disclosure(title: string, ...contents: Node[]): HTMLDetailsElement {
    const box = element('details', undefined, 'tracker-disclosure');
    box.append(element('summary', title), ...contents);
    return box;
}

export function submit(text: string): HTMLButtonElement {
    const button = element('button', text, 'tracker-button tracker-primary');
    button.type = 'submit';
    return button;
}

export function textStatus(text = ''): HTMLParagraphElement {
    const status = element('p', text, 'tracker-message');
    status.setAttribute('role', 'status');
    return status;
}

export function deletionForm(subject: 'home' | 'collection', onDelete: () => void): HTMLElement {
    const form = element('form', undefined, 'tracker-form');
    const confirmation = input('text', '', true);
    confirmation.pattern = 'DELETE';
    confirmation.autocomplete = 'off';
    form.append(element('p', subject === 'home'
        ? 'This permanently deletes the home, its contacts, notes and history.'
        : 'This permanently deletes the collection and all its homes, contacts, notes and history.'),
    label('Type DELETE to confirm', confirmation), submit(`Permanently delete ${subject}`));
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (confirmation.value === 'DELETE') onDelete();
    });
    return form;
}

export function link(text: string, target?: string): HTMLAnchorElement | null {
    try {
        const url = new URL(target ?? '');
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
        const anchor = element('a', text, 'tracker-link');
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        return anchor;
    } catch { return null; }
}

export const sgd = new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium' });

export function dateLabel(timestamp?: number | null): string {
    return timestamp != null && Number.isFinite(timestamp) ? date.format(timestamp) : 'Unknown';
}

export function asking(cents?: number | null): string {
    return cents == null ? 'Asking price unknown' : `Asking ${sgd.format(cents / 100)}`;
}

export function observed(timestamp?: number | null): string {
    return timestamp == null ? 'Observation date unknown' : `Observed ${dateLabel(timestamp)}`;
}

export function errorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error && 'data' in error) {
        const data = error.data;
        if (typeof data === 'string') return data;
        if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') return data.message;
    }
    return fallback;
}

export const flatTypes = ['1 ROOM', '2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE', 'MULTI-GENERATION'] as const;
