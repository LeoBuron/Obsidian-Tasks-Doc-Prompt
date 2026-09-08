import { Notice, type FakeEl } from 'obsidian';
import { DocumentationModal, type ModalPrefill } from '../../src/ui/DocumentationModal';

const app = {} as any;

function openModal(taskLine: string, prefill?: ModalPrefill) {
    const modal = new DocumentationModal(app, taskLine, prefill);
    const result = modal.show();
    const content = modal.contentEl as FakeEl;
    const area = (cls: string) => content.find((el) => el.tag === 'textarea' && el.cls === cls);
    return {
        result,
        button: (label: string) => content.find((el) => el.tag === 'button' && el.text === label),
        doc: () => area('tdp-textarea-doc')!,
        followUp: () => area('tdp-textarea-followup')!,
        textareas: () => content.findAll((el) => el.tag === 'textarea'),
    };
}

beforeEach(() => { Notice.messages = []; });

describe('DocumentationModal — documentation and follow-up fields', () => {
    test('renders exactly two textareas and no "Create follow-up" button', () => {
        const m = openModal('- [x] write report #work');
        expect(m.textareas()).toHaveLength(2);
        expect(m.doc()).not.toBeNull();
        expect(m.followUp()).not.toBeNull();
        expect(m.button('Create follow-up')).toBeNull();
    });

    test('Save settles with both fields', async () => {
        const m = openModal('- [x] write report #work');
        m.doc().value = 'Drafted v1.';
        m.followUp().value = 'send it to Bob';
        m.button('Save')!.click();
        await expect(m.result).resolves.toEqual({
            kind: 'save',
            documentation: 'Drafted v1.',
            followUp: 'send it to Bob',
        });
    });

    test('a blank follow-up is accepted without a notice — the field is optional', async () => {
        const m = openModal('- [x] write report #work');
        m.doc().value = 'Drafted v1.';
        m.followUp().value = '   ';
        m.button('Save')!.click();
        await expect(m.result).resolves.toEqual({
            kind: 'save',
            documentation: 'Drafted v1.',
            followUp: '   ',
        });
        expect(Notice.messages).toEqual([]);
    });

    test('a follow-up alone is accepted — documentation is optional too', async () => {
        const m = openModal('- [x] write report #work');
        m.followUp().value = 'send it to Bob';
        m.button('Save')!.click();
        await expect(m.result).resolves.toEqual({
            kind: 'save',
            documentation: '',
            followUp: 'send it to Bob',
        });
        expect(Notice.messages).toEqual([]);
    });

    test('Cmd/Ctrl+Enter in the documentation field saves both fields', async () => {
        const m = openModal('- [x] write report #work');
        m.doc().value = 'Drafted v1.';
        m.followUp().value = 'send it to Bob';
        m.doc().dispatch('keydown', { metaKey: true, key: 'Enter' });
        await expect(m.result).resolves.toEqual({
            kind: 'save',
            documentation: 'Drafted v1.',
            followUp: 'send it to Bob',
        });
    });

    test('Cmd/Ctrl+Enter in the follow-up field saves both fields', async () => {
        const m = openModal('- [x] write report #work');
        m.doc().value = 'Drafted v1.';
        m.followUp().value = 'send it to Bob';
        m.followUp().dispatch('keydown', { ctrlKey: true, key: 'Enter' });
        await expect(m.result).resolves.toEqual({
            kind: 'save',
            documentation: 'Drafted v1.',
            followUp: 'send it to Bob',
        });
    });

    test('Shift no longer changes what Cmd/Ctrl+Enter does (guard)', async () => {
        const m = openModal('- [x] write report #work');
        m.doc().value = 'Drafted v1.';
        m.doc().dispatch('keydown', { metaKey: true, shiftKey: true, key: 'Enter' });
        await expect(m.result).resolves.toEqual({
            kind: 'save',
            documentation: 'Drafted v1.',
            followUp: '',
        });
    });

    test('edit mode (deferred-entry editing) shows neither field nor Save (guard)', () => {
        const m = openModal('- [x] write report #work', { remindAt: 1_000_000 });
        expect(m.textareas()).toHaveLength(0);
        expect(m.button('Save')).toBeNull();
    });
});
