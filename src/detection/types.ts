import type { TFile } from 'obsidian';

export type CompletionEvent = {
    file: TFile;
    lineNumber: number;       // 0-based
    taskLine: string;         // full markdown line, post-toggle (with [x])
    previousStatus: string;   // e.g. " "
    newStatus: string;        // e.g. "x"
    blockId?: string;         // present iff task line contains ^xyz
};
