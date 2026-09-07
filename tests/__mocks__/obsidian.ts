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
    /** Every message shown since the last reset — tests inspect and clear this. */
    static messages: string[] = [];
    constructor(public message: string) {
        Notice.messages.push(message);
    }
}

export type FakeElOpts = { cls?: string; text?: string; type?: string };

/**
 * Minimal fake of the element helpers Obsidian adds to HTMLElement
 * (createEl / createDiv / setText / ...). Just enough to open a Modal in Jest
 * and drive its buttons; it is not a DOM.
 */
export class FakeEl {
    tag: string;
    cls: string;
    text: string;
    type: string | undefined;
    children: FakeEl[] = [];
    parent: FakeEl | null = null;
    style: Record<string, string> = {};
    attrs: Record<string, string> = {};
    listeners: Record<string, Array<(ev: any) => void>> = {};
    value = '';
    checked = false;
    rows = 0;
    placeholder = '';

    constructor(tag: string, opts: FakeElOpts = {}) {
        this.tag = tag;
        this.cls = opts.cls ?? '';
        this.text = opts.text ?? '';
        this.type = opts.type;
    }

    createEl(tag: string, opts?: FakeElOpts): FakeEl {
        const el = new FakeEl(tag, opts);
        el.parent = this;
        this.children.push(el);
        return el;
    }
    createDiv(opts?: FakeElOpts): FakeEl { return this.createEl('div', opts); }
    addEventListener(name: string, cb: (ev: any) => void): void {
        (this.listeners[name] ??= []).push(cb);
    }
    dispatch(name: string, ev: Record<string, unknown> = {}): void {
        for (const cb of this.listeners[name] ?? []) cb({ preventDefault: () => {}, ...ev });
    }
    click(): void { this.dispatch('click'); }
    setAttr(key: string, value: string): void { this.attrs[key] = value; }
    setText(text: string): void { this.text = text; }
    appendText(text: string): void { this.text += text; }
    empty(): void {
        for (const c of this.children) c.parent = null;
        this.children = [];
    }
    remove(): void {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
    }
    focus(): void {}
    /** Depth-first search over descendants. */
    find(pred: (el: FakeEl) => boolean): FakeEl | null {
        for (const c of this.children) {
            if (pred(c)) return c;
            const deeper = c.find(pred);
            if (deeper) return deeper;
        }
        return null;
    }
    findAll(pred: (el: FakeEl) => boolean): FakeEl[] {
        const out: FakeEl[] = [];
        for (const c of this.children) {
            if (pred(c)) out.push(c);
            out.push(...c.findAll(pred));
        }
        return out;
    }
}

export class Modal {
    contentEl: any = new FakeEl('div');
    titleEl: any = new FakeEl('div');
    constructor(app: App) {}
    // Mirror Obsidian: opening/closing runs the lifecycle hooks.
    open(): void { this.onOpen(); }
    close(): void { this.onClose(); }
    onOpen(): void {}
    onClose(): void {}
}

export class Setting {
    constructor(_containerEl: any) {}
    setName(_n: string): this { return this; }
    setDesc(_d: string): this { return this; }
    addText(_cb: any): this {
        _cb({
            setValue: (_v: any) => ({
                onChange: (_h: any) => {},
            }),
        });
        return this;
    }
    addToggle(_cb: any): this {
        _cb({
            setValue: (_v: any) => ({
                onChange: (_h: any) => {},
                setDisabled: (_d: any) => ({
                    onChange: (_h: any) => {},
                }),
            }),
            setDisabled: (_d: any) => ({
                onChange: (_h: any) => {},
            }),
        });
        return this;
    }
    addButton(_cb: any): this {
        _cb({
            setButtonText: (_t: any) => ({
                onClick: (_h: any) => {},
            }),
        });
        return this;
    }
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
    getFileByPath(path: string): TFile | null;
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
