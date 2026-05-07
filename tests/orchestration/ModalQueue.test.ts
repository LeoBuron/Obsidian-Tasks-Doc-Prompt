import { ModalQueue } from '../../src/orchestration/ModalQueue';

describe('ModalQueue', () => {
    test('processes a single item by invoking the worker', async () => {
        const seen: string[] = [];
        const queue = new ModalQueue<string>(async (s) => { seen.push(s); });
        queue.enqueue('a');
        await queue.drainForTest();
        expect(seen).toEqual(['a']);
    });

    test('serializes overlapping enqueues — second waits for first', async () => {
        const seen: string[] = [];
        let resolveFirst!: () => void;
        const firstStarted = new Promise<void>((r) => { resolveFirst = r; });
        const queue = new ModalQueue<string>(async (s) => {
            seen.push(`start:${s}`);
            if (s === 'a') await new Promise<void>((res) => {
                // Hold "a" until released.
                (resolveFirst as any).release = res;
            });
            seen.push(`end:${s}`);
        });
        queue.enqueue('a');
        queue.enqueue('b');
        // Let microtasks run so 'a' enters its body.
        await new Promise(setImmediate);
        expect(seen).toEqual(['start:a']);
        // Release 'a'; 'b' must run only after 'a' completes.
        (resolveFirst as any).release();
        await queue.drainForTest();
        expect(seen).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });

    test('worker errors do not stop the queue', async () => {
        const seen: string[] = [];
        const queue = new ModalQueue<string>(async (s) => {
            if (s === 'a') throw new Error('boom');
            seen.push(s);
        });
        queue.enqueue('a');
        queue.enqueue('b');
        await queue.drainForTest();
        expect(seen).toEqual(['b']);
    });

    test('size reflects queued items not yet processed', () => {
        const queue = new ModalQueue<string>(async () => {
            await new Promise(() => {}); // never resolves
        });
        queue.enqueue('a');
        queue.enqueue('b');
        queue.enqueue('c');
        // 'a' is in-flight; 'b' and 'c' are waiting.
        expect(queue.queuedSize()).toBe(2);
    });
});
