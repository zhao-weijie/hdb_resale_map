import type { Doc } from '../../convex/_generated/dataModel';
import { element, select } from './dom';

export const progressLabels = {
    new: 'New',
    contacted: 'Contacted',
    viewing_booked: 'Viewing booked',
    viewed: 'Viewed',
    negotiating: 'Negotiating',
    offer_submitted: 'Offer submitted',
    passed: 'Passed',
    lost: 'Lost',
} satisfies Record<Doc<'candidates'>['progress'], string>;

const { passed, lost, ...openProgressLabels } = progressLabels;

export function progressSelect(value: string, includeAll = false): HTMLSelectElement {
    const control = select(Object.entries(openProgressLabels), value);
    if (includeAll) control.prepend(new Option('All progress', ''));
    const closed = element('optgroup');
    closed.label = 'Closed';
    closed.append(new Option(passed, 'passed'), new Option(lost, 'lost'));
    control.append(closed);
    control.value = value;
    return control;
}
