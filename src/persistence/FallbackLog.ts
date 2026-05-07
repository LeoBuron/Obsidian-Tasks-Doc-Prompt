import type { App, TFile } from 'obsidian';

export interface FallbackEntry {
    timestamp: Date;
    taskLine: string;
    userText: string;
    filePath: string;
    lineNumber: number;
    reason: string;
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function fmtDateTime(d: Date): string {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
        `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function shortTaskText(taskLine: string): string {
    // Strip the leading "- [x] " marker for the heading.
    return taskLine.replace(/^\s*[-*+]\s*\[[^\]]\]\s*/, '').trim();
}

export function formatLogEntry(e: FallbackEntry): string {
    const heading = `## ${fmtDateTime(e.timestamp)} — ${shortTaskText(e.taskLine)}`;
    return [
        heading,
        '',
        e.userText,
        '',
        `[Original location: ${e.filePath}:${e.lineNumber}]`,
        '',
        '---',
        '',
    ].join('\n');
}

export class FallbackLog {
    constructor(private app: App, private path: string) {}

    async append(entry: FallbackEntry): Promise<void> {
        const text = formatLogEntry(entry);
        const existing = this.app.vault.getAbstractFileByPath(this.path) as TFile | null;
        if (!existing) {
            await this.app.vault.create(this.path, text);
        } else {
            await this.app.vault.append(existing, text);
        }
    }
}
