import { TFile } from 'obsidian';
import { PromptOrchestrator } from '../../src/orchestration/PromptOrchestrator';
import { SkipStateStore } from '../../src/persistence/SkipStateStore';
import { DEFAULT_SETTINGS } from '../../src/config/Settings';
import type { CompletionEvent } from '../../src/detection/types';

const makeStore = async () => SkipStateStore.load({ load: async () => null, save: async () => {} });

// Minimal App stub: vault.getFileByPath returns a fresh TFile for any path,
// matching the contract that the file exists.
const fakeApp = {
    vault: { getFileByPath: (p: string) => new TFile(p) },
} as any;

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
        const orch = new PromptOrchestrator({
            app: fakeApp,
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
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);
        store.markDeferred('id-b', { filePath: 'A.md', lineNumber: 2, taskLine: '- [x] b' }, 100_000);
        orch.checkDeferred();
        // Both entries still in the store at enqueue time (non-destructive read).
        expect(store.getDeferred()).toHaveLength(2);
        await orch.drainForTest();
        expect(seen).toEqual(['- [x] a']);
        // While the only-due modal was open, both entries were still on disk.
        expect(deferredCountDuringModal).toEqual([2]);
    });

    test('processAllDeferred enqueues regardless of remindAt', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        const deferredCountDuringModal: number[] = [];
        const orch = new PromptOrchestrator({
            app: fakeApp,
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
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);
        store.markDeferred('id-b', { filePath: 'A.md', lineNumber: 2, taskLine: '- [x] b' }, 100_000);
        orch.processAllDeferred();
        // Both entries still in the store at enqueue time (non-destructive read).
        expect(store.getDeferred()).toHaveLength(2);
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
        const orch = new PromptOrchestrator({
            app: fakeApp,
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
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);

        // First tick — opens modal, which now blocks on modalGate.
        orch.checkDeferred();
        // Yield so the queue pumps and the modal opens.
        await Promise.resolve();
        await Promise.resolve();
        expect(modalOpenCount).toBe(1);

        // Second tick — entry is still in the store (we held the modal), but
        // the orchestrator must not re-enqueue while in-flight.
        orch.checkDeferred();
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
        await orch.handle(ev);
        await orch.drainForTest();
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
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
});
