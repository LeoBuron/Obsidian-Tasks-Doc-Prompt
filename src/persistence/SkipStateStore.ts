const CURRENT_SCHEMA = 1 as const;

export interface DeferredEntry {
    taskId: string;
    snapshot: { filePath: string; lineNumber: number; taskLine: string };
    deferredAt: number;
    remindAt: number;
}

export interface PermanentEntry {
    taskId: string;
    skippedAt: number;
    label: string;
    filePath: string;
}

interface SkipState {
    schemaVersion: typeof CURRENT_SCHEMA;
    deferred: Record<string, DeferredEntry>;
    permanent: Record<string, PermanentEntry>;
}

function emptyState(): SkipState {
    return { schemaVersion: CURRENT_SCHEMA, deferred: {}, permanent: {} };
}

export interface Persistence {
    load(): Promise<unknown>;
    save(data: unknown): Promise<void>;
}

const SAVE_DEBOUNCE_MS = 500;

export class SkipStateStore {
    private state: SkipState;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(private persistence: Persistence, state: SkipState) {
        this.state = state;
    }

    static async load(persistence: Persistence): Promise<SkipStateStore> {
        let raw: unknown = null;
        try {
            raw = await persistence.load();
        } catch {
            raw = null;
        }
        const state = SkipStateStore.parseOrEmpty(raw);
        return new SkipStateStore(persistence, state);
    }

    private static parseOrEmpty(raw: unknown): SkipState {
        if (!raw || typeof raw !== 'object') return emptyState();
        const obj = raw as Partial<SkipState>;
        if (obj.schemaVersion !== CURRENT_SCHEMA) return emptyState();
        return {
            schemaVersion: CURRENT_SCHEMA,
            deferred: { ...(obj.deferred ?? {}) },
            permanent: { ...(obj.permanent ?? {}) },
        };
    }

    isPermanentlySkipped(taskId: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.state.permanent, taskId);
    }

    markPermanent(taskId: string, info: { label: string; filePath: string }): void {
        this.state.permanent[taskId] = {
            taskId,
            skippedAt: Date.now(),
            label: info.label,
            filePath: info.filePath,
        };
        this.scheduleSave();
    }

    removePermanent(taskId: string): void {
        delete this.state.permanent[taskId];
        this.scheduleSave();
    }

    listPermanent(): PermanentEntry[] {
        return Object.values(this.state.permanent);
    }

    markDeferred(
        taskId: string,
        snapshot: DeferredEntry['snapshot'],
        remindAt: number,
    ): void {
        this.state.deferred[taskId] = {
            taskId,
            snapshot,
            deferredAt: Date.now(),
            remindAt,
        };
        this.scheduleSave();
    }

    removeDeferred(taskId: string): void {
        delete this.state.deferred[taskId];
        this.scheduleSave();
    }

    getDeferred(): DeferredEntry[] {
        return Object.values(this.state.deferred);
    }

    takeDueDeferred(now: number): DeferredEntry[] {
        const due: DeferredEntry[] = [];
        for (const [id, entry] of Object.entries(this.state.deferred)) {
            if (entry.remindAt <= now) {
                due.push(entry);
                delete this.state.deferred[id];
            }
        }
        if (due.length > 0) this.scheduleSave();
        return due;
    }

    takeAllDeferred(): DeferredEntry[] {
        const all = Object.values(this.state.deferred);
        this.state.deferred = {};
        if (all.length > 0) this.scheduleSave();
        return all;
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.persistence.save(this.state);
        }, SAVE_DEBOUNCE_MS);
    }
}
