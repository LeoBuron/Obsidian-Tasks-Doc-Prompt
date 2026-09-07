import type { App, TFile } from 'obsidian';
import type { CompletionEvent } from '../detection/types';
import type { FallbackLog } from './FallbackLog';
import { stripTasksFields } from '../identity/TaskIdentity';
import { composeFollowUpText, extractTags } from './FollowUpTask';

export interface IndentationStyle {
    indentWithTabs: boolean;
    tabSize: number; // used only when indentWithTabs is false
}

export function composeSubBullet(
    lines: string[],
    lineIndex: number,
    userText: string,
    style: IndentationStyle,
): string[] {
    if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error(`composeSubBullet: lineIndex ${lineIndex} out of range (0..${lines.length - 1})`);
    }

    const taskLine = lines[lineIndex];
    const existingIndent = taskLine.match(/^(\s*)/)?.[1] ?? '';
    const oneStep = style.indentWithTabs ? '\t' : ' '.repeat(style.tabSize);
    const childIndent = existingIndent + oneStep;
    const continuationIndent = childIndent + '  '; // align with text after "- "

    const trimmed = userText.replace(/\s+$/, '');
    const userLines = trimmed.split('\n');
    if (userLines.length === 0 || (userLines.length === 1 && userLines[0] === '')) {
        return lines.slice();
    }

    const composed: string[] = [];
    composed.push(`${childIndent}- ${userLines[0]}`);
    for (let i = 1; i < userLines.length; i++) {
        composed.push(`${continuationIndent}${userLines[i]}`);
    }

    const out = lines.slice();
    out.splice(lineIndex + 1, 0, ...composed);
    return out;
}

/**
 * Inserts an open follow-up task one step under the task at `lineIndex`,
 * inheriting the tags found on that (live) parent line. Same placement and
 * indentation rules as a comment sub-bullet.
 */
export function composeFollowUpTask(
    lines: string[],
    lineIndex: number,
    userText: string,
    style: IndentationStyle,
): string[] {
    if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error(`composeFollowUpTask: lineIndex ${lineIndex} out of range (0..${lines.length - 1})`);
    }
    const text = composeFollowUpText(userText, extractTags(lines[lineIndex]));
    return composeSubBullet(lines, lineIndex, text, style);
}

type Composer = (lines: string[], lineIndex: number) => string[];

export class SubBulletWriter {
    constructor(private app: App, private fallbackLog: FallbackLog) {}

    private indentationStyle(): IndentationStyle {
        const useTab = (this.app.vault.getConfig?.('useTab') ?? true) as boolean;
        const tabSize = (this.app.vault.getConfig?.('tabSize') ?? 4) as number;
        return { indentWithTabs: useTab, tabSize };
    }

    /** Writes the user's paragraph as a plain sub-bullet under the completed task. */
    async write(event: CompletionEvent, userText: string): Promise<void> {
        await this.writeUnder(
            event,
            (lines, index) => composeSubBullet(lines, index, userText, this.indentationStyle()),
            userText,
        );
    }

    /** Writes an open follow-up task under the completed task, inheriting its tags. */
    async writeFollowUp(event: CompletionEvent, userText: string): Promise<void> {
        // The fallback log has no live line to read tags from, so use the
        // snapshot's tags and log a paste-ready task line.
        const composed = composeFollowUpText(userText, extractTags(event.taskLine));
        await this.writeUnder(
            event,
            (lines, index) => composeFollowUpTask(lines, index, userText, this.indentationStyle()),
            composed === '' ? userText : `- ${composed}`,
        );
    }

    /**
     * Locates the task line, applies `compose` to insert under it, and — if the
     * line cannot be found — appends `fallbackText` to the fallback log so the
     * user's input is never lost.
     */
    private async writeUnder(event: CompletionEvent, compose: Composer, fallbackText: string): Promise<void> {
        const state: { resolvedIndex: number | null; mismatchReason: string | null } = {
            resolvedIndex: null,
            mismatchReason: null,
        };

        await this.app.vault.process(event.file as TFile, (data) => {
            const lines = data.split('\n');
            const target = this.locate(lines, event);
            if (target.index === null) {
                state.mismatchReason = target.reason;
                return data;
            }
            state.resolvedIndex = target.index;
            return compose(lines, target.index).join('\n');
        });

        if (state.resolvedIndex === null) {
            await this.fallbackLog.append({
                timestamp: new Date(),
                taskLine: event.taskLine,
                userText: fallbackText,
                filePath: event.file.path,
                lineNumber: event.lineNumber,
                reason: state.mismatchReason ?? 'unknown',
            });
        }
    }

    private locate(lines: string[], event: CompletionEvent): { index: number | null; reason: string } {
        const desc = stripTasksFields(event.taskLine);

        // Primary: by line number, verify description matches.
        if (event.lineNumber >= 0 && event.lineNumber < lines.length) {
            if (stripTasksFields(lines[event.lineNumber]) === desc) {
                return { index: event.lineNumber, reason: '' };
            }
        }

        // Fallback: linear scan for any task line whose stripped description matches.
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*[-*+]\s*\[[^\]]\]/.test(lines[i]) && stripTasksFields(lines[i]) === desc) {
                return { index: i, reason: '' };
            }
        }

        return { index: null, reason: 'description-not-found' };
    }
}
