import { extractTags, composeFollowUpText } from '../../src/persistence/FollowUpTask';
import { composeFollowUpTask } from '../../src/persistence/SubBulletWriter';

describe('extractTags', () => {
    test('returns hashtags from the description in order of appearance', () => {
        expect(extractTags('- [x] fix #bug in the parser #work')).toEqual(['#bug', '#work']);
    });

    test('returns an empty list when the line has no tags', () => {
        expect(extractTags('- [x] plain task 📅 2026-09-01')).toEqual([]);
    });

    test('keeps tags placed after Tasks emoji fields, as Tasks does', () => {
        expect(extractTags('- [x] write report 📅 2026-09-01 ✅ 2026-09-07 #work')).toEqual(['#work']);
    });

    test('supports nested tags', () => {
        expect(extractTags('- [x] task #project/alpha')).toEqual(['#project/alpha']);
    });

    test('ignores a # that is not preceded by whitespace', () => {
        expect(extractTags('- [x] see [[Note#Heading]] and foo#bar')).toEqual([]);
    });

    test('dedupes repeated tags case-insensitively, keeping the first spelling', () => {
        expect(extractTags('- [x] a #Work b #work c #WORK')).toEqual(['#Work']);
    });

    test('any whitespace ends a tag, so a tab-separated field after it is not swallowed', () => {
        expect(extractTags('- [x] report #work\t📅\t2026-09-10')).toEqual(['#work']);
    });

    test('does not treat the block id as a tag', () => {
        expect(extractTags('- [x] task ^abc123')).toEqual([]);
    });
});

describe('composeFollowUpText', () => {
    test('prefixes an open checkbox and appends the parent tags', () => {
        expect(composeFollowUpText('ping Bob', ['#work'])).toBe('[ ] ping Bob #work');
    });

    test('produces a plain open task when the parent has no tags', () => {
        expect(composeFollowUpText('ping Bob', [])).toBe('[ ] ping Bob');
    });

    test('does not duplicate a tag the user already typed', () => {
        expect(composeFollowUpText('ping Bob #work', ['#work', '#urgent'])).toBe('[ ] ping Bob #work #urgent');
    });

    test('treats an already-typed tag as present regardless of case', () => {
        expect(composeFollowUpText('ping Bob #Work', ['#work'])).toBe('[ ] ping Bob #Work');
    });

    test('trims trailing whitespace of the first line before appending tags', () => {
        expect(composeFollowUpText('ping Bob   ', ['#work'])).toBe('[ ] ping Bob #work');
    });

    test('keeps continuation lines below the task line, tags only on the first line', () => {
        expect(composeFollowUpText('ping Bob\nhe promised numbers by Friday', ['#work']))
            .toBe('[ ] ping Bob #work\nhe promised numbers by Friday');
    });

    test('a tag on a continuation line does not count as present on the task line', () => {
        expect(composeFollowUpText('ping Bob\n#work note', ['#work']))
            .toBe('[ ] ping Bob #work\n#work note');
    });

    test('drops leading blank lines so the first non-blank line becomes the task', () => {
        expect(composeFollowUpText('\n  \nping Bob\nnote', ['#work'])).toBe('[ ] ping Bob #work\nnote');
    });

    test('returns an empty string for blank input so no junk task is created', () => {
        expect(composeFollowUpText('   \n\n', ['#work'])).toBe('');
    });
});

describe('composeFollowUpTask', () => {
    const spaces = { indentWithTabs: false, tabSize: 4 };
    const tabs = { indentWithTabs: true, tabSize: 4 };

    test('inserts an open task one step under the parent, inheriting the parent tags', () => {
        const lines = [
            '# Notes',
            '- [x] write report #work ✅ 2026-09-07',
            '- [ ] another task',
        ];
        expect(composeFollowUpTask(lines, 1, 'send it to Bob', spaces)).toEqual([
            '# Notes',
            '- [x] write report #work ✅ 2026-09-07',
            '    - [ ] send it to Bob #work',
            '- [ ] another task',
        ]);
    });

    test('reads tags from the live parent line in the file, not from anywhere else', () => {
        const lines = ['- [x] parent #alpha #beta'];
        expect(composeFollowUpTask(lines, 0, 'next', spaces)).toEqual([
            '- [x] parent #alpha #beta',
            '    - [ ] next #alpha #beta',
        ]);
    });

    test('uses tab indentation and nests one level deeper than a nested parent', () => {
        const lines = ['- [ ] top', '\t- [x] nested #x'];
        expect(composeFollowUpTask(lines, 1, 'follow', tabs)).toEqual([
            '- [ ] top',
            '\t- [x] nested #x',
            '\t\t- [ ] follow #x',
        ]);
    });

    test('keeps continuation lines aligned like a comment sub-bullet', () => {
        const lines = ['- [x] parent #work'];
        expect(composeFollowUpTask(lines, 0, 'call Bob\nhe owes numbers', spaces)).toEqual([
            '- [x] parent #work',
            '    - [ ] call Bob #work',
            '      he owes numbers',
        ]);
    });

    test('leaves the file untouched for blank input', () => {
        const lines = ['- [x] parent #work'];
        expect(composeFollowUpTask(lines, 0, '  \n', spaces)).toEqual(['- [x] parent #work']);
    });

    test('throws if lineIndex is out of range', () => {
        expect(() => composeFollowUpTask(['- [x] t'], 3, 'x', spaces)).toThrow();
    });
});
