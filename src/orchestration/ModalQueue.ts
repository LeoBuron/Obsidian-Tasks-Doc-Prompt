export type ModalWorker<T> = (item: T) => Promise<void>;

export class ModalQueue<T> {
    private items: T[] = [];
    private running = false;
    private idleResolvers: Array<() => void> = [];

    constructor(private worker: ModalWorker<T>) {}

    enqueue(item: T): void {
        this.items.push(item);
        void this.pump();
    }

    queuedSize(): number {
        return this.items.length;
    }

    /** Resolves when the queue is fully idle (no in-flight item, none queued). */
    drainForTest(): Promise<void> {
        if (!this.running && this.items.length === 0) return Promise.resolve();
        return new Promise((resolve) => this.idleResolvers.push(resolve));
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.items.length > 0) {
                const next = this.items.shift()!;
                try {
                    await this.worker(next);
                } catch (err) {
                    console.error('[ModalQueue] worker error:', err);
                }
            }
        } finally {
            this.running = false;
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const r of resolvers) r();
        }
    }
}
