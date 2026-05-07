import { composeSubBullet } from '../../src/persistence/SubBulletWriter';

describe('composeSubBullet', () => {
    test('inserts indented sub-bullet under top-level task using spaces', () => {
        const lines = [
            '# Notes',
            '- [x] write report',
            '- [ ] another task',
        ];
        const out = composeSubBullet(lines, 1, 'Drafted v1, sent for review.', { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '# Notes',
            '- [x] write report',
            '    - Drafted v1, sent for review.',
            '- [ ] another task',
        ]);
    });

    test('inserts indented sub-bullet using tab indentation', () => {
        const lines = ['- [x] write report'];
        const out = composeSubBullet(lines, 0, 'Drafted v1.', { indentWithTabs: true, tabSize: 4 });
        expect(out).toEqual([
            '- [x] write report',
            '\t- Drafted v1.',
        ]);
    });

    test('preserves existing indentation of nested task and indents one further step', () => {
        const lines = [
            '- [ ] parent',
            '    - [x] nested task',
        ];
        const out = composeSubBullet(lines, 1, 'Did the thing.', { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '- [ ] parent',
            '    - [x] nested task',
            '        - Did the thing.',
        ]);
    });

    test('preserves tab-indented nested task and adds one more tab', () => {
        const lines = [
            '- [ ] parent',
            '\t- [x] nested',
        ];
        const out = composeSubBullet(lines, 1, 'Done.', { indentWithTabs: true, tabSize: 4 });
        expect(out).toEqual([
            '- [ ] parent',
            '\t- [x] nested',
            '\t\t- Done.',
        ]);
    });

    test('multi-line user text gets first line as bullet, continuation lines indented further', () => {
        const lines = ['- [x] write report'];
        const text = 'First line.\nSecond line.\nThird line.';
        const out = composeSubBullet(lines, 0, text, { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '- [x] write report',
            '    - First line.',
            '      Second line.',
            '      Third line.',
        ]);
    });

    test('trims trailing whitespace and ignores trailing blank lines in user text', () => {
        const out = composeSubBullet(['- [x] t'], 0, 'one\n\n', { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '- [x] t',
            '    - one',
        ]);
    });

    test('throws if lineIndex is out of range', () => {
        expect(() => composeSubBullet(['- [x] t'], 5, 'x', { indentWithTabs: false, tabSize: 4 }))
            .toThrow();
    });
});
