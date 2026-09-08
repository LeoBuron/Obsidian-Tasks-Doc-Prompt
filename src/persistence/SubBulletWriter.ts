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

/** What the user typed in the prompt. Both fields are optional. */
export interface PromptInput {
    /** Free text, written as a plain comment sub-bullet. */
    documentation: string;
    /** Free text, written as an open task below the comment. */
    followUp: string;
}

export class SubBulletWriter {
    constructor(private app: App, private fallbackLog: FallbackLog) {}

    private indentationStyle(): IndentationStyle {
        const useTab = (this.app.vault.getConfig?.('useTab') ?? true) as boolean;
        const tabSize = (this.app.vault.getConfig?.('tabSize') ?? 4) as number;
        return { indentWithTabs: useTab, tabSize };
    }

    /**
     * Writes both prompt fields under the completed task in one pass: the
     * documentation as a comment sub-bullet, the follow-up as an open task
     * below it. A field left blank contributes nothing.
     */
    async write(event: CompletionEvent, input: PromptInput): Promise<void> {
        const { documentation, followUp } = input;
        // Nothing typed means nothing to write and nothing to lose: skip the
        // vault rewrite, and — crucially — the fallback log, which would
        // otherwise record an empty entry whenever the parent line moved.
        if (documentation.trim() === '' && followUp.trim() === '') return;

        const style = this.indentationStyle();
        await this.writeUnder(
            event,
            (lines, index) => {
                // Both composers insert at index + 1, so composing the
                // follow-up FIRST leaves the documentation above it.
                const withTask = composeFollowUpTask(lines, index, followUp, style);
                return composeSubBullet(withTask, index, documentation, style);
            },
            this.fallbackText(event.taskLine, input),
        );
    }

    /**
     * What goes in the fallback log when the parent line cannot be found. The
     * live line is gone, so tags come from the completion snapshot, and the
     * follow-up is logged as a real task line so it stays visible to Tasks
     * queries until the user moves it.
     */
    private fallbackText(taskLine: string, input: PromptInput): string {
        const blocks: string[] = [];
        if (input.documentation.trim() !== '') blocks.push(input.documentation.replace(/\s+$/, ''));
        const task = composeFollowUpText(input.followUp, extractTags(taskLine));
        if (task !== '') blocks.push(`- ${task}`);
        return blocks.join('\n\n');
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
