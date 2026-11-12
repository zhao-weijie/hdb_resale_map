import type { ConvexClient } from 'convex/browser';
import type { Infer } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Doc } from '../../convex/_generated/dataModel';
import type { customValueEdit } from '../../convex/trackerTypes';
import { action, disclosure, element, errorMessage, group, input, label, select, submit, textStatus } from './dom';

type Field = Doc<'customFields'>;
type Home = Doc<'candidates'>;
type Collection = Doc<'collections'>;
type Edit = Infer<typeof customValueEdit>;
const types = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['checkbox', 'Checkbox'], ['single_select', 'Single select']] as const;

export function renderCustomValue(field: Field, home: Home): string {
    const value = home.customValues.find((item) => item.fieldId === field.publicId);
    if (!value) return '—';
    if (value.type === 'single_select') return field.options.find((option) => option.id === value.optionId)?.label ?? 'Unknown option';
    if (value.type === 'checkbox') return value.value ? 'Yes' : 'No';
    return String(value.value);
}

export function customEditor(field: Field, home: Home): { wrapper: HTMLElement; value(): Edit | undefined } {
    const prior = home.customValues.find((item) => item.fieldId === field.publicId);
    const fieldId = field.publicId;
    const initial = prior?.type === 'single_select' ? prior.optionId : prior ? String(prior.value) : '';
    let control: HTMLInputElement | HTMLSelectElement;
    if (field.type === 'single_select') {
        const options = field.options.filter((option) => !option.archived || option.id === initial);
        control = select([['', 'Unset'], ...options.map(({ id, label, archived }) => [id, archived ? `${label} (archived)` : label] as const)], initial);
    } else if (field.type === 'checkbox') {
        control = select([['', 'Unset'], ['true', 'Yes'], ['false', 'No']], initial);
    } else {
        control = input(field.type, initial);
        if (field.type === 'number') control.step = 'any';
        if (field.type === 'text') control.maxLength = 2_000;
    }
    return {
        wrapper: label(field.label, control),
        value: () => {
            const value = control.value;
            if (value === initial) return undefined;
            if (value === '') return { fieldId, type: 'unset' };
            if (field.type === 'single_select') return { fieldId, type: 'single_select', optionId: value };
            if (field.type === 'checkbox') return { fieldId, type: 'checkbox', value: value === 'true' };
            if (field.type === 'number') return { fieldId, type: 'number', value: Number(value) };
            return { fieldId, type: field.type, value };
        },
    };
}

type Options = {
    onClose(): void;
    onChanged(): void;
    onVisibility(hidden: Set<string>): void;
    currentCollection(): Collection | undefined;
};

export function mountColumns(
    host: HTMLElement, client: ConvexClient, collectionId: Collection['_id'], initialFields: Field[], initialHidden: Set<string>, options: Options,
): void {
    let fields = initialFields;
    const hidden = new Set(initialHidden);
    const status = textStatus();
    const actions = new Map<string, string>();
    let busy = false;

    async function save(key: string, mutate: (operationId: string) => Promise<unknown>, after?: () => void): Promise<void> {
        if (busy) return;
        const operationId = actions.get(key) ?? crypto.randomUUID();
        actions.set(key, operationId);
        status.textContent = 'Saving…';
        busy = true;
        try {
            await mutate(operationId);
            actions.delete(key);
            fields = await client.query(api.tracker.listCustomFields, { collectionId });
            options.onChanged();
            after?.();
            status.textContent = 'Saved.';
            if (!host.hidden) render();
        } catch (error) {
            status.textContent = errorMessage(error, 'Your columns could not be saved. Your entries are still here.');
        } finally { busy = false; }
    }

    function editor(existing?: Field): HTMLElement {
        const form = element('form', undefined, 'tracker-form');
        const fieldName = input('text', existing?.label ?? '', true);
        fieldName.maxLength = 120;
        const type = select(types, existing?.type ?? 'text');
        type.disabled = !!existing;
        const optionList = element('div', undefined, 'tracker-form');
        const rows: Array<{ id: string; field: HTMLInputElement; archived: HTMLInputElement }> = [];
        const addOption = action('Add option', () => optionRow());
        function optionRow(option?: Field['options'][number]) {
            const field = input('text', option?.label ?? '', true);
            field.maxLength = 120;
            const archived = input('checkbox'); archived.checked = option?.archived ?? false;
            const archivedLabel = label('Archived', archived); archivedLabel.classList.add('tracker-checkbox');
            rows.push({ id: option?.id ?? crypto.randomUUID(), field, archived });
            optionList.insertBefore(group(label('Option name', field), archivedLabel), addOption);
            if (rows.length >= 50) addOption.disabled = true;
        }
        optionList.append(addOption);
        existing?.options.forEach(optionRow);
        const sync = () => {
            optionList.hidden = type.value !== 'single_select';
            for (const row of rows) row.field.disabled = optionList.hidden;
        };
        type.addEventListener('change', sync); sync();
        const saveButton = submit(existing ? 'Save column' : 'Create column');
        if (!existing && fields.length >= 30) saveButton.disabled = true;
        form.append(label('Column name', fieldName), label('Field type', type), optionList, saveButton);
        const write = (state?: Field['state']) => {
            if (!form.reportValidity()) return;
            const selected = type.value as Field['type'];
            const choices = selected === 'single_select'
                ? rows.map((option) => ({ id: option.id, label: option.field.value.trim(), archived: option.archived.checked })) : [];
            const args = { collectionId, fieldId: existing?._id, expectedRevision: existing?.revision,
                label: fieldName.value.trim(), type: selected, options: choices, state };
            void save(JSON.stringify(args), (operationId) => client.mutation(api.tracker.saveCustomField, { ...args, operationId }));
        };
        if (existing) form.append(action(existing.state === 'active' ? 'Archive column' : 'Restore column',
            () => write(existing.state === 'active' ? 'archived' : 'active'), 'tracker-button tracker-quiet'));
        form.addEventListener('submit', (event) => { event.preventDefault(); write(); });
        return form;
    }

    function render() {
        const back = action('Back to saved homes', options.onClose, 'tracker-button tracker-quiet');
        const title = element('h2', 'Columns');
        const visibility = element('form', undefined, 'tracker-form');
        visibility.append(element('h3', 'Shown in the wide table'));
        for (const field of fields.filter((item) => item.state === 'active')) {
            const checkbox = input('checkbox');
            checkbox.checked = !hidden.has(field.publicId);
            checkbox.addEventListener('change', () => { if (checkbox.checked) hidden.delete(field.publicId); else hidden.add(field.publicId); });
            const wrapper = label(field.label, checkbox);
            wrapper.classList.add('tracker-checkbox');
            visibility.append(wrapper);
        }
        if (visibility.childNodes.length > 1) visibility.append(submit('Save visible columns'));
        else visibility.append(element('p', 'Add a custom column to show more details in the wide table.'));
        visibility.addEventListener('submit', (event) => {
            event.preventDefault();
            const collection = options.currentCollection();
            if (!collection || collection._id !== collectionId) return;
            const args = { collectionId, expectedRevision: collection.revision, trackerView: {
                ...collection.trackerView, hiddenColumns: [...hidden],
            } };
            void save(JSON.stringify(args), (operationId) => client.mutation(api.tracker.updateCollection, { ...args, operationId }),
                () => options.onVisibility(new Set(hidden)));
        });
        host.replaceChildren(back, title, status, visibility, element('p', `${fields.length} of 30 definitions · Includes archived columns`, 'tracker-meta'));
        if (fields.length < 30) host.append(disclosure('Add custom column', editor()));
        for (const field of fields) host.append(disclosure(field.state === 'archived' ? `${field.label} (archived)` : field.label, editor(field)));
    }
    render();
    host.querySelector('button')?.focus();
}
