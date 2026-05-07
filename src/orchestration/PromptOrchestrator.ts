import { TFile } from 'obsidian';
import type { CompletionEvent } from '../detection/types';
import type { DocPromptSettings } from '../config/Settings';
import { SkipStateStore } from '../persistence/SkipStateStore';
import { computeId } from '../identity/TaskIdentity';
import { ModalQueue } from './ModalQueue';
import type { ModalResult } from '../ui/DocumentationModal';

export type ModalShow = (taskLine: string) => Promise<ModalResult>;

export interface WriterLike {
    write(event: CompletionEvent, text: string): Promise<void>;
}

interface QueueItem {
    event: CompletionEvent;
    id: string;
}

export interface OrchestratorDeps {
    settings: DocPromptSettings;
    skipStore: SkipStateStore;
    modalShow: ModalShow;
    writer: WriterLike;
    now?: () => number;
}

export class PromptOrchestrator {
    private settings: DocPromptSettings;
    private skipStore: SkipStateStore;
    private modalShow: ModalShow;
    private writer: WriterLike;
    private now: () => number;
    private queue: ModalQueue<QueueItem>;

    constructor(deps: OrchestratorDeps) {
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
        this.queue.enqueue({ event, id });
    }

    checkDeferred(): void {
        const due = this.skipStore.takeDueDeferred(this.now());
        for (const entry of due) {
            const ev: CompletionEvent = {
                file: new TFile(entry.snapshot.filePath),
                lineNumber: entry.snapshot.lineNumber,
                taskLine: entry.snapshot.taskLine,
                previousStatus: ' ',
                newStatus: 'x',
            };
            this.queue.enqueue({ event: ev, id: entry.taskId });
        }
    }

    processAllDeferred(): void {
        const all = this.skipStore.takeAllDeferred();
        for (const entry of all) {
            const ev: CompletionEvent = {
                file: new TFile(entry.snapshot.filePath),
                lineNumber: entry.snapshot.lineNumber,
                taskLine: entry.snapshot.taskLine,
                previousStatus: ' ',
                newStatus: 'x',
            };
            this.queue.enqueue({ event: ev, id: entry.taskId });
        }
    }

    drainForTest(): Promise<void> {
        return this.queue.drainForTest();
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
        const result = await this.modalShow(item.event.taskLine);
        if (result.kind === 'save') {
            await this.writer.write(item.event, result.text);
            this.skipStore.removeDeferred(item.id);
        } else if (result.kind === 'defer') {
            const remindAt = this.now() + this.settings.defaultDeferDurationMinutes * 60_000;
            this.skipStore.markDeferred(item.id, {
                filePath: item.event.file.path,
                lineNumber: item.event.lineNumber,
                taskLine: item.event.taskLine,
            }, remindAt);
        } else {
            this.skipStore.markPermanent(item.id, {
                label: item.event.taskLine,
                filePath: item.event.file.path,
            });
            this.skipStore.removeDeferred(item.id);
        }
    }
}
