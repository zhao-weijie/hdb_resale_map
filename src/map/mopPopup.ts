function popupElement<K extends keyof HTMLElementTagNameMap>(
    tag: K, text = '', style = ''
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.textContent = text;
    node.style.cssText = style;
    return node;
}

function displayText(value: unknown, fallback = ''): string {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return fallback;
}

function brochureLink(value: unknown): HTMLAnchorElement | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        const link = popupElement('a', 'View Brochure →', 'color: #3b82f6; text-decoration: none; font-weight: 500;');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    } catch {
        return null;
    }
}

export function createMopPopup(properties: Record<string, unknown>): HTMLElement {
    const content = popupElement('div', '', 'padding: 10px; min-width: 220px;');
    const heading = popupElement('h3', displayText(properties.PROJECT_NAME, 'Unknown project'),
        'margin: 0 0 4px 0; font-size: 16px; font-weight: 600;');
    const verification = popupElement('div', '', 'margin-bottom: 8px; font-size: 12px;');
    const name = displayText(properties.BTO_NAME_SCRAPED);
    verification.append(name
        ? popupElement('span', `✓ Verified: ${name}`, 'color: #059669;')
        : popupElement('span', '⚠ Unverified Source', 'color: #d97706;'));

    const details = popupElement('div', '',
        'display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin-bottom: 12px;');
    details.append(
        popupElement('strong', 'Type:'), popupElement('div', displayText(properties.PROJECT_TYPE, 'Unknown')),
        popupElement('strong', 'Units:'), popupElement('div', displayText(properties.TOTAL_UNITS, 'N/A')),
        popupElement('strong', 'MOP Expiry:'), popupElement('div', displayText(properties.MOP_EXPIRY_Q, 'Unknown')),
        popupElement('div', displayText(properties.MOP_EXPIRY_DATE), 'grid-column: 2; font-size: 11px; color: #888;'),
    );

    const brochure = popupElement('div', '', 'border-top: 1px solid #eee; padding-top: 8px;');
    brochure.append(brochureLink(properties.BROCHURE_LINK)
        ?? popupElement('span', 'No Brochure', 'color: #999; font-style: italic;'));
    content.append(heading, verification, details, brochure);
    return content;
}
