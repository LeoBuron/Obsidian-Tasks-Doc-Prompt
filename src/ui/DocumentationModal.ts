import { App, Modal, Notice } from 'obsidian';
import {
    parseDeferInput,
    computeNextMatch,
    DeferPatternParseError,
    type DeferPattern,
} from '../scheduling/DeferPattern';

export type ModalResult =
    | { kind: 'save'; text: string }
    | { kind: 'defer'; remindAt?: number; recurrence?: DeferPattern }
    | { kind: 'permanent-skip' }
    | { kind: 'cancel' };

export interface ModalPrefill {
    remindAt: number;
    recurrence?: DeferPattern;
}

export class DocumentationModal extends Modal {
    private resolve!: (r: ModalResult) => void;
    private settled = false;
    private textarea: HTMLTextAreaElement | null = null;
    private panelEl: HTMLElement | null = null;
    private dayInput: HTMLInputElement | null = null;
    private hourInput: HTMLInputElement | null = null;
    private minInput: HTMLInputElement | null = null;
    private recurringInput: HTMLInputElement | null = null;
    taskLine: string;
    private prefill: ModalPrefill | null;

    constructor(app: App, taskLine: string, prefill?: ModalPrefill) {
        super(app);
        this.taskLine = taskLine;
        this.prefill = prefill ?? null;
    }

    show(): Promise<ModalResult> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.prefill ? 'Edit deferred prompt' : 'What did you do?');
        contentEl.empty();

        // Task-line context (always shown, including edit mode)
        const ctx = contentEl.createDiv({ cls: 'tdp-context' });
        const ctxLine = ctx.createEl('div', { cls: 'tdp-context-line', text: this.taskLine });
        ctxLine.setAttr('title', this.taskLine);
        ctxLine.style.fontStyle = 'italic';
        ctxLine.style.opacity = '0.8';
        ctxLine.style.overflow = 'hidden';
        ctxLine.style.textOverflow = 'ellipsis';
        ctxLine.style.whiteSpace = 'nowrap';
        ctxLine.style.marginBottom = '0.75em';

        if (!this.prefill) {
            // Normal mode: textarea + 4 buttons
            const ta = contentEl.createEl('textarea', { cls: 'tdp-textarea' });
            this.textarea = ta;
            ta.rows = 5;
            ta.style.width = '100%';
            ta.placeholder = 'A short paragraph describing what you did…';
            setTimeout(() => this.textarea?.focus(), 0);
            ta.addEventListener('keydown', (ev: KeyboardEvent) => {
                if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
                    ev.preventDefault();
                    this.settle({ kind: 'save', text: this.textarea!.value });
                }
            });
        }

        const btnRow = contentEl.createDiv({ cls: 'tdp-buttons' });
        btnRow.style.display = 'flex';
        btnRow.style.gap = '0.5em';
        btnRow.style.marginTop = '0.75em';

        if (!this.prefill) {
            const save = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
            save.addEventListener('click', () => {
                this.settle({ kind: 'save', text: this.textarea!.value });
            });

            const defer = btnRow.createEl('button', { text: 'Not now' });
            defer.addEventListener('click', () => {
                this.settle({ kind: 'defer' });
            });
        }

        if (!this.prefill) {
            const deferUntil = btnRow.createEl('button', { text: 'Defer until…' });
            deferUntil.addEventListener('click', () => {
                this.togglePanel();
            });
        }

        if (!this.prefill) {
            const spacer = btnRow.createDiv();
            spacer.style.flex = '1';

            const skip = btnRow.createEl('button', { text: "Don't ask for this" });
            skip.addEventListener('click', () => {
                this.settle({ kind: 'permanent-skip' });
            });
        }

        // Edit mode: open panel by default and render Cancel/Confirm at the
        // panel level (no top-level Save / Don't ask).
        if (this.prefill) {
            this.openPanel(this.prefill);
        }
    }

    private togglePanel(): void {
        if (this.panelEl) {
            this.panelEl.remove();
            this.panelEl = null;
            this.dayInput = this.hourInput = this.minInput = null;
            this.recurringInput = null;
            return;
        }
        this.openPanel(null);
    }

    private openPanel(prefill: ModalPrefill | null): void {
        const panel = this.contentEl.createDiv({ cls: 'tdp-defer-panel' });
        panel.style.marginTop = '0.75em';
        panel.style.padding = '0.5em';
        panel.style.borderTop = '1px solid var(--background-modifier-border)';
        this.panelEl = panel;

        panel.createEl('div', { text: 'Defer to:' });

        const presetRow = panel.createDiv({ cls: 'tdp-presets' });
        presetRow.style.display = 'flex';
        presetRow.style.gap = '0.4em';
        presetRow.style.marginTop = '0.4em';

        const presets: { label: string; compute: (now: Date) => number }[] = [
            { label: 'in 1h', compute: (now) => now.getTime() + 60 * 60_000 },
            { label: 'in 4h', compute: (now) => now.getTime() + 4 * 60 * 60_000 },
            {
                label: 'tomorrow 9:00',
                compute: (now) => {
                    const c = new Date(now);
                    c.setDate(c.getDate() + 1);
                    c.setHours(9, 0, 0, 0);
                    return c.getTime();
                },
            },
            {
                label: 'next :00',
                compute: (now) => {
                    const c = new Date(now);
                    c.setSeconds(0, 0);
                    c.setHours(c.getHours() + 1, 0);
                    return c.getTime();
                },
            },
        ];
        for (const p of presets) {
            const btn = presetRow.createEl('button', { text: p.label });
            btn.addEventListener('click', () => {
                this.settle({ kind: 'defer', remindAt: p.compute(new Date()) });
            });
        }

        // Custom row
        const customRow = panel.createDiv({ cls: 'tdp-custom' });
        customRow.style.display = 'flex';
        customRow.style.gap = '0.4em';
        customRow.style.alignItems = 'center';
        customRow.style.marginTop = '0.6em';
        customRow.createEl('span', { text: 'Custom:' });
        this.dayInput = this.makeField(customRow, 'Days', '*');
        this.hourInput = this.makeField(customRow, 'Hour', '*');
        this.minInput = this.makeField(customRow, 'Min', '*');

        // Recurring checkbox
        const recRow = panel.createDiv({ cls: 'tdp-recurring' });
        recRow.style.marginTop = '0.4em';
        const recLbl = recRow.createEl('label');
        this.recurringInput = recLbl.createEl('input', { type: 'checkbox' });
        recLbl.appendText(' recurring');

        // Confirm / Cancel
        const ctrlRow = panel.createDiv({ cls: 'tdp-ctrls' });
        ctrlRow.style.display = 'flex';
        ctrlRow.style.gap = '0.4em';
        ctrlRow.style.justifyContent = 'flex-end';
        ctrlRow.style.marginTop = '0.6em';
        const cancel = ctrlRow.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => {
            if (this.prefill) {
                this.settle({ kind: 'cancel' });
            } else {
                this.togglePanel();
            }
        });
        const confirm = ctrlRow.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
        confirm.addEventListener('click', () => this.confirmCustom());

        // Apply prefill values for edit mode
        if (prefill) {
            const pat = prefill.recurrence;
            if (pat) {
                this.dayInput.value = pat.daysFromNow === null ? '*' : String(pat.daysFromNow);
                this.hourInput.value = pat.hour === null ? '*' : String(pat.hour);
                this.minInput.value = pat.minute === null ? '*' : String(pat.minute);
                this.recurringInput!.checked = true;
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private makeField(parent: any, label: string, defaultValue: string): HTMLInputElement {
        const wrap = parent.createEl('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'center';
        const input = wrap.createEl('input', { type: 'text' });
        input.value = defaultValue;
        input.style.width = '3em';
        input.style.textAlign = 'center';
        wrap.createEl('small', { text: label });
        return input;
    }

    private confirmCustom(): void {
        const raw = `${this.dayInput?.value ?? ''} ${this.hourInput?.value ?? ''} ${this.minInput?.value ?? ''}`;
        let pattern: DeferPattern;
        try {
            pattern = parseDeferInput(raw);
        } catch (err) {
            const msg = err instanceof DeferPatternParseError ? err.message : String(err);
            new Notice(msg);
            if (err instanceof DeferPatternParseError) {
                const r = err.reason;
                if (r.startsWith('Day')) this.dayInput?.focus();
                else if (r.startsWith('Hour')) this.hourInput?.focus();
                else if (r.startsWith('Min')) this.minInput?.focus();
            }
            return;
        }
        const remindAt = computeNextMatch(pattern, new Date());
        const recurring = !!this.recurringInput?.checked;
        this.settle({
            kind: 'defer',
            remindAt,
            recurrence: recurring ? pattern : undefined,
        });
    }

    onClose(): void {
        if (!this.settled) {
            // Closed via Esc / X button. Edit mode → cancel; normal → defer.
            this.settle(this.prefill ? { kind: 'cancel' } : { kind: 'defer' });
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
