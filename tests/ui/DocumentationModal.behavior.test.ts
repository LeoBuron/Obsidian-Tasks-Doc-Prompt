import { Notice, type FakeEl } from 'obsidian';
import { DocumentationModal, type ModalPrefill, type ModalResult } from '../../src/ui/DocumentationModal';

const app = {} as any;

function openModal(taskLine: string, prefill?: ModalPrefill) {
    const modal = new DocumentationModal(app, taskLine, prefill);
    const result = modal.show();
    const content = modal.contentEl as FakeEl;
    return {
        result,
        button: (label: string) => content.find((el) => el.tag === 'button' && el.text === label),
        textarea: () => content.find((el) => el.tag === 'textarea')!,
    };
}

/** True once `p` has settled, after letting one macrotask tick pass. */
async function isSettled(p: Promise<ModalResult>): Promise<boolean> {
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    return settled;
}

beforeEach(() => { Notice.messages = []; });

describe('DocumentationModal — Create follow-up', () => {
    test('offers a "Create follow-up" button in normal mode', () => {
        const m = openModal('- [x] write report #work');
        expect(m.button('Create follow-up')).not.toBeNull();
    });

    test('clicking it with text settles a follow-up result carrying the textarea text', async () => {
        const m = openModal('- [x] write report #work');
        m.textarea().value = 'send it to Bob';
        m.button('Create follow-up')!.click();
        await expect(m.result).resolves.toEqual({ kind: 'follow-up', text: 'send it to Bob' });
    });

    test('clicking it with blank text shows a notice and keeps the modal open', async () => {
        const m = openModal('- [x] write report #work');
        m.textarea().value = '   ';
        m.button('Create follow-up')!.click();

        expect(await isSettled(m.result)).toBe(false);
        expect(Notice.messages).toHaveLength(1);

        // Still usable afterwards.
        m.textarea().value = 'Drafted v1.';
        m.button('Save')!.click();
        await expect(m.result).resolves.toEqual({ kind: 'save', text: 'Drafted v1.' });
    });

    test('Cmd/Ctrl+Shift+Enter in the textarea creates a follow-up', async () => {
        const m = openModal('- [x] write report #work');
        m.textarea().value = 'send it to Bob';
        m.textarea().dispatch('keydown', { metaKey: true, shiftKey: true, key: 'Enter' });
        await expect(m.result).resolves.toEqual({ kind: 'follow-up', text: 'send it to Bob' });
    });

    test('Cmd/Ctrl+Enter without Shift still saves a comment (guard)', async () => {
        const m = openModal('- [x] write report #work');
        m.textarea().value = 'Drafted v1.';
        m.textarea().dispatch('keydown', { ctrlKey: true, key: 'Enter' });
        await expect(m.result).resolves.toEqual({ kind: 'save', text: 'Drafted v1.' });
    });

    test('edit mode (deferred-entry editing) does not offer the button (guard)', () => {
        const m = openModal('- [x] write report #work', { remindAt: 1_000_000 });
        expect(m.button('Create follow-up')).toBeNull();
        expect(m.button('Save')).toBeNull();
    });
});
