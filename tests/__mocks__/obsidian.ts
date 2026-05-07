// Hand-written Obsidian mock — exposes only the surface our code touches.
// Each usage site adds the bits it needs; do not over-extend.

export class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    constructor(path: string) {
        this.path = path;
        this.name = path.split('/').pop() ?? path;
        this.basename = this.name.replace(/\.md$/, '');
        this.extension = 'md';
    }
}

export class Notice {
    constructor(public message: string) {}
}

export class Modal {
    contentEl: any = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
    titleEl: any = { setText: (_: string) => {} };
    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
}

export class Setting {
    constructor(_containerEl: any) {}
    setName(_n: string): this { return this; }
    setDesc(_d: string): this { return this; }
    addText(_cb: any): this { return this; }
    addToggle(_cb: any): this { return this; }
    addButton(_cb: any): this { return this; }
    addTextArea(_cb: any): this { return this; }
    addExtraButton(_cb: any): this { return this; }
}

export class PluginSettingTab {
    containerEl: any = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
    constructor(public app: any, public plugin: any) {}
    display(): void {}
    hide(): void {}
}

export class Plugin {
    app: any;
    manifest: any;
    constructor(app: any, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }
    addCommand(_c: any): void {}
    addRibbonIcon(_i: string, _t: string, _cb: any): any { return {}; }
    addSettingTab(_t: any): void {}
    registerEvent(_e: any): void {}
    registerInterval(_i: number): number { return _i; }
    async loadData(): Promise<any> { return null; }
    async saveData(_d: any): Promise<void> {}
}

export interface Vault {
    getMarkdownFiles(): TFile[];
    read(file: TFile): Promise<string>;
    process(file: TFile, fn: (data: string) => string): Promise<string>;
    create(path: string, data: string): Promise<TFile>;
    append(file: TFile, data: string): Promise<void>;
    on(name: string, cb: (...args: any[]) => any): any;
    getAbstractFileByPath(path: string): any;
    getConfig?(key: string): any;
}

export interface App {
    vault: Vault;
    workspace: any;
    plugins?: any;
}

export type EventRef = unknown;

export function debounce<T extends (...args: any[]) => any>(
    fn: T, _ms: number, _resetTimer?: boolean,
): T & { cancel: () => void } {
    const wrapped: any = (...args: any[]) => fn(...args);
    wrapped.cancel = () => {};
    return wrapped;
}
