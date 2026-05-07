import { createHash } from 'crypto';
import type { App, EventRef, TFile } from 'obsidian';
import type { CompletionEvent } from './types';
import type { CompletionDetector, CompletionHandler } from './CompletionDetector';
import type { DocPromptSettings } from '../config/Settings';

export interface TaskLineSnapshot {
    lineNumber: number;
    statusSymbol: string;
    descriptionHash: string;
    blockId?: string;
}

const TASK_LINE_RE = /^(\s*)[-*+]\s*\[([^\]])\]\s*(.*)$/;
const BLOCK_ID_RE = /\s*\^([A-Za-z0-9-]+)\s*$/;
// Tasks plugin appends ✅ YYYY-MM-DD on toggle to done. Strip it so the same
// task before and after toggle hash to the same value within a diff cycle.
const COMPLETION_DATE_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}\s*/g;

function descriptionHash(rawAfterBracket: string): string {
    // Hash the description text only; strip block-id, completion date, and trailing whitespace.
    const noBlock = rawAfterBracket.replace(BLOCK_ID_RE, '');
    const noCompletionDate = noBlock.replace(COMPLETION_DATE_RE, ' ').replace(/\s+/g, ' ').trim();
    return createHash('sha1').update(noCompletionDate).digest('hex').slice(0, 16);
}

function extractBlockId(rawAfterBracket: string): string | undefined {
    const m = rawAfterBracket.match(BLOCK_ID_RE);
    return m ? m[1] : undefined;
}

export function snapshotLines(lines: string[]): TaskLineSnapshot[] {
    const out: TaskLineSnapshot[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_LINE_RE);
        if (!m) continue;
        out.push({
            lineNumber: i,
            statusSymbol: m[2],
            descriptionHash: descriptionHash(m[3]),
            blockId: extractBlockId(m[3]),
        });
    }
    return out;
}

export type DiffEvent = Omit<CompletionEvent, 'file'>;

export function diffSnapshot(
    oldSnaps: TaskLineSnapshot[],
    newLines: string[],
    doneSymbols: string[],
): DiffEvent[] {
    const newSnaps = snapshotLines(newLines);
    const newByHash = new Map<string, TaskLineSnapshot[]>();
    for (const s of newSnaps) {
        const bucket = newByHash.get(s.descriptionHash);
        if (bucket) bucket.push(s);
        else newByHash.set(s.descriptionHash, [s]);
    }

    const events: DiffEvent[] = [];
    const consumed = new Set<TaskLineSnapshot>();
    for (const oldSnap of oldSnaps) {
        const candidates = newByHash.get(oldSnap.descriptionHash);
        if (!candidates) continue;
        const wasDone = doneSymbols.includes(oldSnap.statusSymbol);
        // Prefer a candidate that completes the transition we care about
        // (so a recurrence-inserted unchanged line doesn't mask the toggle).
        // Fall back to any unconsumed candidate to keep deterministic identity matching.
        let matched: TaskLineSnapshot | undefined;
        if (!wasDone) {
            matched = candidates.find(
                c => !consumed.has(c) && doneSymbols.includes(c.statusSymbol),
            );
        }
        if (!matched) {
            matched = candidates.find(c => !consumed.has(c));
        }
        if (!matched) continue;
        consumed.add(matched);
        const isDone = doneSymbols.includes(matched.statusSymbol);
        if (!wasDone && isDone) {
            events.push({
                lineNumber: matched.lineNumber,
                taskLine: newLines[matched.lineNumber],
                previousStatus: oldSnap.statusSymbol,
                newStatus: matched.statusSymbol,
                blockId: matched.blockId,
            });
        }
    }
    // Sort by line number for deterministic ordering.
    events.sort((a, b) => a.lineNumber - b.lineNumber);
    return events;
}

export class FileWatchDetector implements CompletionDetector {
    private cache = new Map<string, TaskLineSnapshot[]>();
    private handler: CompletionHandler | null = null;
    private modifyRef: EventRef | null = null;
    private renameRef: EventRef | null = null;
    private deleteRef: EventRef | null = null;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private app: App, private settings: DocPromptSettings) {}

    onCompletion(handler: CompletionHandler): void {
        this.handler = handler;
    }

    start(): void {
        // Async warm-up: build cache without blocking onload().
        void this.warmCache();
        this.modifyRef = this.app.vault.on('modify', (file: any) => {
            if (!(file && file.extension === 'md')) return;
            this.scheduleDiff(file as TFile);
        });
        this.renameRef = this.app.vault.on('rename', (file: any, oldPath: string) => {
            if (this.cache.has(oldPath)) {
                const snaps = this.cache.get(oldPath)!;
                this.cache.delete(oldPath);
                this.cache.set(file.path, snaps);
            }
        });
        this.deleteRef = this.app.vault.on('delete', (file: any) => {
            this.cache.delete(file.path);
        });
    }

    stop(): void {
        for (const t of this.debounceTimers.values()) clearTimeout(t);
        this.debounceTimers.clear();
        const off = (ref: EventRef | null) => {
            if (!ref) return;
            (this.app.vault as any).offref?.(ref);
        };
        off(this.modifyRef); this.modifyRef = null;
        off(this.renameRef); this.renameRef = null;
        off(this.deleteRef); this.deleteRef = null;
    }

    private async warmCache(): Promise<void> {
        try {
            for (const file of this.app.vault.getMarkdownFiles()) {
                const content = await this.app.vault.read(file);
                this.cache.set(file.path, snapshotLines(content.split('\n')));
            }
        } catch (err) {
            console.error('[FileWatchDetector] warmCache failed:', err);
        }
    }

    private scheduleDiff(file: TFile): void {
        const existing = this.debounceTimers.get(file.path);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            this.debounceTimers.delete(file.path);
            void this.runDiff(file);
        }, 75);
        this.debounceTimers.set(file.path, t);
    }

    private async runDiff(file: TFile): Promise<void> {
        if (!this.handler) return;
        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const oldSnaps = this.cache.get(file.path) ?? [];
            const events = diffSnapshot(oldSnaps, lines, this.settings.doneStatusSymbols);
            this.cache.set(file.path, snapshotLines(lines));
            for (const ev of events) {
                await this.handler({ ...ev, file });
            }
        } catch (err) {
            console.error('[FileWatchDetector] runDiff failed:', err);
        }
    }
}
