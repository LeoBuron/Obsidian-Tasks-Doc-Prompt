import { SkipStateStore, type Persistence } from '../../src/persistence/SkipStateStore';

class MemoryPersistence implements Persistence {
    public stored: any = null;
    async load() { return this.stored; }
    async save(data: any) { this.stored = data; }
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('SkipStateStore', () => {
    test('starts empty when persistence has nothing', async () => {
        const p = new MemoryPersistence();
        const store = await SkipStateStore.load(p);
        expect(store.isPermanentlySkipped('any')).toBe(false);
        expect(store.getDeferred()).toEqual([]);
    });

    test('markPermanent persists after debounce', async () => {
        const p = new MemoryPersistence();
        const store = await SkipStateStore.load(p);
        store.markPermanent('id-1', { label: 'write report', filePath: 'A.md' });
        expect(store.isPermanentlySkipped('id-1')).toBe(true);
        expect(p.stored).toBeNull();
        jest.advanceTimersByTime(500);
        await Promise.resolve(); // let pending save resolve
        expect(p.stored.permanent['id-1'].taskId).toBe('id-1');
    });

    test('removePermanent reverses markPermanent', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markPermanent('id-1', { label: 'x', filePath: 'A.md' });
        store.removePermanent('id-1');
        expect(store.isPermanentlySkipped('id-1')).toBe(false);
    });

    test('markDeferred stores entry with remindAt', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('id-2', {
            filePath: 'A.md', lineNumber: 3, taskLine: '- [x] t',
        }, 1_000_000);
        const deferred = store.getDeferred();
        expect(deferred).toHaveLength(1);
        expect(deferred[0].taskId).toBe('id-2');
        expect(deferred[0].remindAt).toBe(1_000_000);
    });

    test('getDueDeferred returns entries with remindAt <= now WITHOUT removing them', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('id-due', { filePath: 'A.md', lineNumber: 1, taskLine: 't1' }, 100);
        store.markDeferred('id-future', { filePath: 'A.md', lineNumber: 2, taskLine: 't2' }, 10_000);
        const due = store.getDueDeferred(500);
        expect(due.map(d => d.taskId)).toEqual(['id-due']);
        // Critically, the store still holds BOTH entries.
        expect(store.getDeferred().map(d => d.taskId).sort()).toEqual(['id-due', 'id-future']);
    });

    test('getDueDeferred is idempotent — repeated calls return the same data', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('id-due', { filePath: 'A.md', lineNumber: 1, taskLine: 't1' }, 100);
        const first = store.getDueDeferred(500);
        const second = store.getDueDeferred(500);
        expect(first.map(d => d.taskId)).toEqual(['id-due']);
        expect(second.map(d => d.taskId)).toEqual(['id-due']);
    });

    test('removeDeferred removes by id without firing event', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('a', { filePath: 'A.md', lineNumber: 1, taskLine: 't' }, 1);
        store.removeDeferred('a');
        expect(store.getDeferred()).toEqual([]);
    });

    test('roundtrips through persistence', async () => {
        const p = new MemoryPersistence();
        const a = await SkipStateStore.load(p);
        a.markPermanent('id-1', { label: 'l', filePath: 'A.md' });
        a.markDeferred('id-2', { filePath: 'B.md', lineNumber: 7, taskLine: 't' }, 1234);
        jest.advanceTimersByTime(500);
        await Promise.resolve();

        const b = await SkipStateStore.load(p);
        expect(b.isPermanentlySkipped('id-1')).toBe(true);
        expect(b.getDeferred()).toHaveLength(1);
        expect(b.getDeferred()[0].remindAt).toBe(1234);
    });

    test('rejects mismatched schemaVersion and falls back to empty', async () => {
        const p = new MemoryPersistence();
        p.stored = { schemaVersion: 999, permanent: { x: {} }, deferred: {} };
        const store = await SkipStateStore.load(p);
        expect(store.isPermanentlySkipped('x')).toBe(false);
        expect(store.getDeferred()).toEqual([]);
    });

    test('debounces multiple rapid mutations into one save', async () => {
        const p = new MemoryPersistence();
        let saveCount = 0;
        const orig = p.save.bind(p);
        p.save = async (d) => { saveCount++; return orig(d); };
        const store = await SkipStateStore.load(p);
        store.markPermanent('a', { label: 'a', filePath: 'A.md' });
        store.markPermanent('b', { label: 'b', filePath: 'B.md' });
        store.markPermanent('c', { label: 'c', filePath: 'C.md' });
        jest.advanceTimersByTime(500);
        await Promise.resolve();
        expect(saveCount).toBe(1);
        expect(Object.keys(p.stored.permanent).sort()).toEqual(['a', 'b', 'c']);
    });
});
