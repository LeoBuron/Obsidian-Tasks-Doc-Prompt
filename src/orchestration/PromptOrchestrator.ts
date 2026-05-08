import type { App, TFile } from 'obsidian';
import type { CompletionEvent } from '../detection/types';
import type { DocPromptSettings } from '../config/Settings';
import { SkipStateStore, type DeferredEntry } from '../persistence/SkipStateStore';
import { computeId } from '../identity/TaskIdentity';
import { ModalQueue } from './ModalQueue';
import type { ModalResult } from '../ui/DocumentationModal';
import { computeNextMatch } from '../scheduling/DeferPattern';

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

    checkDeferred(): void {
        const due = this.skipStore.getDueDeferred(this.now());
        for (const entry of due) this.tryEnqueueDeferred(entry);
    }

    processAllDeferred(): void {
        const all = this.skipStore.getDeferred();
        for (const entry of all) this.tryEnqueueDeferred(entry);
    }

    drainForTest(): Promise<void> {
        return this.queue.drainForTest();
    }

    private tryEnqueueDeferred(entry: DeferredEntry): void {
        if (this.inFlight.has(entry.taskId)) return;
        const file = this.app.vault.getFileByPath(entry.snapshot.filePath);
        if (!file) {
            // Source file is gone (deleted/moved since defer). Drop the
            // entry so we don't keep retrying every minute.
            console.warn(
                `[tasks-doc-prompt] Dropping deferred entry for missing file: ${entry.snapshot.filePath}`,
            );
            this.skipStore.removeDeferred(entry.taskId);
            return;
        }
        const ev: CompletionEvent = {
            file: file as TFile,
            lineNumber: entry.snapshot.lineNumber,
            taskLine: entry.snapshot.taskLine,
            previousStatus: ' ',
            newStatus: 'x',
        };
        this.inFlight.add(entry.taskId);
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
                return; // edit-mode no-op; the source path that produces
                        // 'cancel' from the regular flow does not exist.
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
