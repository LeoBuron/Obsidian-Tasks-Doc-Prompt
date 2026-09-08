import { TFile } from 'obsidian';
import { SubBulletWriter } from '../../src/persistence/SubBulletWriter';
import { FallbackLog } from '../../src/persistence/FallbackLog';
import type { CompletionEvent } from '../../src/detection/types';

const LOG_PATH = 'Lost.md';

function makeApp(files: Record<string, string>) {
    return {
        vault: {
            getConfig: (key: string) => (key === 'useTab' ? false : 4),
            process: async (file: TFile, fn: (data: string) => string) => {
                files[file.path] = fn(files[file.path]);
                return files[file.path];
            },
            getAbstractFileByPath: (p: string) => (files[p] !== undefined ? new TFile(p) : null),
            create: async (p: string, data: string) => { files[p] = data; return new TFile(p); },
            append: async (file: TFile, data: string) => { files[file.path] += data; },
        },
    } as any;
}

function makeEvent(taskLine: string, lineNumber: number, path = 'Work/n.md'): CompletionEvent {
    return { file: new TFile(path), lineNumber, taskLine, previousStatus: ' ', newStatus: 'x' };
}

function makeWriter(files: Record<string, string>): SubBulletWriter {
    const app = makeApp(files);
    return new SubBulletWriter(app, new FallbackLog(app, LOG_PATH));
}


describe('SubBulletWriter.write — documentation and follow-up', () => {
    test('writes the documentation as a comment and the follow-up as a task below it', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work ✅ 2026-09-07\n- [ ] other' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work ✅ 2026-09-07', 0), {
            documentation: 'Drafted v1.',
            followUp: 'send it to Bob',
        });

        expect(files['Work/n.md']).toBe(
            '- [x] write report #work ✅ 2026-09-07\n' +
            '    - Drafted v1.\n' +
            '    - [ ] send it to Bob #work\n' +
            '- [ ] other',
        );
        expect(files[LOG_PATH]).toBeUndefined();
    });

    test('documentation only: no task line is written', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: 'Drafted v1.',
            followUp: '  ',
        });

        expect(files['Work/n.md']).toBe('- [x] write report #work\n    - Drafted v1.');
    });

    test('follow-up only: the task inherits the tags of the live parent line', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: '',
            followUp: 'send it to Bob',
        });

        expect(files['Work/n.md']).toBe('- [x] write report #work\n    - [ ] send it to Bob #work');
    });

    test('multi-line input: continuation lines stay under their own block', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: 'Drafted v1.\nSent it round.',
            followUp: 'send it to Bob\nask about the budget',
        });

        expect(files['Work/n.md']).toBe(
            '- [x] write report #work\n' +
            '    - Drafted v1.\n' +
            '      Sent it round.\n' +
            '    - [ ] send it to Bob #work\n' +
            '      ask about the budget',
        );
    });

    test('locates the parent by description when the line number is stale', async () => {
        const files: Record<string, string> = { 'Work/n.md': '# Heading\n\n- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: '',
            followUp: 'send it to Bob',
        });

        expect(files['Work/n.md']).toBe('# Heading\n\n- [x] write report #work\n    - [ ] send it to Bob #work');
    });
});

describe('SubBulletWriter.write — fallback log', () => {
    test('logs both blocks when the parent cannot be found', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] something else entirely' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: 'Drafted v1.',
            followUp: 'send it to Bob',
        });

        expect(files['Work/n.md']).toBe('- [x] something else entirely');
        // Pinned as one block, not three toContain()s: the order (what
        // happened, then what's next) and the blank line between them are the
        // contract, and the task must start at column 0 to stay a real task.
        expect(files[LOG_PATH]).toContain(
            '\n\nDrafted v1.\n\n- [ ] send it to Bob #work\n\n[Original location: Work/n.md:0]',
        );
    });

    test('logs only the follow-up task when no documentation was typed', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] something else entirely' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: '',
            followUp: 'send it to Bob',
        });

        expect(files['Work/n.md']).toBe('- [x] something else entirely');
        expect(files[LOG_PATH]).toContain(
            '\n\n- [ ] send it to Bob #work\n\n[Original location: Work/n.md:0]',
        );
    });

    test('logs only the documentation when no follow-up was typed', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] something else entirely' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: 'Drafted v1.',
            followUp: '',
        });

        expect(files[LOG_PATH]).toContain('Drafted v1.');
        expect(files[LOG_PATH]).not.toContain('- [ ]');
    });

    /**
     * The fallback log exists so typed text is never lost. With nothing typed
     * there is nothing to lose, so a parent line that moved must NOT produce a
     * heading with an empty body in the log.
     */
    test('writes nothing at all when both fields are blank and the parent is gone', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] something else entirely' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), {
            documentation: '   ',
            followUp: '\n  \n',
        });

        expect(files['Work/n.md']).toBe('- [x] something else entirely');
        expect(files[LOG_PATH]).toBeUndefined();
    });

    test('leaves the note untouched when both fields are blank and the parent is there', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), { documentation: '', followUp: '' });

        expect(files['Work/n.md']).toBe('- [x] write report #work');
        expect(files[LOG_PATH]).toBeUndefined();
    });
});
