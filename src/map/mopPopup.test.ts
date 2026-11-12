import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMopPopup } from './mopPopup';

class PopupNode {
    readonly children: PopupNode[] = [];
    readonly style = { cssText: '' };
    textContent = '';

    constructor(readonly tag: string) {}

    append(...nodes: PopupNode[]) {
        this.children.push(...nodes);
    }
}

function popupNodes(properties: Record<string, unknown>): PopupNode[] {
    const content = createMopPopup(properties) as unknown as PopupNode;
    const descendants = (node: PopupNode): PopupNode[] => [node, ...node.children.flatMap(descendants)];
    return descendants(content);
}

describe('MOP popup', () => {
    beforeEach(() => {
        vi.stubGlobal('document', { createElement: (tag: string) => new PopupNode(tag) });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('renders project names and source labels as text', () => {
        const markup = '<img src=x onerror="alert(1)">';
        const nodes = popupNodes({ PROJECT_NAME: markup, BTO_NAME_SCRAPED: markup });
        expect(nodes.find(node => node.tag === 'h3')?.textContent).toBe(markup);
        expect(nodes.map(node => node.textContent)).toContain(`✓ Verified: ${markup}`);
        expect(nodes.some(node => node.tag === 'img')).toBe(false);
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        '//example.invalid/brochure',
        'https://user:password@example.invalid/brochure',
    ])('omits unsafe brochure URL %s', (url) => {
        const nodes = popupNodes({ BROCHURE_LINK: url });
        expect(nodes.some(node => node.tag === 'a')).toBe(false);
        expect(nodes.map(node => node.textContent)).toContain('No Brochure');
    });

    it('opens a valid brochure in an isolated new tab', () => {
        const href = 'https://example.invalid/brochure.pdf';
        const nodes = popupNodes({ BROCHURE_LINK: href });
        expect(nodes.find(node => node.tag === 'a')).toMatchObject({
            href, target: '_blank', rel: 'noopener noreferrer',
        });
    });
});
