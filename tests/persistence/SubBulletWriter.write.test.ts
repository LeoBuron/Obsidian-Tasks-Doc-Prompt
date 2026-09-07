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

describe('SubBulletWriter.writeFollowUp', () => {
    test('inserts the follow-up task under the parent with the tags from the live line', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work ✅ 2026-09-07\n- [ ] other' };
        const writer = makeWriter(files);

        await writer.writeFollowUp(makeEvent('- [x] write report #work ✅ 2026-09-07', 0), 'send it to Bob');

        expect(files['Work/n.md']).toBe(
            '- [x] write report #work ✅ 2026-09-07\n    - [ ] send it to Bob #work\n- [ ] other',
        );
        expect(files[LOG_PATH]).toBeUndefined();
    });

    test('locates the parent by description when the line number is stale', async () => {
        const files: Record<string, string> = { 'Work/n.md': '# Heading\n\n- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.writeFollowUp(makeEvent('- [x] write report #work', 0), 'send it to Bob');

        expect(files['Work/n.md']).toBe('# Heading\n\n- [x] write report #work\n    - [ ] send it to Bob #work');
    });

    test('logs the composed task to the fallback log when the parent cannot be found', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] something else entirely' };
        const writer = makeWriter(files);

        await writer.writeFollowUp(makeEvent('- [x] write report #work', 0), 'send it to Bob');

        expect(files['Work/n.md']).toBe('- [x] something else entirely');
        expect(files[LOG_PATH]).toContain('- [ ] send it to Bob #work');
        expect(files[LOG_PATH]).toContain('Work/n.md:0');
    });
});

describe('SubBulletWriter.write', () => {
    test('inserts the comment as a plain sub-bullet under the parent', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] write report #work' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), 'Drafted v1.');

        expect(files['Work/n.md']).toBe('- [x] write report #work\n    - Drafted v1.');
        expect(files[LOG_PATH]).toBeUndefined();
    });

    test('logs the comment to the fallback log when the parent cannot be found', async () => {
        const files: Record<string, string> = { 'Work/n.md': '- [x] something else entirely' };
        const writer = makeWriter(files);

        await writer.write(makeEvent('- [x] write report #work', 0), 'Drafted v1.');

        expect(files['Work/n.md']).toBe('- [x] something else entirely');
        expect(files[LOG_PATH]).toContain('Drafted v1.');
    });
});
