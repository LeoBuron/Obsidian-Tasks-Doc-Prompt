import { TFile } from 'obsidian';
import { PromptOrchestrator } from '../../src/orchestration/PromptOrchestrator';
import { SkipStateStore } from '../../src/persistence/SkipStateStore';
import { DEFAULT_SETTINGS } from '../../src/config/Settings';
import type { CompletionEvent } from '../../src/detection/types';
import { computeIdFromLine } from '../../src/identity/TaskIdentity';

const makeStore = async () => SkipStateStore.load({ load: async () => null, save: async () => {} });

function makeApp(initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    return {
        vault: {
            // Keep the legacy "always returns a TFile" behavior so existing
            // tests don't need rewriting. New tests that need vault.read
            // register file content via initialFiles or setFile.
            getFileByPath: (p: string) => new TFile(p),
            read: async (file: TFile) => {
                const content = files[file.path];
                if (content === undefined) {
                    throw new Error(`No content registered for ${file.path}`);
                }
                return content;
            },
        },
        // Test-only escape hatch — not part of the App interface.
        setFile: (p: string, content: string) => { files[p] = content; },
    } as any;
}

const fakeApp = makeApp(); // default for existing tests

function makeEvent(line: string, path = 'Work/notes.md'): CompletionEvent {
    return {
        file: new TFile(path),
        lineNumber: 0,
        taskLine: line,
        previousStatus: ' ',
        newStatus: 'x',
    };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('PromptOrchestrator', () => {
    test('drops events for files outside enabled folders', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS, enabledFolders: ['Work'] },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'x' }),
            writer: { write: async (e, t) => { writes.push({ e, t }); } },
            now: () => 0,
        });
        await orch.handle(makeEvent('- [x] outside', 'Personal/notes.md'));
        await orch.drainForTest();
        expect(writes).toHaveLength(0);
    });

    test('processes events when folder filter is empty (all enabled)', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'did it' }),
            writer: { write: async (e, t) => { writes.push({ e, t }); } },
            now: () => 0,
        });
        await orch.handle(makeEvent('- [x] task'));
        await orch.drainForTest();
        expect(writes).toHaveLength(1);
        expect(writes[0].t).toBe('did it');
    });

    test('drops events for permanently skipped tasks', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'x' }),
            writer: { write: async () => { writes.push(1); } },
            now: () => 0,
        });
        const ev = makeEvent('- [x] skipped task');
        // Pre-mark as permanent.
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        store.markPermanent(id, { label: 'x', filePath: ev.file.path });
        await orch.handle(ev);
        await orch.drainForTest();
        expect(writes).toHaveLength(0);
    });

    test('save → writer.write called and any deferred record cleared', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'done' }),
            writer: { write: async (e, t) => { writes.push(t); } },
            now: () => 1000,
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        store.markDeferred(id, { filePath: ev.file.path, lineNumber: 0, taskLine: ev.taskLine }, 1);
        await orch.handle(ev);
        await orch.drainForTest();
        expect(writes).toEqual(['done']);
        expect(store.getDeferred()).toEqual([]);
    });

    test('defer → markDeferred with remindAt = now + duration', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS, defaultDeferDurationMinutes: 60 },
            skipStore: store,
            modalShow: async () => ({ kind: 'defer' }),
            writer: { write: async () => {} },
            now: () => 1_000_000,
        });
        await orch.handle(makeEvent('- [x] task'));
        await orch.drainForTest();
        const deferred = store.getDeferred();
        expect(deferred).toHaveLength(1);
        expect(deferred[0].remindAt).toBe(1_000_000 + 60 * 60_000);
    });

    test('permanent-skip → markPermanent', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'permanent-skip' }),
            writer: { write: async () => {} },
            now: () => 0,
        });
        const ev = makeEvent('- [x] task');
        await orch.handle(ev);
        await orch.drainForTest();
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        expect(store.isPermanentlySkipped(id)).toBe(true);
    });

    test('checkDeferred enqueues all due entries and re-prompts each', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        // While the modal is open we capture how many deferred entries the
        // store currently holds. If the entry were removed at enqueue-time
        // (the bug), this would be 1 instead of 2.
        const deferredCountDuringModal: number[] = [];
        const idA = computeIdFromLine('A.md', '- [x] a');
        const idB = computeIdFromLine('A.md', '- [x] b');
        const orch = new PromptOrchestrator({
            app: makeApp({ 'A.md': '- [x] a\n- [x] b\n' }),
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => {
                seen.push(taskLine);
                deferredCountDuringModal.push(store.getDeferred().length);
                return { kind: 'permanent-skip' };
            },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred(idA, { filePath: 'A.md', lineNumber: 0, taskLine: '- [x] a' }, 100);
        store.markDeferred(idB, { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] b' }, 100_000);
        // Both entries still in the store before checkDeferred has a chance to drop them.
        expect(store.getDeferred()).toHaveLength(2);
        await orch.checkDeferred();
        await orch.drainForTest();
        expect(seen).toEqual(['- [x] a']);
        // While the only-due modal was open, both entries were still on disk.
        expect(deferredCountDuringModal).toEqual([2]);
    });

    test('processAllDeferred enqueues regardless of remindAt', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        const deferredCountDuringModal: number[] = [];
        const idA = computeIdFromLine('A.md', '- [x] a');
        const idB = computeIdFromLine('A.md', '- [x] b');
        const orch = new PromptOrchestrator({
            app: makeApp({ 'A.md': '- [x] a\n- [x] b\n' }),
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => {
                seen.push(taskLine);
                deferredCountDuringModal.push(store.getDeferred().length);
                return { kind: 'permanent-skip' };
            },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred(idA, { filePath: 'A.md', lineNumber: 0, taskLine: '- [x] a' }, 100);
        store.markDeferred(idB, { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] b' }, 100_000);
        // Both entries still in the store before processAllDeferred has a chance to drop them.
        expect(store.getDeferred()).toHaveLength(2);
        await orch.processAllDeferred();
        await orch.drainForTest();
        expect(seen.sort()).toEqual(['- [x] a', '- [x] b']);
        // First modal sees 2; by the time the second runs, the first has been
        // permanent-skipped (its store entry was cleared in process()).
        expect(deferredCountDuringModal.sort()).toEqual([1, 2]);
    });

    test('checkDeferred does not duplicate-enqueue an already-in-flight task', async () => {
        const store = await makeStore();
        let release: () => void = () => {};
        const modalGate = new Promise<void>((resolve) => { release = resolve; });
        let modalOpenCount = 0;
        const idA = computeIdFromLine('A.md', '- [x] a');
        const orch = new PromptOrchestrator({
            app: makeApp({ 'A.md': '- [x] a\n' }),
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => {
                modalOpenCount++;
                await modalGate;
                return { kind: 'permanent-skip' };
            },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred(idA, { filePath: 'A.md', lineNumber: 0, taskLine: '- [x] a' }, 100);

        // First tick — opens modal, which now blocks on modalGate.
        orch.checkDeferred();
        // Yield so the queue pumps and the modal opens.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(modalOpenCount).toBe(1);

        // Second tick — entry is still in the store (we held the modal), but
        // the orchestrator must not re-enqueue while in-flight.
        orch.checkDeferred();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(modalOpenCount).toBe(1);

        // Release the modal; queue drains; final state has one prompt total.
        release();
        await orch.drainForTest();
        expect(modalOpenCount).toBe(1);
    });

    test('preservation rule 1: "Not now" on recurring entry preserves pattern', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS, defaultDeferDurationMinutes: 60 },
            skipStore: store,
            modalShow: async () => ({ kind: 'defer' }), // "Not now"
            writer: { write: async () => {} },
            now: () => new Date(2026, 4, 7, 9, 5).getTime(), // 09:05
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);

        // Pre-existing recurring entry: every day at 09:00.
        store.markDeferred(
            id,
            { filePath: ev.file.path, lineNumber: 0, taskLine: ev.taskLine },
            new Date(2026, 4, 7, 9, 0).getTime(),
            { daysFromNow: null, hour: 9, minute: 0 },
        );

        await orch.handle(ev);
        await orch.drainForTest();

        const updated = store.getDeferredById(id)!;
        expect(updated.recurrence).toEqual({ daysFromNow: null, hour: 9, minute: 0 });
        // Next match after 09:05 is tomorrow 09:00.
        expect(updated.remindAt).toBe(new Date(2026, 4, 8, 9, 0).getTime());
    });

    test('preservation rule 2: "Not now" with no existing recurrence falls back to default duration', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS, defaultDeferDurationMinutes: 60 },
            skipStore: store,
            modalShow: async () => ({ kind: 'defer' }),
            writer: { write: async () => {} },
            now: () => 1_000_000,
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        await orch.handle(ev);
        await orch.drainForTest();
        const entry = store.getDeferredById(id)!;
        expect(entry.remindAt).toBe(1_000_000 + 60 * 60_000);
        expect(entry.recurrence).toBeUndefined();
    });

    test('preservation rule 3: preset (remindAt without recurrence) overrides existing recurrence', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS, defaultDeferDurationMinutes: 60 },
            skipStore: store,
            modalShow: async () => ({ kind: 'defer', remindAt: 5_000_000 }),
            writer: { write: async () => {} },
            now: () => 1_000_000,
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        // existing recurrence
        store.markDeferred(
            id,
            { filePath: ev.file.path, lineNumber: 0, taskLine: ev.taskLine },
            2_000_000,
            { daysFromNow: 1, hour: 9, minute: 0 },
        );
        await orch.handle(ev);
        await orch.drainForTest();
        const entry = store.getDeferredById(id)!;
        expect(entry.remindAt).toBe(5_000_000);
        expect(entry.recurrence).toBeUndefined();
    });

    test('preservation rule 4: full custom (remindAt + recurrence) overrides existing recurrence', async () => {
        const store = await makeStore();
        const newPattern = { daysFromNow: null, hour: null, minute: 55 } as const;
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS, defaultDeferDurationMinutes: 60 },
            skipStore: store,
            modalShow: async () => ({ kind: 'defer', remindAt: 5_000_000, recurrence: { ...newPattern } }),
            writer: { write: async () => {} },
            now: () => 1_000_000,
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        store.markDeferred(
            id,
            { filePath: ev.file.path, lineNumber: 0, taskLine: ev.taskLine },
            2_000_000,
            { daysFromNow: 1, hour: 9, minute: 0 },
        );
        await orch.handle(ev);
        await orch.drainForTest();
        const entry = store.getDeferredById(id)!;
        expect(entry.remindAt).toBe(5_000_000);
        expect(entry.recurrence).toEqual(newPattern);
    });

    test("'cancel' result is a no-op (used only by edit-mode)", async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            app: fakeApp,
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'cancel' }),
            writer: { write: async () => {} },
            now: () => 0,
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        // Pre-existing entry
        store.markDeferred(id, { filePath: ev.file.path, lineNumber: 0, taskLine: ev.taskLine }, 100);
        await orch.handle(ev);
        await orch.drainForTest();
        // Entry untouched
        const entry = store.getDeferredById(id)!;
        expect(entry.remindAt).toBe(100);
    });

    test('beginEdit blocks checkDeferred from opening a duplicate modal', async () => {
        const store = await makeStore();
        let modalOpenCount = 0;
        const idX = computeIdFromLine('A.md', '- [x] x');
        const orch = new PromptOrchestrator({
            app: makeApp({ 'A.md': '- [x] x\n' }),
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => { modalOpenCount++; return { kind: 'permanent-skip' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred(idX, { filePath: 'A.md', lineNumber: 0, taskLine: '- [x] x' }, 100);

        // Simulate the SettingsTab edit modal taking the lock.
        orch.beginEdit(idX);
        orch.checkDeferred();
        await orch.drainForTest();
        expect(modalOpenCount).toBe(0);

        // Edit completes; lock released; next tick can enqueue.
        orch.endEdit(idX);
        await orch.checkDeferred();
        await orch.drainForTest();
        expect(modalOpenCount).toBe(1);
    });

    test('drops deferred entries whose source file no longer exists', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        const missingFileApp = {
            vault: { getFileByPath: (_: string) => null },
        } as any;
        const orch = new PromptOrchestrator({
            app: missingFileApp,
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => { seen.push(taskLine); return { kind: 'permanent-skip' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred('id-gone', { filePath: 'Deleted.md', lineNumber: 1, taskLine: '- [x] gone' }, 100);
        // Silence the warning for this test.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        orch.checkDeferred();
        await orch.drainForTest();
        expect(seen).toEqual([]);
        // Entry was removed from the store so it doesn't keep retrying.
        expect(store.getDeferred()).toEqual([]);
        warn.mockRestore();
    });

    test('deferred entry drops when task is no longer in done state (issue #8)', async () => {
        const path = 'Work/notes.md';
        const triggerLine = '- [x] write report';
        const store = await makeStore();
        const writes: any[] = [];
        const modalCalls: string[] = [];
        const orch = new PromptOrchestrator({
            app: makeApp({ [path]: '- [ ] write report\n' }), // user unchecked
            settings: { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X', '-'] },
            skipStore: store,
            modalShow: async (line) => { modalCalls.push(line); return { kind: 'save', text: 'doc' }; },
            writer: { write: async (e, t) => { writes.push({ e, t }); } },
            now: () => 1000,
        });
        const id = computeIdFromLine(path, triggerLine);
        store.markDeferred(
            id,
            { filePath: path, lineNumber: 0, taskLine: triggerLine },
            500, // remindAt in the past relative to now=1000
        );
        await orch.checkDeferred();
        await orch.drainForTest();
        expect(modalCalls).toHaveLength(0);
        expect(writes).toHaveLength(0);
        expect(store.getDeferredById(id)).toBeUndefined();
    });

    test('deferred entry fires with current state when task switched between done symbols', async () => {
        const path = 'Work/notes.md';
        const triggerLine = '- [x] write report';
        const store = await makeStore();
        const writes: any[] = [];
        let receivedNewStatus = '';
        const orch = new PromptOrchestrator({
            app: makeApp({ [path]: '- [-] write report\n' }), // x → -
            settings: { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X', '-'] },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'doc' }),
            writer: { write: async (e, t) => { writes.push({ e, t }); receivedNewStatus = e.newStatus; } },
            now: () => 1000,
        });
        const id = computeIdFromLine(path, triggerLine);
        store.markDeferred(id, { filePath: path, lineNumber: 0, taskLine: triggerLine }, 500);
        await orch.checkDeferred();
        await orch.drainForTest();
        expect(writes).toHaveLength(1);
        expect(receivedNewStatus).toBe('-'); // current symbol, not the stale 'x'
        expect(store.getDeferredById(id)).toBeUndefined();
    });

    test('deferred entry fires with current line number when task moved (latent line-drift fix)', async () => {
        const path = 'Work/notes.md';
        const triggerLine = '- [x] write report';
        const store = await makeStore();
        let receivedLine = -1;
        const orch = new PromptOrchestrator({
            app: makeApp({
                [path]: `# Heading\nfiller\nfiller\n${triggerLine}\n`, // task now at line 3
            }),
            settings: { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X', '-'] },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'doc' }),
            writer: { write: async (e) => { receivedLine = e.lineNumber; } },
            now: () => 1000,
        });
        const id = computeIdFromLine(path, triggerLine);
        store.markDeferred(id, { filePath: path, lineNumber: 0, taskLine: triggerLine }, 500);
        await orch.checkDeferred();
        await orch.drainForTest();
        expect(receivedLine).toBe(3); // not the stale 0
    });

    test('deferred entry drops when task no longer present in file', async () => {
        const path = 'Work/notes.md';
        const triggerLine = '- [x] write report';
        const store = await makeStore();
        const modalCalls: string[] = [];
        const orch = new PromptOrchestrator({
            app: makeApp({ [path]: '\n' }), // task line deleted
            settings: { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X', '-'] },
            skipStore: store,
            modalShow: async (l) => { modalCalls.push(l); return { kind: 'save', text: '' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        const id = computeIdFromLine(path, triggerLine);
        store.markDeferred(id, { filePath: path, lineNumber: 0, taskLine: triggerLine }, 500);
        await orch.checkDeferred();
        await orch.drainForTest();
        expect(modalCalls).toHaveLength(0);
        expect(store.getDeferredById(id)).toBeUndefined();
    });

    test('deferred entry stays in store and inFlight is released when lookup throws', async () => {
        const path = 'Work/notes.md';
        const triggerLine = '- [x] write report';
        const store = await makeStore();
        let readCalls = 0;
        const orch = new PromptOrchestrator({
            app: {
                vault: {
                    getFileByPath: (p: string) => new TFile(p),
                    read: async () => { readCalls++; throw new Error('boom'); },
                },
            } as any,
            settings: { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X', '-'] },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: '' }),
            writer: { write: async () => {} },
            now: () => 1000,
        });
        const id = computeIdFromLine(path, triggerLine);
        store.markDeferred(id, { filePath: path, lineNumber: 0, taskLine: triggerLine }, 500);

        await orch.checkDeferred();
        expect(readCalls).toBe(1);
        expect(store.getDeferredById(id)).toBeDefined(); // entry preserved for retry

        // Second tick: id must NOT be locked in inFlight from the previous
        // failed attempt — otherwise no retry would happen.
        await orch.checkDeferred();
        expect(readCalls).toBe(2); // proves inFlight was released after the first throw
    });

    test('end-to-end: defer x → uncheck → fire timer → no modal, store empty (issue #8 repro)', async () => {
        const path = 'Work/notes.md';
        const store = await makeStore();
        const modalCalls: string[] = [];
        const writes: any[] = [];
        const app = makeApp({ [path]: '- [x] write report\n' });

        const orch = new PromptOrchestrator({
            app,
            settings: { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X', '-'] },
            skipStore: store,
            modalShow: async (l) => {
                modalCalls.push(l);
                // First (initial) call → defer; second call would be the bug.
                if (modalCalls.length === 1) {
                    return { kind: 'defer', remindAt: 500 };
                }
                return { kind: 'save', text: 'doc' };
            },
            writer: { write: async (e, t) => { writes.push({ e, t }); } },
            now: () => 1000,
        });
        const id = computeIdFromLine(path, '- [x] write report');
        await orch.handle({
            file: new TFile(path),
            lineNumber: 0,
            taskLine: '- [x] write report',
            previousStatus: ' ',
            newStatus: 'x',
        });
        await orch.drainForTest();
        expect(store.getDeferredById(id)).toBeDefined();
        expect(modalCalls).toHaveLength(1);

        // User unchecks the task. Mutate the fake vault content in place.
        app.setFile(path, '- [ ] write report\n');

        // Defer time elapses; the periodic tick fires.
        await orch.checkDeferred();
        await orch.drainForTest();

        // The fix: no second modal call, no write, store is empty.
        expect(modalCalls).toHaveLength(1);
        expect(writes).toHaveLength(0);
        expect(store.getDeferredById(id)).toBeUndefined();
    });
});
