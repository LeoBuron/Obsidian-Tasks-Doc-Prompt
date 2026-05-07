import { TFile } from 'obsidian';
import { PromptOrchestrator } from '../../src/orchestration/PromptOrchestrator';
import { SkipStateStore } from '../../src/persistence/SkipStateStore';
import { DEFAULT_SETTINGS } from '../../src/config/Settings';
import type { CompletionEvent } from '../../src/detection/types';

const makeStore = async () => SkipStateStore.load({ load: async () => null, save: async () => {} });

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
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => { seen.push(taskLine); return { kind: 'permanent-skip' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);
        store.markDeferred('id-b', { filePath: 'A.md', lineNumber: 2, taskLine: '- [x] b' }, 100_000);
        orch.checkDeferred();
        await orch.drainForTest();
        expect(seen).toEqual(['- [x] a']);
    });

    test('processAllDeferred enqueues regardless of remindAt', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => { seen.push(taskLine); return { kind: 'permanent-skip' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);
        store.markDeferred('id-b', { filePath: 'A.md', lineNumber: 2, taskLine: '- [x] b' }, 100_000);
        orch.processAllDeferred();
        await orch.drainForTest();
        expect(seen.sort()).toEqual(['- [x] a', '- [x] b']);
    });
});
