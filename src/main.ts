import { Plugin } from 'obsidian';
import type { CompletionEvent } from './detection/types';
import { FileWatchDetector } from './detection/FileWatchDetector';
import { PromptOrchestrator } from './orchestration/PromptOrchestrator';
import { SkipStateStore } from './persistence/SkipStateStore';
import { SubBulletWriter } from './persistence/SubBulletWriter';
import { FallbackLog } from './persistence/FallbackLog';
import { DocumentationModal } from './ui/DocumentationModal';
import { DEFAULT_SETTINGS, mergeWithDefaults, type DocPromptSettings } from './config/Settings';
import { DocPromptSettingsTab } from './config/SettingsTab';

export default class DocPromptPlugin extends Plugin {
    settings: DocPromptSettings = { ...DEFAULT_SETTINGS };
    private skipStore!: SkipStateStore;
    private detector!: FileWatchDetector;
    private orchestrator!: PromptOrchestrator;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.skipStore = await SkipStateStore.load({
            load: () => this.loadSkipData(),
            save: (data) => this.saveSkipData(data),
        });

        const fallbackLog = new FallbackLog(this.app, this.settings.fallbackLogPath);
        const writer = new SubBulletWriter(this.app, fallbackLog);

        this.orchestrator = new PromptOrchestrator({
            app: this.app,
            settings: this.settings,
            skipStore: this.skipStore,
            modalShow: (taskLine) => new DocumentationModal(this.app, taskLine).show(),
            writer,
        });

        this.detector = new FileWatchDetector(this.app, this.settings);
        this.detector.onCompletion((e: CompletionEvent) => this.orchestrator.handle(e));
        this.detector.start();

        this.registerInterval(window.setInterval(() => {
            this.orchestrator.checkDeferred();
        }, 60_000));

        this.addCommand({
            id: 'process-deferred',
            name: 'Process all deferred',
            callback: () => this.orchestrator.processAllDeferred(),
        });

        this.addRibbonIcon('file-pen-line', 'Process deferred docs', () => {
            this.orchestrator.processAllDeferred();
        });

        this.addSettingTab(new DocPromptSettingsTab(this.app, this, {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
            listPermanentSkips: () => this.skipStore.listPermanent(),
            removePermanentSkip: (id) => this.skipStore.removePermanent(id),
            deferredCount: () => this.skipStore.getDeferred().length,
            processAllDeferred: () => this.orchestrator.processAllDeferred(),
        }));

        if (this.settings.autoRepromptOnStart) {
            this.registerInterval(window.setTimeout(() => this.orchestrator.checkDeferred(), 3000));
        }
    }

    onunload(): void {
        this.detector?.stop();
    }

    private async loadSettings(): Promise<void> {
        const raw = await this.loadData();
        this.settings = mergeWithDefaults(raw?.settings);
    }

    async saveSettings(): Promise<void> {
        const existing = (await this.loadData()) ?? {};
        await this.saveData({ ...existing, settings: this.settings });
        this.orchestrator?.setSettings(this.settings);
    }

    private async loadSkipData(): Promise<unknown> {
        const raw = (await this.loadData()) ?? {};
        return raw.skipState ?? null;
    }

    private async saveSkipData(data: unknown): Promise<void> {
        const existing = (await this.loadData()) ?? {};
        await this.saveData({ ...existing, skipState: data });
    }
}
