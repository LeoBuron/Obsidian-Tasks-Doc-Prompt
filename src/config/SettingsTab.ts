import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { DocPromptSettings } from './Settings';
import type { DeferredEntry } from '../persistence/SkipStateStore';
import { formatDeferPattern } from '../scheduling/DeferPattern';

export interface SettingsTabHost {
    settings: DocPromptSettings;
    saveSettings(): Promise<void>;
    listPermanentSkips(): { taskId: string; label: string; filePath: string }[];
    removePermanentSkip(taskId: string): void;
    listDeferred(): DeferredEntry[];
    cancelDeferred(taskId: string): void;
    editDeferred(entry: DeferredEntry): Promise<void>;
    processAllDeferred(): void;
}

export class DocPromptSettingsTab extends PluginSettingTab {
    constructor(app: App, plugin: Plugin, private host: SettingsTabHost) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Trigger
        containerEl.createEl('h3', { text: 'Trigger' });

        new Setting(containerEl)
            .setName('Done status symbols')
            .setDesc('Comma-separated list of status characters that count as DONE. Default: x,X')
            .addText((t: any) => {
                t.setValue(this.host.settings.doneStatusSymbols.join(','))
                    .onChange(async (v: any) => {
                        this.host.settings.doneStatusSymbols = v.split(',').map((s: any) => s.trim()).filter((s: any) => s.length > 0);
                        await this.host.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Enabled folders')
            .setDesc('Comma-separated paths. Empty = all folders.')
            .addText((t: any) => {
                t.setValue(this.host.settings.enabledFolders.join(','))
                    .onChange(async (v: any) => {
                        this.host.settings.enabledFolders = v.split(',').map((s: any) => s.trim()).filter((s: any) => s.length > 0);
                        await this.host.saveSettings();
                    });
            });

        // Defer
        containerEl.createEl('h3', { text: 'Defer' });

        new Setting(containerEl)
            .setName('Default defer duration (minutes)')
            .setDesc("How long 'Not now' postpones the prompt.")
            .addText((t: any) => {
                t.setValue(String(this.host.settings.defaultDeferDurationMinutes))
                    .onChange(async (v: any) => {
                        const n = parseInt(v, 10);
                        if (Number.isFinite(n) && n > 0) {
                            this.host.settings.defaultDeferDurationMinutes = n;
                            await this.host.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('Auto re-prompt on start')
            .setDesc('Re-process due deferred items when Obsidian (re)starts.')
            .addToggle((t: any) => {
                t.setValue(this.host.settings.autoRepromptOnStart)
                    .onChange(async (v: any) => {
                        this.host.settings.autoRepromptOnStart = v;
                        await this.host.saveSettings();
                    });
            });

        // Writer
        containerEl.createEl('h3', { text: 'Writer' });

        new Setting(containerEl)
            .setName('Fallback log path')
            .setDesc('Where to log entries that could not be written back to the original file.')
            .addText((t: any) => {
                t.setValue(this.host.settings.fallbackLogPath)
                    .onChange(async (v: any) => {
                        this.host.settings.fallbackLogPath = v.trim() || 'Tasks Doc-Prompt — Lost.md';
                        await this.host.saveSettings();
                    });
            });

        // Deferred
        containerEl.createEl('h3', { text: 'Deferred tasks' });
        const deferred = this.host.listDeferred();
        new Setting(containerEl)
            .setName(`${deferred.length} deferred entries`)
            .addButton((b: any) => {
                b.setButtonText('Process all now').onClick(() => {
                    this.host.processAllDeferred();
                    new Notice('Queued all deferred entries.');
                });
            });

        if (deferred.length === 0) {
            containerEl.createEl('div', { text: '(none)' });
        } else {
            for (const entry of deferred) {
                const label = entry.snapshot.taskLine.length > 80
                    ? entry.snapshot.taskLine.slice(0, 77) + '…'
                    : entry.snapshot.taskLine;
                const when = formatRemindAt(entry.remindAt, Date.now());
                const recurrenceLabel = entry.recurrence
                    ? `⟲ ${formatDeferPattern(entry.recurrence)}`
                    : '·';
                new Setting(containerEl)
                    .setName(label)
                    .setDesc(`${when}    ${recurrenceLabel}    ${entry.snapshot.filePath}`)
                    .addButton((b: any) => {
                        b.setButtonText('Edit').onClick(async () => {
                            await this.host.editDeferred(entry);
                            if (this.containerEl.isConnected) this.display();
                        });
                    })
                    .addButton((b: any) => {
                        b.setButtonText('Cancel').onClick(() => {
                            this.host.cancelDeferred(entry.taskId);
                            if (this.containerEl.isConnected) this.display();
                        });
                    });
            }
        }

        // Permanent skips
        containerEl.createEl('h3', { text: 'Permanently skipped' });
        const skips = this.host.listPermanentSkips();
        if (skips.length === 0) {
            containerEl.createEl('div', { text: '(none)' });
        } else {
            for (const s of skips) {
                new Setting(containerEl)
                    .setName(s.label.length > 80 ? s.label.slice(0, 77) + '…' : s.label)
                    .setDesc(s.filePath)
                    .addButton((b: any) => {
                        b.setButtonText('Re-enable').onClick(() => {
                            this.host.removePermanentSkip(s.taskId);
                            this.display();
                        });
                    });
            }
        }

        // Enforced mode (disabled placeholder)
        containerEl.createEl('h3', { text: 'Enforced mode' });
        new Setting(containerEl)
            .setName('Block task completion until documented')
            .setDesc('Available once the Tasks plugin exposes a completion hook.')
            .addToggle((t: any) => {
                t.setValue(false).setDisabled(true);
            });
    }
}

function formatRemindAt(remindAt: number, now: number): string {
    const r = new Date(remindAt);
    const n = new Date(now);
    const sameDay = r.getFullYear() === n.getFullYear()
        && r.getMonth() === n.getMonth()
        && r.getDate() === n.getDate();
    const tomorrow = new Date(n);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = r.getFullYear() === tomorrow.getFullYear()
        && r.getMonth() === tomorrow.getMonth()
        && r.getDate() === tomorrow.getDate();
    const hh = r.getHours();
    const mm = r.getMinutes().toString().padStart(2, '0');
    if (sameDay) return `today ${hh}:${mm}`;
    if (isTomorrow) return `tomorrow ${hh}:${mm}`;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[r.getMonth()]} ${r.getDate()}, ${hh}:${mm}`;
}
