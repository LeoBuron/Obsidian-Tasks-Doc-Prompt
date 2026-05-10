import { TFile } from 'obsidian';
import { lookupTaskById } from '../../src/detection/TaskLookup';
import { computeIdFromLine } from '../../src/identity/TaskIdentity';

function makeApp(files: Record<string, string>) {
    return {
        vault: {
            getFileByPath: (p: string) =>
                files[p] !== undefined ? new TFile(p) : null,
            read: async (file: TFile) => {
                const content = files[file.path];
                if (content === undefined) {
                    throw new Error(`File not found in fake vault: ${file.path}`);
                }
                return content;
            },
        },
    } as any;
}

const DONE = ['x', 'X', '-'];

describe('lookupTaskById', () => {
    test('task present and in done symbol → kind: done with current line, text, symbol', async () => {
        const path = 'notes.md';
        const taskLine = '- [x] write report';
        const id = computeIdFromLine(path, taskLine);
        const app = makeApp({ [path]: `${taskLine}\n` });
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('done');
        if (result.kind !== 'done') return; // type narrow
        expect(result.lineNumber).toBe(0);
        expect(result.taskLine).toBe(taskLine);
        expect(result.statusSymbol).toBe('x');
        expect(result.file.path).toBe(path);
    });

    test('task present but in non-done symbol → kind: open', async () => {
        const path = 'notes.md';
        const oldLine = '- [x] write report';
        const id = computeIdFromLine(path, oldLine); // id captured when done
        const app = makeApp({ [path]: '- [ ] write report\n' }); // user unchecked
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('open');
    });

    test('task absent (no matching id in file) → kind: not-found', async () => {
        const path = 'notes.md';
        const id = computeIdFromLine(path, '- [x] write report');
        const app = makeApp({ [path]: '- [x] something else entirely\n' });
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('not-found');
    });

    test('file missing from vault → kind: not-found', async () => {
        const id = computeIdFromLine('notes.md', '- [x] write report');
        const app = makeApp({}); // no file at notes.md
        const result = await lookupTaskById(app, 'notes.md', id, DONE);
        expect(result.kind).toBe('not-found');
    });

    test('description edited, no block id → kind: not-found (path-style id mismatches)', async () => {
        const path = 'notes.md';
        const id = computeIdFromLine(path, '- [x] write report'); // id at trigger time
        const app = makeApp({ [path]: '- [x] write the quarterly report\n' }); // edited
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('not-found');
    });

    test('description edited but block id present → kind: done (block id matches)', async () => {
        const path = 'notes.md';
        const id = computeIdFromLine(path, '- [x] write report ^abc'); // block: form
        const app = makeApp({ [path]: '- [x] write the quarterly report ^abc\n' });
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('done');
        if (result.kind !== 'done') return;
        expect(result.taskLine).toBe('- [x] write the quarterly report ^abc');
    });

    test('task moved to a different line number → kind: done with new lineNumber', async () => {
        const path = 'notes.md';
        const taskLine = '- [x] write report';
        const id = computeIdFromLine(path, taskLine);
        const app = makeApp({
            [path]: `# Heading\nsome paragraph\nanother paragraph\n${taskLine}\n`,
        });
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('done');
        if (result.kind !== 'done') return;
        expect(result.lineNumber).toBe(3);
    });

    test('status switched between done symbols (x → -) → kind: done with new symbol', async () => {
        const path = 'notes.md';
        const id = computeIdFromLine(path, '- [x] write report');
        const app = makeApp({ [path]: '- [-] write report\n' });
        const result = await lookupTaskById(app, path, id, DONE);
        expect(result.kind).toBe('done');
        if (result.kind !== 'done') return;
        expect(result.statusSymbol).toBe('-');
        expect(result.taskLine).toBe('- [-] write report');
    });

    test('vault.read throws → exception propagates (not swallowed)', async () => {
        const path = 'notes.md';
        const app = {
            vault: {
                getFileByPath: () => new TFile(path),
                read: async () => { throw new Error('disk error'); },
            },
        } as any;
        const id = computeIdFromLine(path, '- [x] foo');
        await expect(lookupTaskById(app, path, id, DONE)).rejects.toThrow('disk error');
    });
});
