import type { FunctionArgs } from 'convex/server';
import type { api } from '../../convex/_generated/api';
import type { Doc } from '../../convex/_generated/dataModel';
import { action, element, flatTypes, group, input, label, select, submit, textStatus } from './dom';
import { lookupPostal, type BlockLookup } from './geocodes';
import { areaMeasurement, floorMeasurement } from './homeMeasurements';
import { customEditor } from './TrackerColumns';

type Patch = FunctionArgs<typeof api.tracker.editCandidate>['patch'];

export function homeEditor(home: Doc<'candidates'>, fields: Doc<'customFields'>[], save: (patch: Patch) => Promise<void>): HTMLFormElement {
    const form = element('form', undefined, 'tracker-form');
    const controls = element('fieldset', undefined, 'tracker-edit-fields');
    const location = home.location;
    const address = input('text', location.rawAddress);
    address.maxLength = 500;
    const title = input('text', home.title);
    title.maxLength = 120;
    const unit = input('text', location.unitNumber);
    unit.maxLength = 120;
    const postal = input('text', location.postalCode);
    postal.pattern = '[0-9]{6}';
    postal.maxLength = 6;
    postal.inputMode = 'numeric';

    const facts = home.summary.facts;
    const flatType = select([['', 'Unknown'], ...flatTypes.map((value) => [value, value] as const)], facts.flatType?.value ?? '');
    const savedArea = facts.area?.value;
    const area = input('number', savedArea == null ? '' : String(savedArea.originalValue));
    area.min = String(Number.MIN_VALUE);
    area.step = 'any';
    const areaUnit = select([['sqm', 'm²'], ['sqft', 'sq ft']], savedArea?.originalUnit ?? 'sqm');
    const savedFloor = facts.floor?.value;
    const floor = input('text', savedFloor?.originalText ?? (savedFloor?.kind === 'exact' ? String(savedFloor.value)
        : savedFloor?.kind === 'range' ? `${savedFloor.min}–${savedFloor.max}` : ''));
    floor.placeholder = 'Example 08 or 07–09';
    floor.maxLength = 120;
    const initialFloor = floor.value;
    floor.addEventListener('input', () => floor.setCustomValidity(''));

    const saveButton = submit('Save changes');
    const blockStatus = textStatus();
    let block: BlockLookup | null = null;
    let lookupRequest = 0;
    const lookup = action('Look up block', () => {
        const request = ++lookupRequest;
        lookup.disabled = true;
        saveButton.disabled = true;
        block = null;
        blockStatus.textContent = 'Looking up the block…';
        void lookupPostal(postal.value, true).then((match) => {
            if (request !== lookupRequest || !form.isConnected) return;
            block = match;
            blockStatus.textContent = match ? `Block match · ${match.address}` : 'No unique block match. Check the postal code or save the home without a map pin.';
        }).catch(() => {
            if (request === lookupRequest && form.isConnected) blockStatus.textContent = 'Block lookup is unavailable. Try again or save without a new match.';
        }).finally(() => {
            if (request !== lookupRequest || !form.isConnected) return;
            lookup.disabled = false;
            saveButton.disabled = false;
        });
    });
    const resetLookup = () => {
        lookupRequest += 1;
        block = null;
        lookup.disabled = !/^\d{6}$/.test(postal.value);
        const mapped = postal.value === location.postalCode && (location.status === 'matched' || location.status === 'confirmed');
        blockStatus.textContent = !lookup.disabled && !mapped ? 'Look up the block to place this home on the map.' : '';
        saveButton.disabled = false;
    };
    resetLookup();
    postal.addEventListener('input', resetLookup);

    controls.append(label('Full address', address), group(label('Unit number', unit), label('Postal code', postal)),
        group(lookup), blockStatus, label('Custom label', title), label('Flat type', flatType),
        group(label('Floor area', area), label('Area unit', areaUnit)), label('Floor or floor range', floor));
    const custom = fields.filter((field) => field.state === 'active').map((field) => customEditor(field, home));
    if (custom.length) {
        const customFields = element('fieldset');
        customFields.append(element('legend', 'Custom fields'), ...custom.map((editor) => editor.wrapper));
        controls.append(customFields);
    }
    form.append(controls, group(saveButton));

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (saveButton.disabled) return;
        const patch: Patch = {};
        const rawAddress = address.value.trim() || null;
        const unitNumber = unit.value.trim() || null;
        const postalCode = postal.value || null;
        const buyerLabel = title.value.trim() || null;
        if (buyerLabel !== (home.title ?? null)) patch.title = buyerLabel;
        const samePostal = postalCode === (location.postalCode ?? null);
        if (block || !samePostal || rawAddress !== (location.rawAddress ?? null) || unitNumber !== (location.unitNumber ?? null)) {
            patch.location = block
                ? { rawAddress, unitNumber, postalCode, status: 'confirmed', matchMethod: 'buyer_selected', geocodeVersion: block.version }
                : { rawAddress, unitNumber, postalCode, status: samePostal ? location.status : 'unresolved' };
        }

        const buyerFacts: NonNullable<Patch['buyerFacts']> = {};
        if (flatType.value !== (facts.flatType?.value ?? '')) {
            buyerFacts.flatType = { value: flatTypes.find((value) => value === flatType.value) ?? null };
        }
        const areaValue = area.value ? area.valueAsNumber : null;
        const areaUnitValue = areaUnit.value === 'sqft' ? 'sqft' : 'sqm';
        if (areaValue !== (savedArea?.originalValue ?? null) || (areaValue !== null && areaUnitValue !== savedArea?.originalUnit)) {
            buyerFacts.area = { value: areaValue === null ? null : areaMeasurement(areaValue, areaUnitValue) };
        }
        const floorText = floor.value.trim();
        if (floorText !== initialFloor.trim()) {
            const floorValue = floorMeasurement(floorText);
            if (floorText && !floorValue) {
                floor.setCustomValidity('Enter a whole-number floor or a range such as 07–09.');
                floor.reportValidity();
                return;
            }
            buyerFacts.floor = { value: floorValue ?? null };
        }
        if (Object.keys(buyerFacts).length) patch.buyerFacts = buyerFacts;
        const customValues = custom.flatMap((editor) => editor.value() ?? []);
        if (customValues.length) patch.customValues = customValues;
        controls.disabled = saveButton.disabled = true;
        void save(patch).finally(() => { controls.disabled = saveButton.disabled = false; });
    });
    return form;
}
