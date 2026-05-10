import type { App, TFile } from 'obsidian';
import type { CompletionEvent } from '../detection/types';
import type { DocPromptSettings } from '../config/Settings';
import { SkipStateStore, type DeferredEntry } from '../persistence/SkipStateStore';
import { computeId } from '../identity/TaskIdentity';
import { ModalQueue } from './ModalQueue';
import type { ModalResult } from '../ui/DocumentationModal';
import { computeNextMatch } from '../scheduling/DeferPattern';
import { lookupTaskById } from '../detection/TaskLookup';
import type { LookupResult } from '../detection/TaskLookup';

export type ModalShow = (taskLine: string) => Promise<ModalResult>;

export interface WriterLike {
    write(event: CompletionEvent, text: string): Promise<void>;
}

interface QueueItem {
    event: CompletionEvent;
    id: string;
}

export interface OrchestratorDeps {
    app: App;
    settings: DocPromptSettings;
    skipStore: SkipStateStore;
    modalShow: ModalShow;
    writer: WriterLike;
    now?: () => number;
}

export class PromptOrchestrator {
    private app: App;
    private settings: DocPromptSettings;
    private skipStore: SkipStateStore;
    private modalShow: ModalShow;
    private writer: WriterLike;
    private now: () => number;
    private queue: ModalQueue<QueueItem>;
    /**
     * Tracks task ids currently in the queue or undergoing modal interaction.
     * Prevents duplicate enqueues from the periodic checkDeferred timer
     * re-firing on the same entry while its modal is still open (the entry
     * remains in the store until the user acts).
     */
    private inFlight: Set<string> = new Set();

    constructor(deps: OrchestratorDeps) {
        this.app = deps.app;
        this.settings = deps.settings;
        this.skipStore = deps.skipStore;
        this.modalShow = deps.modalShow;
        this.writer = deps.writer;
        this.now = deps.now ?? (() => Date.now());
        this.queue = new ModalQueue<QueueItem>((item) => this.process(item));
    }

    setSettings(settings: DocPromptSettings): void {
        this.settings = settings;
    }

    async handle(event: CompletionEvent): Promise<void> {
        if (!this.isInEnabledFolder(event.file.path)) return;
        const id = computeId(event);
        if (this.skipStore.isPermanentlySkipped(id)) return;
        if (this.inFlight.has(id)) return;
        this.inFlight.add(id);
        this.queue.enqueue({ event, id });
    }

    async checkDeferred(): Promise<void> {
        const due = this.skipStore.getDueDeferred(this.now());
        for (const entry of due) await this.tryEnqueueDeferred(entry);
    }

    async processAllDeferred(): Promise<void> {
        const all = this.skipStore.getDeferred();
        for (const entry of all) await this.tryEnqueueDeferred(entry);
    }

    /**
     * Mark a taskId as in-flight from an out-of-band edit (e.g., the
     * SettingsTab's edit modal). While the id is in-flight, `checkDeferred`
     * and `processAllDeferred` will not enqueue it. Pair with `endEdit` in a
     * try/finally.
     */
    beginEdit(taskId: string): void {
        this.inFlight.add(taskId);
    }

    endEdit(taskId: string): void {
        this.inFlight.delete(taskId);
    }

    drainForTest(): Promise<void> {
        return this.queue.drainForTest();
    }

    private async tryEnqueueDeferred(entry: DeferredEntry): Promise<void> {
        if (this.inFlight.has(entry.taskId)) return;
        // Reserve the id BEFORE the lookup. Two concurrent triggers
        // (periodic tick + ribbon click) could otherwise both pass the
        // membership check and run duplicate lookups for the same entry.
        this.inFlight.add(entry.taskId);

        let result: LookupResult;
        try {
            result = await lookupTaskById(
                this.app,
                entry.snapshot.filePath,
                entry.taskId,
                this.settings.doneStatusSymbols,
            );
        } catch (err) {
            this.inFlight.delete(entry.taskId);
            console.warn(
                `[tasks-doc-prompt] Deferred lookup failed for ${entry.taskId}; will retry next tick.`,
                err,
            );
            return;
        }

        if (result.kind === 'not-found') {
            this.inFlight.delete(entry.taskId);
            console.warn(
                `[tasks-doc-prompt] Dropping deferred entry; task no longer present: ${entry.taskId} (${entry.snapshot.filePath})`,
            );
            this.skipStore.removeDeferred(entry.taskId);
            return;
        }

        if (result.kind === 'open') {
            this.inFlight.delete(entry.taskId);
            console.warn(
                `[tasks-doc-prompt] Dropping deferred entry; task no longer in done state: ${entry.taskId}`,
            );
            this.skipStore.removeDeferred(entry.taskId);
            return;
        }

        // result.kind === 'done' — fire with current state, not the captured
        // snapshot. inFlight is kept; process() releases it in its finally.
        const ev: CompletionEvent = {
            file: result.file,
            lineNumber: result.lineNumber,
            taskLine: result.taskLine,
            previousStatus: ' ',
            newStatus: result.statusSymbol,
        };
        this.queue.enqueue({ event: ev, id: entry.taskId });
    }

    private isInEnabledFolder(path: string): boolean {
        const folders = this.settings.enabledFolders;
        if (!folders || folders.length === 0) return true;
        return folders.some((f) => {
            const norm = f.replace(/\/$/, '');
            return path === norm || path.startsWith(norm + '/');
        });
    }

    private async process(item: QueueItem): Promise<void> {
        try {
            // Capture the current entry *before* the modal opens. If the user
            // clicks plain "Not now" on a recurring entry, we need the pattern
            // to compute the next match (preservation rule 1).
            const existing = this.skipStore.getDeferredById(item.id);
            const result = await this.modalShow(item.event.taskLine);

            if (result.kind === 'cancel') {
                return; // edit-mode: user dismissed without acting; store is left untouched.
            }

            if (result.kind === 'save') {
                await this.writer.write(item.event, result.text);
                this.skipStore.removeDeferred(item.id);
                return;
            }

            if (result.kind === 'permanent-skip') {
                this.skipStore.markPermanent(item.id, {
                    label: item.event.taskLine,
                    filePath: item.event.file.path,
                });
                this.skipStore.removeDeferred(item.id);
                return;
            }

            // result.kind === 'defer'
            let remindAt = result.remindAt;
            let recurrence = result.recurrence;
            if (remindAt === undefined) {
                // "Not now" fastpath
                if (existing?.recurrence) {
                    remindAt = computeNextMatch(existing.recurrence, new Date(this.now()));
                    recurrence = existing.recurrence;
                } else {
                    remindAt = this.now() + this.settings.defaultDeferDurationMinutes * 60_000;
                    // recurrence stays undefined
                }
            }
            // When remindAt is given, recurrence is taken from the result as-is
            // (undefined intentionally clears any prior recurrence — rule 3).

            this.skipStore.markDeferred(
                item.id,
                {
                    filePath: item.event.file.path,
                    lineNumber: item.event.lineNumber,
                    taskLine: item.event.taskLine,
                },
                remindAt,
                recurrence,
            );
        } finally {
            this.inFlight.delete(item.id);
        }
    }
}
