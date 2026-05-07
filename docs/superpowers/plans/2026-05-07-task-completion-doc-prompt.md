# Task-Completion Documentation Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Obsidian plugin that prompts the user to write a short documentation paragraph when a task is marked done; saves the paragraph as an indented sub-bullet under the task; supports per-task permanent skip and per-event defer.

**Architecture:** Companion plugin (no fork of `obsidian-tasks`). Detection is abstracted behind a `CompletionDetector` interface so the file-watch implementation can be swapped for a future Tasks-API hook. Orchestration owns policy (folder filter, skip state, queue); persistence and identity are pure functions wherever possible.

**Tech Stack:** TypeScript (strict), Obsidian Plugin API, esbuild, Jest + ts-jest. No Svelte. No external runtime deps.

**Source spec:** `docs/superpowers/specs/2026-05-07-task-completion-doc-prompt-design.md`

---

## File Structure (locked in)

```
.
├─ manifest.json                       Obsidian plugin manifest
├─ package.json                        Deps + scripts
├─ tsconfig.json                       TS config (strict)
├─ esbuild.config.mjs                  Bundler
├─ jest.config.js                      Test runner config
├─ .gitignore
├─ tests/
│   ├─ __mocks__/obsidian.ts           Hand-written Obsidian mock
│   ├─ identity/TaskIdentity.test.ts
│   ├─ persistence/SubBulletWriter.compose.test.ts
│   ├─ persistence/SkipStateStore.test.ts
│   ├─ persistence/FallbackLog.test.ts
│   ├─ detection/FileWatchDetector.diff.test.ts
│   ├─ orchestration/ModalQueue.test.ts
│   └─ orchestration/PromptOrchestrator.test.ts
└─ src/
    ├─ main.ts                         Plugin entry, lifecycle wiring
    ├─ detection/
    │   ├─ types.ts                    CompletionEvent
    │   ├─ CompletionDetector.ts       Interface
    │   └─ FileWatchDetector.ts        File-watch impl + pure diff()
    ├─ orchestration/
    │   ├─ PromptOrchestrator.ts       Receives events, applies policy
    │   └─ ModalQueue.ts               FIFO modal serializer
    ├─ ui/
    │   └─ DocumentationModal.ts       Modal: textarea + 3 buttons
    ├─ persistence/
    │   ├─ SubBulletWriter.ts          Writer + pure compose()
    │   ├─ FallbackLog.ts              Lost-text log
    │   └─ SkipStateStore.ts           Plugin data file persistence
    ├─ config/
    │   ├─ Settings.ts                 Settings interface + defaults
    │   └─ SettingsTab.ts              PluginSettingTab UI
    └─ identity/
        └─ TaskIdentity.ts             Stable hash for skip persistence
```

**Implementation order rationale:** Foundation (Tasks 1–2) → pure-logic modules with full tests (Tasks 3–7) → Obsidian-coupled modules (Tasks 8–13) → integration + lifecycle (Tasks 14–16). Pure-logic first means each later module is built on a tested base.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `manifest.json`
- Create: `esbuild.config.mjs`
- Create: `jest.config.js`
- Create: `.gitignore`
- Create: `tests/__mocks__/obsidian.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "obsidian-tasks-doc-prompt",
  "version": "0.1.0",
  "description": "Prompt for documentation when a task is completed in Obsidian.",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "jest",
    "test:watch": "jest --watch"
  },
  "keywords": ["obsidian", "tasks"],
  "author": "Leo Buron",
  "license": "MIT",
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.21.0",
    "jest": "^29.7.0",
    "obsidian": "^1.5.7",
    "ts-jest": "^29.1.2",
    "tslib": "^2.6.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2020",
    "allowJs": false,
    "noImplicitAny": true,
    "strict": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["DOM", "ES2020"],
    "types": ["node", "jest"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create `manifest.json`**

```json
{
  "id": "tasks-doc-prompt",
  "name": "Tasks Doc-Prompt",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "When a task is completed, prompt for a short documentation paragraph saved as an indented sub-bullet.",
  "author": "Leo Buron",
  "authorUrl": "",
  "isDesktopOnly": false
}
```

- [ ] **Step 4: Create `esbuild.config.mjs`**

```js
import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';

const prod = process.argv[2] === 'production';

const banner =
`/* esbuild bundle for tasks-doc-prompt */`;

const ctx = await esbuild.context({
    banner: { js: banner },
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        ...builtins,
    ],
    format: 'cjs',
    target: 'es2020',
    logLevel: 'info',
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js',
    minify: prod,
});

if (prod) {
    await ctx.rebuild();
    process.exit(0);
} else {
    await ctx.watch();
}
```

- [ ] **Step 5: Create `jest.config.js`**

```js
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/?(*.)+(test).ts'],
    moduleNameMapper: {
        '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
    },
};
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
main.js
*.js.map
.obsidian/
data.json
.DS_Store
```

- [ ] **Step 7: Create `tests/__mocks__/obsidian.ts`**

```ts
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
```

- [ ] **Step 8: Verify install + test infrastructure**

Run:
```bash
npm install
npx jest --listTests
```

Expected: install succeeds; `--listTests` prints nothing (no tests yet) without errors.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json manifest.json esbuild.config.mjs jest.config.js .gitignore tests/__mocks__/obsidian.ts
git commit -m "chore: scaffold Obsidian plugin project + jest mock"
```

---

## Task 2: Detection Types and Interface

**Files:**
- Create: `src/detection/types.ts`
- Create: `src/detection/CompletionDetector.ts`

These are type-only files; no runtime tests. Verification is via `tsc -noEmit`.

- [ ] **Step 1: Create `src/detection/types.ts`**

```ts
import type { TFile } from 'obsidian';

export type CompletionEvent = {
    file: TFile;
    lineNumber: number;       // 0-based
    taskLine: string;         // full markdown line, post-toggle (with [x])
    previousStatus: string;   // e.g. " "
    newStatus: string;        // e.g. "x"
    blockId?: string;         // present iff task line contains ^xyz
};
```

- [ ] **Step 2: Create `src/detection/CompletionDetector.ts`**

```ts
import type { CompletionEvent } from './types';

export type CompletionHandler = (event: CompletionEvent) => Promise<void>;

export interface CompletionDetector {
    onCompletion(handler: CompletionHandler): void;
    start(): void;
    stop(): void;
}
```

- [ ] **Step 3: Verify with tsc**

Run:
```bash
npx tsc -noEmit
```

Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/detection/types.ts src/detection/CompletionDetector.ts
git commit -m "feat(detection): add CompletionEvent type and CompletionDetector interface"
```

---

## Task 3: TaskIdentity (pure)

`TaskIdentity.computeId` is a pure function: given a `CompletionEvent`, return a stable string ID. Block-ID wins; otherwise hash of the stripped description, namespaced by file path. The stripping must be exhaustive for Tasks emoji fields and Dataview-style inline metadata.

**Files:**
- Create: `tests/identity/TaskIdentity.test.ts`
- Create: `src/identity/TaskIdentity.ts`

- [ ] **Step 1: Write failing tests for `stripTasksFields`**

Create `tests/identity/TaskIdentity.test.ts`:

```ts
import { TFile } from 'obsidian';
import { computeId, stripTasksFields } from '../../src/identity/TaskIdentity';
import type { CompletionEvent } from '../../src/detection/types';

function ev(taskLine: string, opts: Partial<CompletionEvent> = {}): CompletionEvent {
    return {
        file: opts.file ?? new TFile('Notes/test.md'),
        lineNumber: opts.lineNumber ?? 0,
        taskLine,
        previousStatus: opts.previousStatus ?? ' ',
        newStatus: opts.newStatus ?? 'x',
        blockId: opts.blockId,
    };
}

describe('stripTasksFields', () => {
    test('removes status marker and surrounding whitespace', () => {
        expect(stripTasksFields('  - [x] write the report')).toBe('write the report');
    });

    test('removes Tasks emoji metadata fields', () => {
        const line = '- [x] write the report 📅 2026-05-10 ⏳ 2026-05-08 🔼';
        expect(stripTasksFields(line)).toBe('write the report');
    });

    test('removes Dataview-style inline fields', () => {
        const line = '- [x] write the report [due:: 2026-05-10] [priority:: high]';
        expect(stripTasksFields(line)).toBe('write the report');
    });

    test('removes done-date emoji on completed tasks', () => {
        expect(stripTasksFields('- [x] done thing ✅ 2026-05-07')).toBe('done thing');
    });

    test('removes recurrence rule', () => {
        expect(stripTasksFields('- [x] daily standup 🔁 every day')).toBe('daily standup');
    });

    test('removes block-ID at end', () => {
        expect(stripTasksFields('- [x] write report ^abc123')).toBe('write report');
    });
});

describe('computeId', () => {
    test('uses block-ID when present', () => {
        const e = ev('- [x] anything ^xyz', { blockId: 'xyz' });
        expect(computeId(e)).toBe('block:xyz');
    });

    test('block-ID wins even when description differs', () => {
        const a = ev('- [x] write report ^xyz', { blockId: 'xyz' });
        const b = ev('- [x] totally different text ^xyz', { blockId: 'xyz' });
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id is stable across status change', () => {
        const a = ev('- [ ] write report');
        const b = ev('- [x] write report');
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id is stable across date metadata change', () => {
        const a = ev('- [x] write report 📅 2026-05-10');
        const b = ev('- [x] write report 📅 2026-05-11 ✅ 2026-05-10');
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id is stable across priority change', () => {
        const a = ev('- [x] write report 🔼');
        const b = ev('- [x] write report 🔺');
        expect(computeId(a)).toBe(computeId(b));
    });

    test('id changes when description is reworded', () => {
        const a = ev('- [x] write report');
        const b = ev('- [x] write the final report');
        expect(computeId(a)).not.toBe(computeId(b));
    });

    test('id includes file path so same description in different files differs', () => {
        const a = ev('- [x] write report', { file: new TFile('A/note.md') });
        const b = ev('- [x] write report', { file: new TFile('B/note.md') });
        expect(computeId(a)).not.toBe(computeId(b));
    });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run:
```bash
npx jest tests/identity/TaskIdentity.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/identity/TaskIdentity.ts`**

```ts
import { createHash } from 'crypto';
import type { CompletionEvent } from '../detection/types';

const TASKS_EMOJIS = ['📅', '⏳', '🛫', '➕', '✅', '🔁', '🆔', '⛔', '🏁', '🔼', '🔽', '⏫', '🔺', '⏬', '📝'];

const EMOJI_RE = new RegExp(
    `(?:${TASKS_EMOJIS.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\S*(?:\\s+(?!\\[|${TASKS_EMOJIS.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\S+)*`,
    'gu',
);

const DV_FIELD_RE = /\[[a-zA-Z][\w-]*::[^\]]*\]/g;
const STATUS_RE = /^\s*[-*+]\s*\[[^\]]\]\s*/;
const BLOCK_ID_RE = /\s*\^[A-Za-z0-9-]+\s*$/;

export function stripTasksFields(taskLine: string): string {
    let s = taskLine;
    s = s.replace(STATUS_RE, '');
    s = s.replace(BLOCK_ID_RE, '');
    s = s.replace(DV_FIELD_RE, '');
    s = s.replace(EMOJI_RE, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

export function computeId(event: CompletionEvent): string {
    if (event.blockId) {
        return `block:${event.blockId}`;
    }
    const desc = stripTasksFields(event.taskLine);
    const hash = createHash('sha1').update(desc).digest('hex').slice(0, 16);
    return `path:${event.file.path}::${hash}`;
}
```

- [ ] **Step 4: Run tests; iterate on regex if any fail**

Run:
```bash
npx jest tests/identity/TaskIdentity.test.ts
```

Expected: PASS for all cases. If a Tasks-emoji case fails, the most likely cause is the value-capture regex eating a following date; tighten the value capture to `\S+` and a single-token lookahead.

- [ ] **Step 5: Commit**

```bash
git add tests/identity/TaskIdentity.test.ts src/identity/TaskIdentity.ts
git commit -m "feat(identity): TaskIdentity with stable ID across status/date/priority changes"
```

---

## Task 4: Settings + Defaults

**Files:**
- Create: `src/config/Settings.ts`

This is type + constants; verified by tsc.

- [ ] **Step 1: Create `src/config/Settings.ts`**

```ts
export interface DocPromptSettings {
    schemaVersion: 1;

    // Trigger
    doneStatusSymbols: string[];
    enabledFolders: string[];

    // Defer
    defaultDeferDurationMinutes: number;
    autoRepromptOnStart: boolean;

    // Writer
    fallbackLogPath: string;

    // Future-proofing for migration to TasksApiDetector
    enforcedMode: boolean;
}

export const DEFAULT_SETTINGS: DocPromptSettings = {
    schemaVersion: 1,
    doneStatusSymbols: ['x', 'X'],
    enabledFolders: [],
    defaultDeferDurationMinutes: 240,
    autoRepromptOnStart: true,
    fallbackLogPath: 'Tasks Doc-Prompt — Lost.md',
    enforcedMode: false,
};

export function mergeWithDefaults(loaded: unknown): DocPromptSettings {
    if (!loaded || typeof loaded !== 'object') return { ...DEFAULT_SETTINGS };
    const obj = loaded as Record<string, unknown>;
    if (obj.schemaVersion !== 1) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(obj as Partial<DocPromptSettings>) };
}
```

- [ ] **Step 2: Verify with tsc**

Run:
```bash
npx tsc -noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/config/Settings.ts
git commit -m "feat(config): Settings interface + defaults + version-safe merge"
```

---

## Task 5: SubBulletWriter compose (pure)

The pure `compose` function takes existing file lines and produces new lines with the documentation sub-bullet inserted under the task. Splitting out the pure part keeps the writer testable without a real vault.

**Files:**
- Create: `tests/persistence/SubBulletWriter.compose.test.ts`
- Create: `src/persistence/SubBulletWriter.ts` (compose function only; class added in Task 11)

- [ ] **Step 1: Write failing tests**

Create `tests/persistence/SubBulletWriter.compose.test.ts`:

```ts
import { composeSubBullet } from '../../src/persistence/SubBulletWriter';

describe('composeSubBullet', () => {
    test('inserts indented sub-bullet under top-level task using spaces', () => {
        const lines = [
            '# Notes',
            '- [x] write report',
            '- [ ] another task',
        ];
        const out = composeSubBullet(lines, 1, 'Drafted v1, sent for review.', { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '# Notes',
            '- [x] write report',
            '    - Drafted v1, sent for review.',
            '- [ ] another task',
        ]);
    });

    test('inserts indented sub-bullet using tab indentation', () => {
        const lines = ['- [x] write report'];
        const out = composeSubBullet(lines, 0, 'Drafted v1.', { indentWithTabs: true, tabSize: 4 });
        expect(out).toEqual([
            '- [x] write report',
            '\t- Drafted v1.',
        ]);
    });

    test('preserves existing indentation of nested task and indents one further step', () => {
        const lines = [
            '- [ ] parent',
            '    - [x] nested task',
        ];
        const out = composeSubBullet(lines, 1, 'Did the thing.', { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '- [ ] parent',
            '    - [x] nested task',
            '        - Did the thing.',
        ]);
    });

    test('preserves tab-indented nested task and adds one more tab', () => {
        const lines = [
            '- [ ] parent',
            '\t- [x] nested',
        ];
        const out = composeSubBullet(lines, 1, 'Done.', { indentWithTabs: true, tabSize: 4 });
        expect(out).toEqual([
            '- [ ] parent',
            '\t- [x] nested',
            '\t\t- Done.',
        ]);
    });

    test('multi-line user text gets first line as bullet, continuation lines indented further', () => {
        const lines = ['- [x] write report'];
        const text = 'First line.\nSecond line.\nThird line.';
        const out = composeSubBullet(lines, 0, text, { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '- [x] write report',
            '    - First line.',
            '      Second line.',
            '      Third line.',
        ]);
    });

    test('trims trailing whitespace and ignores trailing blank lines in user text', () => {
        const out = composeSubBullet(['- [x] t'], 0, 'one\n\n', { indentWithTabs: false, tabSize: 4 });
        expect(out).toEqual([
            '- [x] t',
            '    - one',
        ]);
    });

    test('throws if lineIndex is out of range', () => {
        expect(() => composeSubBullet(['- [x] t'], 5, 'x', { indentWithTabs: false, tabSize: 4 }))
            .toThrow();
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

Run:
```bash
npx jest tests/persistence/SubBulletWriter.compose.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/persistence/SubBulletWriter.ts`**

```ts
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
```

- [ ] **Step 4: Run tests; confirm pass**

Run:
```bash
npx jest tests/persistence/SubBulletWriter.compose.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/persistence/SubBulletWriter.compose.test.ts src/persistence/SubBulletWriter.ts
git commit -m "feat(persistence): pure composeSubBullet for tab/space, top-level/nested, multi-line"
```

---

## Task 6: FileWatchDetector pure diff

`diffSnapshot` takes `(oldSnapshots, newLines, doneSymbols)` and returns events for lines whose status changed *to* a DONE symbol. Pure function — no Obsidian dependency.

**Files:**
- Create: `tests/detection/FileWatchDetector.diff.test.ts`
- Create: `src/detection/FileWatchDetector.ts` (initially: types + diff function only; class added in Task 9)

- [ ] **Step 1: Write failing tests**

Create `tests/detection/FileWatchDetector.diff.test.ts`:

```ts
import { diffSnapshot, snapshotLines, type TaskLineSnapshot } from '../../src/detection/FileWatchDetector';

describe('snapshotLines', () => {
    test('extracts only task lines and records line number, status, hash', () => {
        const lines = [
            '# Heading',
            '- [ ] todo one',
            'plain text',
            '- [x] done one ^abc',
        ];
        const snaps = snapshotLines(lines);
        expect(snaps.map(s => ({ line: s.lineNumber, status: s.statusSymbol })))
            .toEqual([
                { line: 1, status: ' ' },
                { line: 3, status: 'x' },
            ]);
        expect(snaps[1].blockId).toBe('abc');
    });

    test('descriptionHash is stable across status change', () => {
        const a = snapshotLines(['- [ ] same text']);
        const b = snapshotLines(['- [x] same text']);
        expect(a[0].descriptionHash).toBe(b[0].descriptionHash);
    });
});

describe('diffSnapshot', () => {
    const doneSymbols = ['x', 'X'];

    test('emits event when status flips from open to done', () => {
        const oldSnaps: TaskLineSnapshot[] = snapshotLines(['- [ ] write report']);
        const newLines = ['- [x] write report'];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events).toHaveLength(1);
        expect(events[0].previousStatus).toBe(' ');
        expect(events[0].newStatus).toBe('x');
        expect(events[0].lineNumber).toBe(0);
        expect(events[0].taskLine).toBe('- [x] write report');
    });

    test('does not emit when status is already done and stays done', () => {
        const oldSnaps = snapshotLines(['- [x] write report']);
        const newLines = ['- [x] write report'];
        expect(diffSnapshot(oldSnaps, newLines, doneSymbols)).toEqual([]);
    });

    test('does not emit when toggling from done back to open', () => {
        const oldSnaps = snapshotLines(['- [x] write report']);
        const newLines = ['- [ ] write report'];
        expect(diffSnapshot(oldSnaps, newLines, doneSymbols)).toEqual([]);
    });

    test('ignores transitions between non-done symbols (e.g. " " → "/")', () => {
        const oldSnaps = snapshotLines(['- [ ] task']);
        const newLines = ['- [/] task'];
        expect(diffSnapshot(oldSnaps, newLines, doneSymbols)).toEqual([]);
    });

    test('matches by description hash so a recurrence-inserted new line does not produce phantom events', () => {
        // Recurrence: original line is now [x]; a new [ ] line is inserted above it.
        const oldSnaps = snapshotLines(['- [ ] daily standup 🔁 every day']);
        const newLines = [
            '- [ ] daily standup 🔁 every day',
            '- [x] daily standup 🔁 every day ✅ 2026-05-07',
        ];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events).toHaveLength(1);
        expect(events[0].newStatus).toBe('x');
        expect(events[0].lineNumber).toBe(1);
    });

    test('multiple completions in one diff produce one event each', () => {
        const oldSnaps = snapshotLines([
            '- [ ] a',
            '- [ ] b',
            '- [ ] c',
        ]);
        const newLines = [
            '- [x] a',
            '- [ ] b',
            '- [x] c',
        ];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events.map(e => e.lineNumber)).toEqual([0, 2]);
    });

    test('extracts blockId when present on completed line', () => {
        const oldSnaps = snapshotLines(['- [ ] task ^xyz']);
        const newLines = ['- [x] task ^xyz'];
        const events = diffSnapshot(oldSnaps, newLines, doneSymbols);
        expect(events[0].blockId).toBe('xyz');
    });

    test('treats configurable extra done symbols as done', () => {
        const oldSnaps = snapshotLines(['- [ ] task']);
        const newLines = ['- [D] task'];
        expect(diffSnapshot(oldSnaps, newLines, ['D'])).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

Run:
```bash
npx jest tests/detection/FileWatchDetector.diff.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement pure helpers in `src/detection/FileWatchDetector.ts`**

```ts
import { createHash } from 'crypto';
import type { CompletionEvent } from './types';

export interface TaskLineSnapshot {
    lineNumber: number;
    statusSymbol: string;
    descriptionHash: string;
    blockId?: string;
}

const TASK_LINE_RE = /^(\s*)[-*+]\s*\[([^\]])\]\s*(.*)$/;
const BLOCK_ID_RE = /\s*\^([A-Za-z0-9-]+)\s*$/;

function descriptionHash(rawAfterBracket: string): string {
    // Hash the description text only; strip block-id and trailing whitespace.
    const noBlock = rawAfterBracket.replace(BLOCK_ID_RE, '').trim();
    return createHash('sha1').update(noBlock).digest('hex').slice(0, 16);
}

function extractBlockId(rawAfterBracket: string): string | undefined {
    const m = rawAfterBracket.match(BLOCK_ID_RE);
    return m ? m[1] : undefined;
}

export function snapshotLines(lines: string[]): TaskLineSnapshot[] {
    const out: TaskLineSnapshot[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_LINE_RE);
        if (!m) continue;
        out.push({
            lineNumber: i,
            statusSymbol: m[2],
            descriptionHash: descriptionHash(m[3]),
            blockId: extractBlockId(m[3]),
        });
    }
    return out;
}

export type DiffEvent = Omit<CompletionEvent, 'file'>;

export function diffSnapshot(
    oldSnaps: TaskLineSnapshot[],
    newLines: string[],
    doneSymbols: string[],
): DiffEvent[] {
    const newSnaps = snapshotLines(newLines);
    const newByHash = new Map<string, TaskLineSnapshot>();
    for (const s of newSnaps) {
        // First-write wins to avoid double-counting duplicate descriptions; that
        // is acceptable for MVP and produces deterministic output.
        if (!newByHash.has(s.descriptionHash)) newByHash.set(s.descriptionHash, s);
    }

    const events: DiffEvent[] = [];
    for (const oldSnap of oldSnaps) {
        const matched = newByHash.get(oldSnap.descriptionHash);
        if (!matched) continue;
        const wasDone = doneSymbols.includes(oldSnap.statusSymbol);
        const isDone = doneSymbols.includes(matched.statusSymbol);
        if (!wasDone && isDone) {
            events.push({
                lineNumber: matched.lineNumber,
                taskLine: newLines[matched.lineNumber],
                previousStatus: oldSnap.statusSymbol,
                newStatus: matched.statusSymbol,
                blockId: matched.blockId,
            });
        }
    }
    // Sort by line number for deterministic ordering.
    events.sort((a, b) => a.lineNumber - b.lineNumber);
    return events;
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run:
```bash
npx jest tests/detection/FileWatchDetector.diff.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/detection/FileWatchDetector.diff.test.ts src/detection/FileWatchDetector.ts
git commit -m "feat(detection): pure diffSnapshot for done-transition events"
```

---

## Task 7: ModalQueue (FIFO + serialization)

A simple FIFO queue. `enqueue(item)` adds to the queue; the queue calls a worker to process one item at a time. The queue is parameterized by the worker function so it can be tested without modals.

**Files:**
- Create: `tests/orchestration/ModalQueue.test.ts`
- Create: `src/orchestration/ModalQueue.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/orchestration/ModalQueue.test.ts`:

```ts
import { ModalQueue } from '../../src/orchestration/ModalQueue';

describe('ModalQueue', () => {
    test('processes a single item by invoking the worker', async () => {
        const seen: string[] = [];
        const queue = new ModalQueue<string>(async (s) => { seen.push(s); });
        queue.enqueue('a');
        await queue.drainForTest();
        expect(seen).toEqual(['a']);
    });

    test('serializes overlapping enqueues — second waits for first', async () => {
        const seen: string[] = [];
        let resolveFirst!: () => void;
        const firstStarted = new Promise<void>((r) => { resolveFirst = r; });
        const queue = new ModalQueue<string>(async (s) => {
            seen.push(`start:${s}`);
            if (s === 'a') await new Promise<void>((res) => {
                // Hold "a" until released.
                (resolveFirst as any).release = res;
            });
            seen.push(`end:${s}`);
        });
        queue.enqueue('a');
        queue.enqueue('b');
        // Let microtasks run so 'a' enters its body.
        await new Promise(setImmediate);
        expect(seen).toEqual(['start:a']);
        // Release 'a'; 'b' must run only after 'a' completes.
        (resolveFirst as any).release();
        await queue.drainForTest();
        expect(seen).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });

    test('worker errors do not stop the queue', async () => {
        const seen: string[] = [];
        const queue = new ModalQueue<string>(async (s) => {
            if (s === 'a') throw new Error('boom');
            seen.push(s);
        });
        queue.enqueue('a');
        queue.enqueue('b');
        await queue.drainForTest();
        expect(seen).toEqual(['b']);
    });

    test('size reflects queued items not yet processed', () => {
        const queue = new ModalQueue<string>(async () => {
            await new Promise(() => {}); // never resolves
        });
        queue.enqueue('a');
        queue.enqueue('b');
        queue.enqueue('c');
        // 'a' is in-flight; 'b' and 'c' are waiting.
        expect(queue.queuedSize()).toBe(2);
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

Run:
```bash
npx jest tests/orchestration/ModalQueue.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/orchestration/ModalQueue.ts`**

```ts
export type ModalWorker<T> = (item: T) => Promise<void>;

export class ModalQueue<T> {
    private items: T[] = [];
    private running = false;
    private idleResolvers: Array<() => void> = [];

    constructor(private worker: ModalWorker<T>) {}

    enqueue(item: T): void {
        this.items.push(item);
        void this.pump();
    }

    queuedSize(): number {
        return this.items.length;
    }

    /** Resolves when the queue is fully idle (no in-flight item, none queued). */
    drainForTest(): Promise<void> {
        if (!this.running && this.items.length === 0) return Promise.resolve();
        return new Promise((resolve) => this.idleResolvers.push(resolve));
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.items.length > 0) {
                const next = this.items.shift()!;
                try {
                    await this.worker(next);
                } catch (err) {
                    console.error('[ModalQueue] worker error:', err);
                }
            }
        } finally {
            this.running = false;
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const r of resolvers) r();
        }
    }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run:
```bash
npx jest tests/orchestration/ModalQueue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/orchestration/ModalQueue.test.ts src/orchestration/ModalQueue.ts
git commit -m "feat(orchestration): ModalQueue with FIFO serialization and error isolation"
```

---

## Task 8: SkipStateStore

Manages deferred + permanent skip records. Persisted via the plugin's `loadData/saveData` (pluggable for tests). Disk writes are debounced 500 ms.

**Files:**
- Create: `tests/persistence/SkipStateStore.test.ts`
- Create: `src/persistence/SkipStateStore.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/persistence/SkipStateStore.test.ts`:

```ts
import { SkipStateStore, type Persistence } from '../../src/persistence/SkipStateStore';

class MemoryPersistence implements Persistence {
    public stored: any = null;
    async load() { return this.stored; }
    async save(data: any) { this.stored = data; }
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('SkipStateStore', () => {
    test('starts empty when persistence has nothing', async () => {
        const p = new MemoryPersistence();
        const store = await SkipStateStore.load(p);
        expect(store.isPermanentlySkipped('any')).toBe(false);
        expect(store.getDeferred()).toEqual([]);
    });

    test('markPermanent persists after debounce', async () => {
        const p = new MemoryPersistence();
        const store = await SkipStateStore.load(p);
        store.markPermanent('id-1', { label: 'write report', filePath: 'A.md' });
        expect(store.isPermanentlySkipped('id-1')).toBe(true);
        expect(p.stored).toBeNull();
        jest.advanceTimersByTime(500);
        await Promise.resolve(); // let pending save resolve
        expect(p.stored.permanent['id-1'].taskId).toBe('id-1');
    });

    test('removePermanent reverses markPermanent', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markPermanent('id-1', { label: 'x', filePath: 'A.md' });
        store.removePermanent('id-1');
        expect(store.isPermanentlySkipped('id-1')).toBe(false);
    });

    test('markDeferred stores entry with remindAt', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('id-2', {
            filePath: 'A.md', lineNumber: 3, taskLine: '- [x] t',
        }, 1_000_000);
        const deferred = store.getDeferred();
        expect(deferred).toHaveLength(1);
        expect(deferred[0].taskId).toBe('id-2');
        expect(deferred[0].remindAt).toBe(1_000_000);
    });

    test('takeDueDeferred returns and removes entries with remindAt <= now', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('id-due', { filePath: 'A.md', lineNumber: 1, taskLine: 't1' }, 100);
        store.markDeferred('id-future', { filePath: 'A.md', lineNumber: 2, taskLine: 't2' }, 10_000);
        const due = store.takeDueDeferred(500);
        expect(due.map(d => d.taskId)).toEqual(['id-due']);
        expect(store.getDeferred().map(d => d.taskId)).toEqual(['id-future']);
    });

    test('takeAllDeferred returns and removes all', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('a', { filePath: 'A.md', lineNumber: 1, taskLine: 't' }, 10_000);
        store.markDeferred('b', { filePath: 'A.md', lineNumber: 2, taskLine: 't' }, 20_000);
        const all = store.takeAllDeferred();
        expect(all.map(d => d.taskId).sort()).toEqual(['a', 'b']);
        expect(store.getDeferred()).toEqual([]);
    });

    test('removeDeferred removes by id without firing event', async () => {
        const store = await SkipStateStore.load(new MemoryPersistence());
        store.markDeferred('a', { filePath: 'A.md', lineNumber: 1, taskLine: 't' }, 1);
        store.removeDeferred('a');
        expect(store.getDeferred()).toEqual([]);
    });

    test('roundtrips through persistence', async () => {
        const p = new MemoryPersistence();
        const a = await SkipStateStore.load(p);
        a.markPermanent('id-1', { label: 'l', filePath: 'A.md' });
        a.markDeferred('id-2', { filePath: 'B.md', lineNumber: 7, taskLine: 't' }, 1234);
        jest.advanceTimersByTime(500);
        await Promise.resolve();

        const b = await SkipStateStore.load(p);
        expect(b.isPermanentlySkipped('id-1')).toBe(true);
        expect(b.getDeferred()).toHaveLength(1);
        expect(b.getDeferred()[0].remindAt).toBe(1234);
    });

    test('rejects mismatched schemaVersion and falls back to empty', async () => {
        const p = new MemoryPersistence();
        p.stored = { schemaVersion: 999, permanent: { x: {} }, deferred: {} };
        const store = await SkipStateStore.load(p);
        expect(store.isPermanentlySkipped('x')).toBe(false);
        expect(store.getDeferred()).toEqual([]);
    });

    test('debounces multiple rapid mutations into one save', async () => {
        const p = new MemoryPersistence();
        let saveCount = 0;
        const orig = p.save.bind(p);
        p.save = async (d) => { saveCount++; return orig(d); };
        const store = await SkipStateStore.load(p);
        store.markPermanent('a', { label: 'a', filePath: 'A.md' });
        store.markPermanent('b', { label: 'b', filePath: 'B.md' });
        store.markPermanent('c', { label: 'c', filePath: 'C.md' });
        jest.advanceTimersByTime(500);
        await Promise.resolve();
        expect(saveCount).toBe(1);
        expect(Object.keys(p.stored.permanent).sort()).toEqual(['a', 'b', 'c']);
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

Run:
```bash
npx jest tests/persistence/SkipStateStore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/persistence/SkipStateStore.ts`**

```ts
const CURRENT_SCHEMA = 1 as const;

export interface DeferredEntry {
    taskId: string;
    snapshot: { filePath: string; lineNumber: number; taskLine: string };
    deferredAt: number;
    remindAt: number;
}

export interface PermanentEntry {
    taskId: string;
    skippedAt: number;
    label: string;
    filePath: string;
}

interface SkipState {
    schemaVersion: typeof CURRENT_SCHEMA;
    deferred: Record<string, DeferredEntry>;
    permanent: Record<string, PermanentEntry>;
}

function emptyState(): SkipState {
    return { schemaVersion: CURRENT_SCHEMA, deferred: {}, permanent: {} };
}

export interface Persistence {
    load(): Promise<unknown>;
    save(data: unknown): Promise<void>;
}

const SAVE_DEBOUNCE_MS = 500;

export class SkipStateStore {
    private state: SkipState;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(private persistence: Persistence, state: SkipState) {
        this.state = state;
    }

    static async load(persistence: Persistence): Promise<SkipStateStore> {
        let raw: unknown = null;
        try {
            raw = await persistence.load();
        } catch {
            raw = null;
        }
        const state = SkipStateStore.parseOrEmpty(raw);
        return new SkipStateStore(persistence, state);
    }

    private static parseOrEmpty(raw: unknown): SkipState {
        if (!raw || typeof raw !== 'object') return emptyState();
        const obj = raw as Partial<SkipState>;
        if (obj.schemaVersion !== CURRENT_SCHEMA) return emptyState();
        return {
            schemaVersion: CURRENT_SCHEMA,
            deferred: { ...(obj.deferred ?? {}) },
            permanent: { ...(obj.permanent ?? {}) },
        };
    }

    isPermanentlySkipped(taskId: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.state.permanent, taskId);
    }

    markPermanent(taskId: string, info: { label: string; filePath: string }): void {
        this.state.permanent[taskId] = {
            taskId,
            skippedAt: Date.now(),
            label: info.label,
            filePath: info.filePath,
        };
        this.scheduleSave();
    }

    removePermanent(taskId: string): void {
        delete this.state.permanent[taskId];
        this.scheduleSave();
    }

    listPermanent(): PermanentEntry[] {
        return Object.values(this.state.permanent);
    }

    markDeferred(
        taskId: string,
        snapshot: DeferredEntry['snapshot'],
        remindAt: number,
    ): void {
        this.state.deferred[taskId] = {
            taskId,
            snapshot,
            deferredAt: Date.now(),
            remindAt,
        };
        this.scheduleSave();
    }

    removeDeferred(taskId: string): void {
        delete this.state.deferred[taskId];
        this.scheduleSave();
    }

    getDeferred(): DeferredEntry[] {
        return Object.values(this.state.deferred);
    }

    takeDueDeferred(now: number): DeferredEntry[] {
        const due: DeferredEntry[] = [];
        for (const [id, entry] of Object.entries(this.state.deferred)) {
            if (entry.remindAt <= now) {
                due.push(entry);
                delete this.state.deferred[id];
            }
        }
        if (due.length > 0) this.scheduleSave();
        return due;
    }

    takeAllDeferred(): DeferredEntry[] {
        const all = Object.values(this.state.deferred);
        this.state.deferred = {};
        if (all.length > 0) this.scheduleSave();
        return all;
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.persistence.save(this.state);
        }, SAVE_DEBOUNCE_MS);
    }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run:
```bash
npx jest tests/persistence/SkipStateStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/persistence/SkipStateStore.test.ts src/persistence/SkipStateStore.ts
git commit -m "feat(persistence): SkipStateStore with debounced save and schema-version safety"
```

---

## Task 9: FileWatchDetector class (Obsidian-coupled)

Wires the pure `diffSnapshot` to the Obsidian vault: builds the initial snapshot cache, listens for `modify`/`rename`/`delete`, and emits `CompletionEvent`s.

**Files:**
- Modify: `src/detection/FileWatchDetector.ts`

(No unit test for the class — it's a thin wiring layer; integration coverage in Task 16.)

- [ ] **Step 1: Append the class to `src/detection/FileWatchDetector.ts`**

Add at the bottom of the existing file:

```ts
import type { App, EventRef, TFile } from 'obsidian';
import type { CompletionDetector, CompletionHandler } from './CompletionDetector';
import type { DocPromptSettings } from '../config/Settings';

export class FileWatchDetector implements CompletionDetector {
    private cache = new Map<string, TaskLineSnapshot[]>();
    private handler: CompletionHandler | null = null;
    private modifyRef: EventRef | null = null;
    private renameRef: EventRef | null = null;
    private deleteRef: EventRef | null = null;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private app: App, private settings: DocPromptSettings) {}

    onCompletion(handler: CompletionHandler): void {
        this.handler = handler;
    }

    start(): void {
        // Async warm-up: build cache without blocking onload().
        void this.warmCache();
        this.modifyRef = this.app.vault.on('modify', (file: any) => {
            if (!(file && file.extension === 'md')) return;
            this.scheduleDiff(file as TFile);
        });
        this.renameRef = this.app.vault.on('rename', (file: any, oldPath: string) => {
            if (this.cache.has(oldPath)) {
                const snaps = this.cache.get(oldPath)!;
                this.cache.delete(oldPath);
                this.cache.set(file.path, snaps);
            }
        });
        this.deleteRef = this.app.vault.on('delete', (file: any) => {
            this.cache.delete(file.path);
        });
    }

    stop(): void {
        for (const t of this.debounceTimers.values()) clearTimeout(t);
        this.debounceTimers.clear();
        const off = (ref: EventRef | null) => {
            if (!ref) return;
            (this.app.vault as any).offref?.(ref);
        };
        off(this.modifyRef); this.modifyRef = null;
        off(this.renameRef); this.renameRef = null;
        off(this.deleteRef); this.deleteRef = null;
    }

    private async warmCache(): Promise<void> {
        try {
            for (const file of this.app.vault.getMarkdownFiles()) {
                const content = await this.app.vault.read(file);
                this.cache.set(file.path, snapshotLines(content.split('\n')));
            }
        } catch (err) {
            console.error('[FileWatchDetector] warmCache failed:', err);
        }
    }

    private scheduleDiff(file: TFile): void {
        const existing = this.debounceTimers.get(file.path);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            this.debounceTimers.delete(file.path);
            void this.runDiff(file);
        }, 250);
        this.debounceTimers.set(file.path, t);
    }

    private async runDiff(file: TFile): Promise<void> {
        if (!this.handler) return;
        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const oldSnaps = this.cache.get(file.path) ?? [];
            const events = diffSnapshot(oldSnaps, lines, this.settings.doneStatusSymbols);
            this.cache.set(file.path, snapshotLines(lines));
            for (const ev of events) {
                await this.handler({ ...ev, file });
            }
        } catch (err) {
            console.error('[FileWatchDetector] runDiff failed:', err);
        }
    }
}
```

- [ ] **Step 2: Verify with tsc + run all tests**

Run:
```bash
npx tsc -noEmit
npx jest
```

Expected: tsc passes; all existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/detection/FileWatchDetector.ts
git commit -m "feat(detection): FileWatchDetector class wires diff to vault.modify/rename/delete"
```

---

## Task 10: FallbackLog

Appends a single entry per failed save to a configured file at the vault root. Creates the file on first append.

**Files:**
- Create: `tests/persistence/FallbackLog.test.ts`
- Create: `src/persistence/FallbackLog.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/persistence/FallbackLog.test.ts`:

```ts
import { TFile } from 'obsidian';
import { FallbackLog, formatLogEntry } from '../../src/persistence/FallbackLog';

describe('formatLogEntry', () => {
    test('renders the expected markdown block', () => {
        const out = formatLogEntry({
            timestamp: new Date('2026-05-07T14:23:00Z'),
            taskLine: '- [x] write report',
            userText: 'Drafted v1.\nSent for review.',
            filePath: 'Notes/work.md',
            lineNumber: 12,
            reason: 'line-not-found',
        });
        expect(out).toContain('## 2026-05-07');
        expect(out).toContain('— write report');
        expect(out).toContain('Drafted v1.\nSent for review.');
        expect(out).toContain('[Original location: Notes/work.md:12]');
        expect(out).toContain('---');
    });
});

describe('FallbackLog', () => {
    function makeFakeVault() {
        const files = new Map<string, string>();
        return {
            files,
            getAbstractFileByPath(path: string) {
                return files.has(path) ? new TFile(path) : null;
            },
            async create(path: string, data: string) {
                files.set(path, data);
                return new TFile(path);
            },
            async append(file: TFile, data: string) {
                const cur = files.get(file.path) ?? '';
                files.set(file.path, cur + data);
            },
        };
    }

    test('creates the log file on first append', async () => {
        const vault = makeFakeVault();
        const log = new FallbackLog({ vault } as any, 'Lost.md');
        await log.append({
            timestamp: new Date('2026-05-07T14:23:00Z'),
            taskLine: '- [x] task',
            userText: 'text',
            filePath: 'a.md',
            lineNumber: 0,
            reason: 'r',
        });
        expect(vault.files.has('Lost.md')).toBe(true);
        expect(vault.files.get('Lost.md')).toContain('— task');
    });

    test('appends to existing log', async () => {
        const vault = makeFakeVault();
        vault.files.set('Lost.md', 'preexisting\n');
        const log = new FallbackLog({ vault } as any, 'Lost.md');
        await log.append({
            timestamp: new Date('2026-05-07T14:23:00Z'),
            taskLine: '- [x] task',
            userText: 'second',
            filePath: 'a.md',
            lineNumber: 0,
            reason: 'r',
        });
        const content = vault.files.get('Lost.md')!;
        expect(content.startsWith('preexisting')).toBe(true);
        expect(content).toContain('second');
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

Run:
```bash
npx jest tests/persistence/FallbackLog.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/persistence/FallbackLog.ts`**

```ts
import type { App, TFile } from 'obsidian';

export interface FallbackEntry {
    timestamp: Date;
    taskLine: string;
    userText: string;
    filePath: string;
    lineNumber: number;
    reason: string;
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function fmtDateTime(d: Date): string {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
        `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function shortTaskText(taskLine: string): string {
    // Strip the leading "- [x] " marker for the heading.
    return taskLine.replace(/^\s*[-*+]\s*\[[^\]]\]\s*/, '').trim();
}

export function formatLogEntry(e: FallbackEntry): string {
    const heading = `## ${fmtDateTime(e.timestamp)} — ${shortTaskText(e.taskLine)}`;
    return [
        heading,
        '',
        e.userText,
        '',
        `[Original location: ${e.filePath}:${e.lineNumber}]`,
        '',
        '---',
        '',
    ].join('\n');
}

export class FallbackLog {
    constructor(private app: App, private path: string) {}

    async append(entry: FallbackEntry): Promise<void> {
        const text = formatLogEntry(entry);
        const existing = this.app.vault.getAbstractFileByPath(this.path) as TFile | null;
        if (!existing) {
            await this.app.vault.create(this.path, text);
        } else {
            await this.app.vault.append(existing, text);
        }
    }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run:
```bash
npx jest tests/persistence/FallbackLog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/persistence/FallbackLog.test.ts src/persistence/FallbackLog.ts
git commit -m "feat(persistence): FallbackLog appends lost text to a single vault file"
```

---

## Task 11: SubBulletWriter class (vault-aware)

Adds the `write` method that locates the target line and uses `vault.process` to insert. On mismatch, falls back to scanning by description fragment; on still-no-match, hands off to FallbackLog.

**Files:**
- Modify: `src/persistence/SubBulletWriter.ts`

- [ ] **Step 1: Append the class to `src/persistence/SubBulletWriter.ts`**

```ts
import type { App, TFile } from 'obsidian';
import type { CompletionEvent } from '../detection/types';
import type { FallbackLog } from './FallbackLog';
import { stripTasksFields } from '../identity/TaskIdentity';

export class SubBulletWriter {
    constructor(private app: App, private fallbackLog: FallbackLog) {}

    private indentationStyle(): IndentationStyle {
        const useTab = (this.app.vault.getConfig?.('useTab') ?? true) as boolean;
        const tabSize = (this.app.vault.getConfig?.('tabSize') ?? 4) as number;
        return { indentWithTabs: useTab, tabSize };
    }

    async write(event: CompletionEvent, userText: string): Promise<void> {
        let resolvedIndex: number | null = null;
        let mismatchReason: string | null = null;

        await this.app.vault.process(event.file as TFile, (data) => {
            const lines = data.split('\n');
            const target = this.locate(lines, event);
            if (target.index === null) {
                mismatchReason = target.reason;
                return data;
            }
            resolvedIndex = target.index;
            const newLines = composeSubBullet(lines, target.index, userText, this.indentationStyle());
            return newLines.join('\n');
        });

        if (resolvedIndex === null) {
            await this.fallbackLog.append({
                timestamp: new Date(),
                taskLine: event.taskLine,
                userText,
                filePath: event.file.path,
                lineNumber: event.lineNumber,
                reason: mismatchReason ?? 'unknown',
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
```

- [ ] **Step 2: Run all tests + tsc**

Run:
```bash
npx tsc -noEmit
npx jest
```

Expected: PASS for all existing tests.

- [ ] **Step 3: Commit**

```bash
git add src/persistence/SubBulletWriter.ts
git commit -m "feat(persistence): SubBulletWriter class with line-then-scan fallback to FallbackLog"
```

---

## Task 12: DocumentationModal

Plain Obsidian Modal: title, read-only context, textarea, three buttons. Returns a promise that resolves to a discriminated union of the chosen action.

**Files:**
- Create: `src/ui/DocumentationModal.ts`

(No automated test — it's pure DOM glue. Manually verified in Task 16.)

- [ ] **Step 1: Create `src/ui/DocumentationModal.ts`**

```ts
import { App, Modal } from 'obsidian';

export type ModalResult =
    | { kind: 'save'; text: string }
    | { kind: 'defer' }
    | { kind: 'permanent-skip' };

export class DocumentationModal extends Modal {
    private resolve!: (r: ModalResult) => void;
    private settled = false;
    private textarea!: HTMLTextAreaElement;

    constructor(app: App, private taskLine: string) {
        super(app);
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
```

- [ ] **Step 2: Verify with tsc**

Run:
```bash
npx tsc -noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/ui/DocumentationModal.ts
git commit -m "feat(ui): DocumentationModal with save/defer/permanent-skip and Cmd-Enter shortcut"
```

---

## Task 13: PromptOrchestrator

Receives `CompletionEvent`s, applies folder filter and skip-state policy, dispatches to the modal queue, routes the modal result.

**Files:**
- Create: `tests/orchestration/PromptOrchestrator.test.ts`
- Create: `src/orchestration/PromptOrchestrator.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/orchestration/PromptOrchestrator.test.ts`:

```ts
import { TFile } from 'obsidian';
import { PromptOrchestrator } from '../../src/orchestration/PromptOrchestrator';
import { SkipStateStore } from '../../src/persistence/SkipStateStore';
import { DEFAULT_SETTINGS } from '../../src/config/Settings';
import type { CompletionEvent } from '../../src/detection/types';

const makeStore = async () => SkipStateStore.load({ load: async () => null, save: async () => {} });

function makeEvent(line: string, path = 'Work/notes.md'): CompletionEvent {
    return {
        file: new TFile(path),
        lineNumber: 0,
        taskLine: line,
        previousStatus: ' ',
        newStatus: 'x',
    };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('PromptOrchestrator', () => {
    test('drops events for files outside enabled folders', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS, enabledFolders: ['Work'] },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'x' }),
            writer: { write: async (e, t) => { writes.push({ e, t }); } },
            now: () => 0,
        });
        await orch.handle(makeEvent('- [x] outside', 'Personal/notes.md'));
        await orch.drainForTest();
        expect(writes).toHaveLength(0);
    });

    test('processes events when folder filter is empty (all enabled)', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'did it' }),
            writer: { write: async (e, t) => { writes.push({ e, t }); } },
            now: () => 0,
        });
        await orch.handle(makeEvent('- [x] task'));
        await orch.drainForTest();
        expect(writes).toHaveLength(1);
        expect(writes[0].t).toBe('did it');
    });

    test('drops events for permanently skipped tasks', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'x' }),
            writer: { write: async () => { writes.push(1); } },
            now: () => 0,
        });
        const ev = makeEvent('- [x] skipped task');
        // Pre-mark as permanent.
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        store.markPermanent(id, { label: 'x', filePath: ev.file.path });
        await orch.handle(ev);
        await orch.drainForTest();
        expect(writes).toHaveLength(0);
    });

    test('save → writer.write called and any deferred record cleared', async () => {
        const store = await makeStore();
        const writes: any[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'save', text: 'done' }),
            writer: { write: async (e, t) => { writes.push(t); } },
            now: () => 1000,
        });
        const ev = makeEvent('- [x] task');
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        store.markDeferred(id, { filePath: ev.file.path, lineNumber: 0, taskLine: ev.taskLine }, 1);
        await orch.handle(ev);
        await orch.drainForTest();
        expect(writes).toEqual(['done']);
        expect(store.getDeferred()).toEqual([]);
    });

    test('defer → markDeferred with remindAt = now + duration', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS, defaultDeferDurationMinutes: 60 },
            skipStore: store,
            modalShow: async () => ({ kind: 'defer' }),
            writer: { write: async () => {} },
            now: () => 1_000_000,
        });
        await orch.handle(makeEvent('- [x] task'));
        await orch.drainForTest();
        const deferred = store.getDeferred();
        expect(deferred).toHaveLength(1);
        expect(deferred[0].remindAt).toBe(1_000_000 + 60 * 60_000);
    });

    test('permanent-skip → markPermanent', async () => {
        const store = await makeStore();
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async () => ({ kind: 'permanent-skip' }),
            writer: { write: async () => {} },
            now: () => 0,
        });
        const ev = makeEvent('- [x] task');
        await orch.handle(ev);
        await orch.drainForTest();
        const id = (await import('../../src/identity/TaskIdentity')).computeId(ev);
        expect(store.isPermanentlySkipped(id)).toBe(true);
    });

    test('checkDeferred enqueues all due entries and re-prompts each', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => { seen.push(taskLine); return { kind: 'permanent-skip' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);
        store.markDeferred('id-b', { filePath: 'A.md', lineNumber: 2, taskLine: '- [x] b' }, 100_000);
        orch.checkDeferred();
        await orch.drainForTest();
        expect(seen).toEqual(['- [x] a']);
    });

    test('processAllDeferred enqueues regardless of remindAt', async () => {
        const store = await makeStore();
        const seen: string[] = [];
        const orch = new PromptOrchestrator({
            settings: { ...DEFAULT_SETTINGS },
            skipStore: store,
            modalShow: async (taskLine) => { seen.push(taskLine); return { kind: 'permanent-skip' }; },
            writer: { write: async () => {} },
            now: () => 1000,
        });
        store.markDeferred('id-a', { filePath: 'A.md', lineNumber: 1, taskLine: '- [x] a' }, 100);
        store.markDeferred('id-b', { filePath: 'A.md', lineNumber: 2, taskLine: '- [x] b' }, 100_000);
        orch.processAllDeferred();
        await orch.drainForTest();
        expect(seen.sort()).toEqual(['- [x] a', '- [x] b']);
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

Run:
```bash
npx jest tests/orchestration/PromptOrchestrator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/orchestration/PromptOrchestrator.ts`**

```ts
import { TFile } from 'obsidian';
import type { CompletionEvent } from '../detection/types';
import type { DocPromptSettings } from '../config/Settings';
import { SkipStateStore } from '../persistence/SkipStateStore';
import { computeId } from '../identity/TaskIdentity';
import { ModalQueue } from './ModalQueue';
import type { ModalResult } from '../ui/DocumentationModal';

export type ModalShow = (taskLine: string) => Promise<ModalResult>;

export interface WriterLike {
    write(event: CompletionEvent, text: string): Promise<void>;
}

interface QueueItem {
    event: CompletionEvent;
    id: string;
}

export interface OrchestratorDeps {
    settings: DocPromptSettings;
    skipStore: SkipStateStore;
    modalShow: ModalShow;
    writer: WriterLike;
    now?: () => number;
}

export class PromptOrchestrator {
    private settings: DocPromptSettings;
    private skipStore: SkipStateStore;
    private modalShow: ModalShow;
    private writer: WriterLike;
    private now: () => number;
    private queue: ModalQueue<QueueItem>;

    constructor(deps: OrchestratorDeps) {
        this.settings = deps.settings;
        this.skipStore = deps.skipStore;
        this.modalShow = deps.modalShow;
        this.writer = deps.writer;
        this.now = deps.now ?? (() => Date.now());
        this.queue = new ModalQueue<QueueItem>((item) => this.process(item));
    }

    setSettings(settings: DocPromptSettings): void {
        this.settings = settings;
    }

    async handle(event: CompletionEvent): Promise<void> {
        if (!this.isInEnabledFolder(event.file.path)) return;
        const id = computeId(event);
        if (this.skipStore.isPermanentlySkipped(id)) return;
        this.queue.enqueue({ event, id });
    }

    checkDeferred(): void {
        const due = this.skipStore.takeDueDeferred(this.now());
        for (const entry of due) {
            const ev: CompletionEvent = {
                file: new TFile(entry.snapshot.filePath),
                lineNumber: entry.snapshot.lineNumber,
                taskLine: entry.snapshot.taskLine,
                previousStatus: ' ',
                newStatus: 'x',
            };
            this.queue.enqueue({ event: ev, id: entry.taskId });
        }
    }

    processAllDeferred(): void {
        const all = this.skipStore.takeAllDeferred();
        for (const entry of all) {
            const ev: CompletionEvent = {
                file: new TFile(entry.snapshot.filePath),
                lineNumber: entry.snapshot.lineNumber,
                taskLine: entry.snapshot.taskLine,
                previousStatus: ' ',
                newStatus: 'x',
            };
            this.queue.enqueue({ event: ev, id: entry.taskId });
        }
    }

    drainForTest(): Promise<void> {
        return this.queue.drainForTest();
    }

    private isInEnabledFolder(path: string): boolean {
        const folders = this.settings.enabledFolders;
        if (!folders || folders.length === 0) return true;
        return folders.some((f) => {
            const norm = f.replace(/\/$/, '');
            return path === norm || path.startsWith(norm + '/');
        });
    }

    private async process(item: QueueItem): Promise<void> {
        const result = await this.modalShow(item.event.taskLine);
        if (result.kind === 'save') {
            await this.writer.write(item.event, result.text);
            this.skipStore.removeDeferred(item.id);
        } else if (result.kind === 'defer') {
            const remindAt = this.now() + this.settings.defaultDeferDurationMinutes * 60_000;
            this.skipStore.markDeferred(item.id, {
                filePath: item.event.file.path,
                lineNumber: item.event.lineNumber,
                taskLine: item.event.taskLine,
            }, remindAt);
        } else {
            this.skipStore.markPermanent(item.id, {
                label: item.event.taskLine,
                filePath: item.event.file.path,
            });
            this.skipStore.removeDeferred(item.id);
        }
    }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run:
```bash
npx jest tests/orchestration/PromptOrchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/orchestration/PromptOrchestrator.test.ts src/orchestration/PromptOrchestrator.ts
git commit -m "feat(orchestration): PromptOrchestrator routes events through filter/skip/queue"
```

---

## Task 14: SettingsTab

**Files:**
- Create: `src/config/SettingsTab.ts`

(No automated test — UI scaffolding only. Manually verified in Task 16.)

- [ ] **Step 1: Create `src/config/SettingsTab.ts`**

```ts
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
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
    constructor(app: App, private host: SettingsTabHost) {
        super(app, host as any);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Trigger
        containerEl.createEl('h3', { text: 'Trigger' });

        new Setting(containerEl)
            .setName('Done status symbols')
            .setDesc('Comma-separated list of status characters that count as DONE. Default: x,X')
            .addText((t) => {
                t.setValue(this.host.settings.doneStatusSymbols.join(','))
                    .onChange(async (v) => {
                        this.host.settings.doneStatusSymbols = v.split(',').map(s => s.trim()).filter(s => s.length > 0);
                        await this.host.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Enabled folders')
            .setDesc('Comma-separated paths. Empty = all folders.')
            .addText((t) => {
                t.setValue(this.host.settings.enabledFolders.join(','))
                    .onChange(async (v) => {
                        this.host.settings.enabledFolders = v.split(',').map(s => s.trim()).filter(s => s.length > 0);
                        await this.host.saveSettings();
                    });
            });

        // Defer
        containerEl.createEl('h3', { text: 'Defer' });

        new Setting(containerEl)
            .setName('Default defer duration (minutes)')
            .setDesc("How long 'Not now' postpones the prompt.")
            .addText((t) => {
                t.setValue(String(this.host.settings.defaultDeferDurationMinutes))
                    .onChange(async (v) => {
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
            .addToggle((t) => {
                t.setValue(this.host.settings.autoRepromptOnStart)
                    .onChange(async (v) => {
                        this.host.settings.autoRepromptOnStart = v;
                        await this.host.saveSettings();
                    });
            });

        // Writer
        containerEl.createEl('h3', { text: 'Writer' });

        new Setting(containerEl)
            .setName('Fallback log path')
            .setDesc('Where to log entries that could not be written back to the original file.')
            .addText((t) => {
                t.setValue(this.host.settings.fallbackLogPath)
                    .onChange(async (v) => {
                        this.host.settings.fallbackLogPath = v.trim() || 'Tasks Doc-Prompt — Lost.md';
                        await this.host.saveSettings();
                    });
            });

        // Deferred
        containerEl.createEl('h3', { text: 'Deferred tasks' });
        new Setting(containerEl)
            .setName(`${this.host.deferredCount()} deferred entries`)
            .addButton((b) => {
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
                    .addButton((b) => {
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
            .addToggle((t) => {
                t.setValue(false).setDisabled(true);
            });
    }
}
```

- [ ] **Step 2: Verify with tsc**

Run:
```bash
npx tsc -noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/config/SettingsTab.ts
git commit -m "feat(config): SettingsTab for trigger/defer/writer + deferred/permanent management"
```

---

## Task 15: main.ts (DocPromptPlugin)

Wires everything together: load settings, build store, build detector, build orchestrator, register interval/command/ribbon, settings tab.

**Files:**
- Create: `src/main.ts`

- [ ] **Step 1: Create `src/main.ts`**

```ts
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

        this.addSettingTab(new DocPromptSettingsTab(this.app, {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
            listPermanentSkips: () => this.skipStore.listPermanent(),
            removePermanentSkip: (id) => this.skipStore.removePermanent(id),
            deferredCount: () => this.skipStore.getDeferred().length,
            processAllDeferred: () => this.orchestrator.processAllDeferred(),
        }));

        if (this.settings.autoRepromptOnStart) {
            window.setTimeout(() => this.orchestrator.checkDeferred(), 3000);
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
```

- [ ] **Step 2: Verify with tsc and full build**

Run:
```bash
npx tsc -noEmit
npm run build
```

Expected: tsc passes; build produces `main.js` at the repo root.

- [ ] **Step 3: Run all tests**

Run:
```bash
npx jest
```

Expected: PASS for all tests.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire plugin lifecycle in DocPromptPlugin"
```

---

## Task 16: Manual Verification in a Test Vault

Build and deploy to a real Obsidian vault to verify behaviors that are not covered by the unit tests.

- [ ] **Step 1: Build production bundle**

Run:
```bash
npm run build
```

Expected: `main.js` exists at repo root.

- [ ] **Step 2: Deploy to a test vault**

Replace `<TEST_VAULT>` with an actual path (a scratch vault, not your main one):

```bash
mkdir -p "<TEST_VAULT>/.obsidian/plugins/tasks-doc-prompt"
cp main.js manifest.json "<TEST_VAULT>/.obsidian/plugins/tasks-doc-prompt/"
```

Open Obsidian, point it at the test vault, and enable the plugin in Settings → Community plugins.

- [ ] **Step 3: Manual checklist — record actual outcome next to each item**

Use a fresh markdown file in the vault for these tests.

1. **Live Preview toggle → modal → save → sub-bullet appears.**
   - Create `- [ ] write the report` in the file. Toggle the checkbox in Live Preview.
   - Modal appears with task text shown italic.
   - Type "Drafted v1, sent for review."; click Save.
   - File now contains the sub-bullet under the task line, indented one step.

2. **Reading mode (Tasks-query result) toggle.**
   - Add a `tasks` code block that lists the task and toggle from there.
   - Modal appears; save behaves the same.

3. **Recurring task toggle.**
   - Create `- [ ] daily standup 🔁 every day 📅 2026-05-08`.
   - Toggle done. Modal appears for the completed instance.
   - Verify only ONE modal opens (not one per inserted/changed line).
   - Verify the recurrence-inserted `[ ]` line does not produce a phantom modal.

4. **Defer + manual command.**
   - Toggle a task done; click Not now.
   - Run "Tasks Doc-Prompt: Process all deferred" from the command palette.
   - Modal returns with the same task.

5. **Permanent skip persists across restarts.**
   - Toggle a task done; click "Don't ask for this".
   - Toggle the same line back to `[ ]`, then back to `[x]`. No modal.
   - Quit and reopen Obsidian. Toggle that line again. Still no modal.
   - Open Settings → Tasks Doc-Prompt → Permanently skipped. Click Re-enable.
   - Toggle again. Modal returns.

6. **FallbackLog on description mismatch.**
   - Toggle a task done; while modal is open, edit the file outside the modal to remove the task line entirely. Click Save in the modal.
   - `Tasks Doc-Prompt — Lost.md` is created at the vault root with the captured text.

7. **Folder filter.**
   - In Settings, set `enabledFolders` to `Work`.
   - Toggle a task in `Personal/foo.md`: no modal.
   - Toggle a task in `Work/foo.md`: modal appears.

8. **Cmd/Ctrl-Enter saves; Esc defers.**
   - Verify keyboard shortcuts work in the modal.

- [ ] **Step 4: Document any defects in `docs/superpowers/specs/...-followups.md` (only if any found)**

Skip this step if everything passes. If issues found, capture them — do not fix in this plan; route them through a follow-up plan.

- [ ] **Step 5: Final verification commit**

```bash
git tag v0.1.0-mvp
git commit --allow-empty -m "chore: MVP verified manually in test vault"
```

---

## Self-Review Notes

- **Spec coverage check.** Every section of the design spec maps to at least one task: §3 architecture → file structure; §4 detector → Tasks 2, 6, 9; §5 orchestrator + queue → Tasks 7, 13; §6 modal → Task 12; §7 writer + fallback → Tasks 5, 10, 11; §8 skip-store + settings + identity → Tasks 3, 4, 8, 14; §9 lifecycle → Task 15; §10 error handling → covered in Tasks 8, 11, the queue's per-item try/catch in Task 7, and FallbackLog in Tasks 10–11; §11 testing strategy → Tasks 3–8, 13 (unit) and Task 16 (manual); §12 out-of-MVP → explicitly excluded; §14 non-goals → no plan tasks (correct).
- **Type consistency.** `CompletionEvent`, `CompletionDetector`, `ModalResult`, `DeferredEntry`, `PermanentEntry`, and `DocPromptSettings` are defined in their primary tasks (Tasks 2, 12, 8, 4) and consumed unchanged downstream. The Orchestrator constructs synthetic `CompletionEvent`s for re-prompts using `TFile` from `obsidian` and the same shape.
- **Risks worth flagging during execution.** (1) The Tasks-emoji stripping regex in `TaskIdentity.ts` is the most fragile component; if Task 3's tests reveal corner cases, prefer expanding tests over relaxing the regex. (2) The mock `Vault` in `tests/__mocks__/obsidian.ts` deliberately exposes minimal surface — extend per-task as needed rather than up-front. (3) `vault.process` in Obsidian is async and conflict-safe; do not replace it with `vault.modify` for "simplicity".
