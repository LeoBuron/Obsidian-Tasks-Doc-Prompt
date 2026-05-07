import { diffSnapshot, snapshotLines, type TaskLineSnapshot } from '../../src/detection/FileWatchDetector';

describe('snapshotLines', () => {
    test('extracts only task lines and records line number, status, hash', () => {
        const lines = [
            '# Heading',
            '- [ ] todo one',
            'plain text',
            '- [x] done one ^abc',
        ];
        const snaps = snapshotLines(lines);
        expect(snaps.map(s => ({ line: s.lineNumber, status: s.statusSymbol })))
            .toEqual([
                { line: 1, status: ' ' },
                { line: 3, status: 'x' },
            ]);
        expect(snaps[1].blockId).toBe('abc');
    });

    test('descriptionHash is stable across status change', () => {
        const a = snapshotLines(['- [ ] same text']);
        const b = snapshotLines(['- [x] same text']);
        expect(a[0].descriptionHash).toBe(b[0].descriptionHash);
    });
});

describe('diffSnapshot', () => {
    const doneSymbols = ['x', 'X'];

    test('emits event when status flips from open to done', () => {
        const oldSnaps: TaskLineSnapshot[] = snapshotLines(['- [ ] write report']);
        const newLines = ['- [x] write report'];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events).toHaveLength(1);
        expect(events[0].previousStatus).toBe(' ');
        expect(events[0].newStatus).toBe('x');
        expect(events[0].lineNumber).toBe(0);
        expect(events[0].taskLine).toBe('- [x] write report');
    });

    test('does not emit when status is already done and stays done', () => {
        const oldSnaps = snapshotLines(['- [x] write report']);
        const newLines = ['- [x] write report'];
        expect(diffSnapshot(oldSnaps, newLines, doneSymbols)).toEqual([]);
    });

    test('does not emit when toggling from done back to open', () => {
        const oldSnaps = snapshotLines(['- [x] write report']);
        const newLines = ['- [ ] write report'];
        expect(diffSnapshot(oldSnaps, newLines, doneSymbols)).toEqual([]);
    });

    test('ignores transitions between non-done symbols (e.g. " " → "/")', () => {
        const oldSnaps = snapshotLines(['- [ ] task']);
        const newLines = ['- [/] task'];
        expect(diffSnapshot(oldSnaps, newLines, doneSymbols)).toEqual([]);
    });

    test('matches by description hash so a recurrence-inserted new line does not produce phantom events', () => {
        // Recurrence: original line is now [x]; a new [ ] line is inserted above it.
        const oldSnaps = snapshotLines(['- [ ] daily standup 🔁 every day']);
        const newLines = [
            '- [ ] daily standup 🔁 every day',
            '- [x] daily standup 🔁 every day ✅ 2026-05-07',
        ];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events).toHaveLength(1);
        expect(events[0].newStatus).toBe('x');
        expect(events[0].lineNumber).toBe(1);
    });

    test('multiple completions in one diff produce one event each', () => {
        const oldSnaps = snapshotLines([
            '- [ ] a',
            '- [ ] b',
            '- [ ] c',
        ]);
        const newLines = [
            '- [x] a',
            '- [ ] b',
            '- [x] c',
        ];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events.map(e => e.lineNumber)).toEqual([0, 2]);
    });

    test('extracts blockId when present on completed line', () => {
        const oldSnaps = snapshotLines(['- [ ] task ^xyz']);
        const newLines = ['- [x] task ^xyz'];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events[0].blockId).toBe('xyz');
    });

    test('treats configurable extra done symbols as done', () => {
        const oldSnaps = snapshotLines(['- [ ] task']);
        const newLines = ['- [D] task'];
        expect(diffSnapshot(oldSnaps, newLines, ['D'])).toHaveLength(1);
    });
});
