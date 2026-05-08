import { App, Modal } from 'obsidian';
import type { DeferPattern } from '../scheduling/DeferPattern';

export type ModalResult =
    | { kind: 'save'; text: string }
    | { kind: 'defer'; remindAt?: number; recurrence?: DeferPattern }
    | { kind: 'permanent-skip' }
    | { kind: 'cancel' };

export class DocumentationModal extends Modal {
    private resolve!: (r: ModalResult) => void;
    private settled = false;
    private textarea!: HTMLTextAreaElement;
    taskLine: string;

    constructor(app: App, taskLine: string) {
        super(app);
        this.taskLine = taskLine;
    }

    show(): Promise<ModalResult> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText('What did you do?');

        contentEl.empty();

        const ctx = contentEl.createDiv({ cls: 'tdp-context' });
        const ctxLine = ctx.createEl('div', { cls: 'tdp-context-line', text: this.taskLine });
        ctxLine.setAttr('title', this.taskLine);
        ctxLine.style.fontStyle = 'italic';
        ctxLine.style.opacity = '0.8';
        ctxLine.style.overflow = 'hidden';
        ctxLine.style.textOverflow = 'ellipsis';
        ctxLine.style.whiteSpace = 'nowrap';
        ctxLine.style.marginBottom = '0.75em';

        this.textarea = contentEl.createEl('textarea', { cls: 'tdp-textarea' });
        this.textarea.rows = 5;
        this.textarea.style.width = '100%';
        this.textarea.placeholder = 'A short paragraph describing what you did…';
        setTimeout(() => this.textarea.focus(), 0);

        this.textarea.addEventListener('keydown', (ev) => {
            if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
                ev.preventDefault();
                this.settle({ kind: 'save', text: this.textarea.value });
            }
        });

        const btnRow = contentEl.createDiv({ cls: 'tdp-buttons' });
        btnRow.style.display = 'flex';
        btnRow.style.gap = '0.5em';
        btnRow.style.marginTop = '0.75em';

        const save = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
        save.addEventListener('click', () => {
            this.settle({ kind: 'save', text: this.textarea.value });
        });

        const defer = btnRow.createEl('button', { text: 'Not now' });
        defer.addEventListener('click', () => {
            this.settle({ kind: 'defer' });
        });

        const spacer = btnRow.createDiv();
        spacer.style.flex = '1';

        const skip = btnRow.createEl('button', { text: "Don't ask for this" });
        skip.addEventListener('click', () => {
            this.settle({ kind: 'permanent-skip' });
        });
    }

    onClose(): void {
        if (!this.settled) {
            // Closed via Esc / X button → treat as defer.
            this.settle({ kind: 'defer' });
        }
        this.contentEl.empty();
    }

    private settle(result: ModalResult): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve(result);
        this.close();
    }
}
