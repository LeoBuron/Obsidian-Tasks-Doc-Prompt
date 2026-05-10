import { TFile } from 'obsidian';
import { computeId, computeIdFromLine, stripTasksFields } from '../../src/identity/TaskIdentity';
import type { CompletionEvent } from '../../src/detection/types';

function ev(taskLine: string, opts: Partial<CompletionEvent> = {}): CompletionEvent {
    return {
        file: opts.file ?? new TFile('Notes/test.md'),
        lineNumber: opts.lineNumber ?? 0,
        taskLine,
        previousStatus: opts.previousStatus ?? ' ',
        newStatus: opts.newStatus ?? 'x',
        blockId: opts.blockId,
    };
}

describe('stripTasksFields', () => {
    test('removes status marker and surrounding whitespace', () => {
        expect(stripTasksFields('  - [x] write the report')).toBe('write the report');
    });

    test('removes Tasks emoji metadata fields', () => {
        const line = '- [x] write the report 📅 2026-05-10 ⏳ 2026-05-08 🔼';
        expect(stripTasksFields(line)).toBe('write the report');
    });

    test('removes Dataview-style inline fields', () => {
        const line = '- [x] write the report [due:: 2026-05-10] [priority:: high]';
        expect(stripTasksFields(line)).toBe('write the report');
    });

    test('removes done-date emoji on completed tasks', () => {
        expect(stripTasksFields('- [x] done thing ✅ 2026-05-07')).toBe('done thing');
    });

    test('removes recurrence rule', () => {
        expect(stripTasksFields('- [x] daily standup 🔁 every day')).toBe('daily standup');
    });

    test('removes block-ID at end', () => {
        expect(stripTasksFields('- [x] write report ^abc123')).toBe('write report');
    });
});

describe('computeId', () => {
    test('uses block-ID when present', () => {
        const e = ev('- [x] anything ^xyz', { blockId: 'xyz' });
        expect(computeId(e)).toBe('block:xyz');
    });

    test('block-ID wins even when description differs', () => {
        const a = ev('- [x] write report ^xyz', { blockId: 'xyz' });
        const b = ev('- [x] totally different text ^xyz', { blockId: 'xyz' });
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id is stable across status change', () => {
        const a = ev('- [ ] write report');
        const b = ev('- [x] write report');
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id is stable across date metadata change', () => {
        const a = ev('- [x] write report 📅 2026-05-10');
        const b = ev('- [x] write report 📅 2026-05-11 ✅ 2026-05-10');
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id is stable across priority change', () => {
        const a = ev('- [x] write report 🔼');
        const b = ev('- [x] write report 🔺');
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id changes when description is reworded', () => {
        const a = ev('- [x] write report');
        const b = ev('- [x] write the final report');
        expect(computeId(a)).not.toBe(computeId(b));
    });

    test('id includes file path so same description in different files differs', () => {
        const a = ev('- [x] write report', { file: new TFile('A/note.md') });
        const b = ev('- [x] write report', { file: new TFile('B/note.md') });
        expect(computeId(a)).not.toBe(computeId(b));
    });
});

describe('computeIdFromLine', () => {
    test('produces same id as computeId for an event with no block id', () => {
        const taskLine = '- [x] write report';
        const filePath = 'Work/notes.md';
        const fromLine = computeIdFromLine(filePath, taskLine);
        const fromEvent = computeId({
            file: { path: filePath } as any,
            lineNumber: 0,
            taskLine,
            previousStatus: ' ',
            newStatus: 'x',
        });
        expect(fromLine).toBe(fromEvent);
    });

    test('produces same id as computeId for an event with a block id at end of line', () => {
        const taskLine = '- [x] write report ^abc-123';
        const filePath = 'Work/notes.md';
        const fromLine = computeIdFromLine(filePath, taskLine);
        const fromEvent = computeId({
            file: { path: filePath } as any,
            lineNumber: 0,
            taskLine,
            previousStatus: ' ',
            newStatus: 'x',
            blockId: 'abc-123',
        });
        expect(fromLine).toBe(fromEvent);
        expect(fromLine).toBe('block:abc-123');
    });

    test('strips Tasks emojis and dataview fields like computeId does', () => {
        const filePath = 'Work/notes.md';
        const a = computeIdFromLine(filePath, '- [x] foo 📅 2026-05-10 ✅ 2026-05-10');
        const b = computeIdFromLine(filePath, '- [x] foo');
        expect(a).toBe(b);
    });
});
