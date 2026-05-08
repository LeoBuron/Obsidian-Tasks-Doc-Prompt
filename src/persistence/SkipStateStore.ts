import type { DeferPattern } from '../scheduling/DeferPattern';

const CURRENT_SCHEMA = 1 as const;

export interface DeferredEntry {
    taskId: string;
    snapshot: { filePath: string; lineNumber: number; taskLine: string };
    deferredAt: number;
    remindAt: number;
    recurrence?: DeferPattern;
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
        recurrence?: DeferPattern,
    ): void {
        const entry: DeferredEntry = {
            taskId,
            snapshot,
            deferredAt: Date.now(),
            remindAt,
        };
        if (recurrence !== undefined) entry.recurrence = recurrence;
        this.state.deferred[taskId] = entry;
        this.scheduleSave();
    }

    removeDeferred(taskId: string): void {
        delete this.state.deferred[taskId];
        this.scheduleSave();
    }

    getDeferred(): DeferredEntry[] {
        return Object.values(this.state.deferred);
    }

    getDeferredById(taskId: string): DeferredEntry | undefined {
        return this.state.deferred[taskId];
    }

    /**
     * Returns deferred entries whose `remindAt <= now` WITHOUT removing them
     * from the store. Removal is the caller's responsibility (e.g. after the
     * user acts on the re-prompt). This preserves persistence across Obsidian
     * restarts even while a modal is open.
     */
    getDueDeferred(now: number): DeferredEntry[] {
        const due: DeferredEntry[] = [];
        for (const entry of Object.values(this.state.deferred)) {
            if (entry.remindAt <= now) due.push(entry);
        }
        return due;
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.persistence.save(this.state);
        }, SAVE_DEBOUNCE_MS);
    }
}
