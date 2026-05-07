import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { DocPromptSettings } from './Settings';

export interface SettingsTabHost {
    settings: DocPromptSettings;
    saveSettings(): Promise<void>;
    listPermanentSkips(): { taskId: string; label: string; filePath: string }[];
    removePermanentSkip(taskId: string): void;
    deferredCount(): number;
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
        new Setting(containerEl)
            .setName(`${this.host.deferredCount()} deferred entries`)
            .addButton((b: any) => {
                b.setButtonText('Process all now').onClick(() => {
                    this.host.processAllDeferred();
                    new Notice('Queued all deferred entries.');
                });
            });

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
