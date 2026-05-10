import type { App, TFile } from 'obsidian';
import { computeIdFromLine } from '../identity/TaskIdentity';

const TASK_LINE_RE = /^(\s*)[-*+]\s*\[([^\]])\]\s*(.*)$/;

export type LookupResult =
    | { kind: 'done'; file: TFile; lineNumber: number; taskLine: string; statusSymbol: string }
    | { kind: 'open' }
    | { kind: 'not-found' };

export async function lookupTaskById(
    app: App,
    filePath: string,
    taskId: string,
    doneSymbols: string[],
): Promise<LookupResult> {
    const file = app.vault.getFileByPath(filePath);
    if (!file) return { kind: 'not-found' };
    const content = await app.vault.read(file as TFile);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_LINE_RE);
        if (!m) continue;
        const id = computeIdFromLine(filePath, lines[i]);
        if (id !== taskId) continue;
        const statusSymbol = m[2];
        if (doneSymbols.includes(statusSymbol)) {
            return {
                kind: 'done',
                file: file as TFile,
                lineNumber: i,
                taskLine: lines[i],
                statusSymbol,
            };
        }
        return { kind: 'open' };
    }
    return { kind: 'not-found' };
}
