# Task-Completion Documentation Prompt — Design

**Status:** Draft (awaiting user review)
**Date:** 2026-05-07
**Author:** Leo Buron, with Claude

---

## 1. Goal

When a task is completed in an Obsidian vault, prompt the user with a popup
asking them to write a short paragraph documenting what they did. The popup
text is then written as an indented sub-bullet under the completed task. The
purpose is to enforce a documentation habit during task completion.

The behavior is opt-out per task ("don't ask for this") and opt-defer per
event ("ask me later"). The MVP is *soft*: tasks complete in the file
regardless of whether the user fills out the popup. The architecture must,
however, allow swapping in a *blocking* mode later without rewriting the
plugin.

## 2. Architectural Decision

**Three approaches were considered:**

- **A — Pure companion plugin** (no changes to Tasks plugin). Detects
  completions by listening to `vault.on('modify')` and diffing files. Simple
  to ship; brittle around recurrence and `OnCompletion::Delete`.
- **B — Surgical hook in Tasks fork + companion plugin.** Adds a small
  `onTaskCompleted` event/callback to the Tasks plugin's public API; the
  companion plugin subscribes. Cleanest separation, but requires maintaining
  a fork patch (or upstream merge).
- **C — Feature directly in Tasks fork.** Mixes opinionated workflow into a
  general-purpose plugin. Maximum upstream divergence; rejected.

**Decision: Approach A with clean trigger abstraction**, designed for cheap
later migration to B (estimated ~6–8h migration cost if A is built with the
detector behind an interface).

The `CompletionDetector` interface is the explicit migration boundary:
swapping `FileWatchDetector` (A) for a future `TasksApiDetector` (B)
must be a one-line change in `main.ts` plus a new file. No other module
should ever directly depend on the file-watch implementation.

## 3. High-Level Architecture

```text
src/
├─ main.ts                       Plugin lifecycle (load/unload), wiring
├─ detection/
│   ├─ CompletionDetector.ts      Interface
│   ├─ FileWatchDetector.ts       MVP impl (vault.on('modify') + diff)
│   └─ types.ts                   CompletionEvent type
├─ orchestration/
│   ├─ PromptOrchestrator.ts      Receives events, applies skip policy,
│   │                             dispatches to modal queue, routes actions
│   └─ ModalQueue.ts              Serializes overlapping completion modals
├─ ui/
│   └─ DocumentationModal.ts      Obsidian Modal: textarea + 3 buttons
├─ persistence/
│   ├─ SubBulletWriter.ts         Writes sub-bullet via vault.process()
│   ├─ FallbackLog.ts             Appends user text to lost-text log file
│   └─ SkipStateStore.ts          Loads/saves skip state via plugin data file
├─ config/
│   ├─ Settings.ts                Settings interface + defaults
│   └─ SettingsTab.ts             Obsidian PluginSettingTab
└─ identity/
    └─ TaskIdentity.ts            Stable hash for skip persistence
```

**Module boundaries:**

- `detection/` knows nothing about modals, skip-state, or persistence. It
  only emits `CompletionEvent`s.
- `orchestration/` is the only module that knows policy (skip-state, soft vs
  enforced — currently always soft).
- `persistence/` and `identity/` are pure functions / thin wrappers — easy
  to test in isolation.
- `ui/` only knows how to display a modal and report which button was
  clicked plus the text. It contains no policy.

### Project location

New, separate Git repo: `/Users/leo/work/obsidian-tasks-doc-prompt`. The
existing Tasks fork (`/Users/leo/work/obsidian-tasks`) is **not modified**
in the MVP.

## 4. CompletionDetector

### Interface

```ts
export interface CompletionDetector {
    onCompletion(handler: (event: CompletionEvent) => Promise<void>): void;
    start(): void;
    stop(): void;
}

export type CompletionEvent = {
    file: TFile;
    lineNumber: number;        // 0-based
    taskLine: string;          // full markdown line, post-toggle (with [x])
    previousStatus: string;    // e.g. " "
    newStatus: string;         // e.g. "x"
    blockId?: string;          // present iff task line contains ^xyz
};
```

### FileWatchDetector strategy

1. **Initial cache.** On plugin load, asynchronously walk all markdown
   files in the vault and build a `Map<filePath, TaskLineSnapshot[]>` where
   each snapshot stores `{ lineNumber, statusSymbol, descriptionHash }`.
   Heavy operation; runs in the background after `onload()` returns.
2. **Modify listener.** On `vault.on('modify')`, debounce 250 ms per file,
   then re-extract task lines and diff against the cached snapshots.
3. **Diff.** Identify lines whose status symbol changed *to* a DONE symbol
   (default: `x`, `X`; configurable in settings). Status changes between
   non-DONE symbols are ignored. Lines that *appear* (new tasks) are added
   to the cache without firing events.
4. **Cache update.** Replace the snapshot for the changed file after
   firing all events.
5. **Rename/delete.** Hook `vault.on('rename')` and `vault.on('delete')`
   to update cache keys / drop cache entries.

### Done-status detection

The detector must not depend on the Tasks plugin's `StatusRegistry`. We
read user-configurable symbols from this plugin's settings
(`doneStatusSymbols`, default `['x', 'X']`). This is a deliberate
duplication trade-off: small code (~1 line of regex) vs hard dependency
on Tasks' internals.

### Edge cases

| Case | Behavior |
|---|---|
| Recurring task toggle | The `[x]` line is detected as a transition; the new `[ ]` line that Tasks inserts is added to the cache without an event. |
| `OnCompletion::Delete` task | The line disappears from the file. **MVP: ignored** (no popup fires). Documented limitation. |
| User edits during open modal | `lineNumber` lookup at write time may fail. Fallback log catches the text. |
| User toggles back to open | `[x] → [ ]` is not a DONE transition; no event. |
| Rapid multi-toggle | Modal queue serializes. |
| File rename | Cache key rewritten on `vault.on('rename')`. |
| Plugin starts in a 10k-file vault | Initial cache build runs async; events from edits before the cache is warm are missed (acceptable; documented). |
| Modal shown while another open | Queue (FIFO). |

### Migration to B (TasksApiDetector)

Future replacement, sketch:

```ts
export class TasksApiDetector implements CompletionDetector {
    constructor(private app: App) {}
    onCompletion(handler) { this.handler = handler; }
    start() {
        const tasksPlugin = this.app.plugins.plugins['obsidian-tasks-plugin'];
        // Future API surface (not yet present upstream):
        tasksPlugin?.apiV1?.onTaskCompleted?.(this.handler);
    }
    stop() { /* unsubscribe */ }
}
```

When the Tasks fork or upstream gains the hook, swap `FileWatchDetector`
for `TasksApiDetector` in `main.ts`. Nothing else changes.

## 5. PromptOrchestrator and ModalQueue

Folder filtering (`settings.enabledFolders`) is applied here — the
Orchestrator drops events for files outside the configured folders before
checking skip-state. The Detector itself does not know about settings; this
keeps it testable and lets future detectors (e.g. `TasksApiDetector`) reuse
the same filter logic via the Orchestrator.

```text
onCompletionEvent(event):
    1. if !isInEnabledFolder(event.file.path): return
    2. id = TaskIdentity.computeId(event)
    3. if SkipStateStore.isPermanentlySkipped(id): return
    4. modalQueue.enqueue({ event, id, source: 'live' })

modalQueue.process(item):
    1. Open DocumentationModal with task line for context
    2. Await user action:
        ├─ Save:    SubBulletWriter.write(event, text);
        │           SkipStateStore.removeDeferred(id);
        ├─ Defer:   SkipStateStore.markDeferred(id, snapshot,
        │             remindAt = now + defaultDeferDurationMinutes * 60_000);
        └─ Skip:    SkipStateStore.markPermanent(id);
    3. Process next queued item
```

### Defer re-prompt

- Settings expose `defaultDeferDurationMinutes` (default: 240 = 4 h).
- `setInterval(checkDeferred, 60_000)` runs every minute and enqueues any
  deferred entries whose `remindAt < now`. Registered via
  `plugin.registerInterval()` to be cleaned up on unload.
- On plugin start, if `autoRepromptOnStart` is true (default), run
  `checkDeferred()` once after a 3 s warmup delay.
- A ribbon icon (left sidebar) and a command palette entry
  ("Tasks Doc-Prompt: Process all deferred") iterate **all** deferred
  entries regardless of `remindAt`.

### Per-skip defer duration (out of MVP, design-allowed)

The internal `markDeferred(id, snapshot, remindAt)` already takes a
timestamp parameter. The current modal hard-codes `remindAt =
now + defaultDeferDurationMinutes`. A future modal version may show a
dropdown ("in 1 h / 4 h / tomorrow / custom") and pass a different
timestamp; no other code needs to change.

### Modal queue

Simple FIFO queue. Only one modal at a time. New events enqueue. Defer
re-prompts also enqueue. The queue drains lazily — when one modal closes,
it pulls the next.

If the user closes Obsidian or unloads the plugin while items are queued,
they are *not* persisted. Live events are lost (acceptable; the user
saw the task get completed and chose not to act). Already-deferred items
remain persisted regardless.

## 6. DocumentationModal

Plain Obsidian `Modal` (no Svelte). Components:

- **Title:** "What did you do?" (English; i18n later).
- **Context display:** the task line itself, read-only, italic, truncated
  with title-tooltip if long.
- **Textarea:** multi-line, auto-focus on open, ~5 rows, no max length.
- **Buttons (in DOM order):**
  - Primary: "Save" (Cmd/Ctrl+Enter)
  - Secondary: "Not now" (Esc)
  - Tertiary: "Don't ask for this" (right-aligned)
- The modal returns a discriminated union:
  `{ kind: 'save', text } | { kind: 'defer' } | { kind: 'permanent-skip' }`.

The modal does **not** call any persistence code itself. It only resolves
its promise; the Orchestrator handles the consequence. This keeps the
modal pure UI.

## 7. SubBulletWriter

```ts
async write(event: CompletionEvent, text: string): Promise<void>
```

1. Locate target line:
   - Primary: by `event.lineNumber`
   - Verify by checking the line still contains the task description
     fragment from `event.taskLine`. If mismatch → linear scan for the
     description.
   - If still not found → `FallbackLog.append({ event, text, reason })`,
     show a Notice, return.
2. Compute indentation: match `^(\s*)` of the task line, append one
   indentation step (`\t` if `app.vault.getConfig('useTab')` is true,
   else 4 spaces).
3. Compose:
   - First line: `${indent}- ${userText.firstLine}`
   - Subsequent lines: `${indent}  ${userText.line}` (continuation indent,
     no `-`).
4. Write atomically via `app.vault.process(file, content => modified)`.

### FallbackLog

Appends to a single file (default: `Tasks Doc-Prompt — Lost.md` at vault
root, configurable). Format:

```markdown
## 2026-05-07 14:23 — <task-text>

<user-text>

[Original location: <path>:<line>]

---
```

Created on first append if missing.

## 8. SkipStateStore and Settings

### SkipStateStore

```ts
interface SkipState {
    schemaVersion: 1;
    deferred: Record<string /* taskId */, DeferredEntry>;
    permanent: Record<string /* taskId */, PermanentEntry>;
}

interface DeferredEntry {
    taskId: string;
    snapshot: { filePath: string; lineNumber: number; taskLine: string };
    deferredAt: number;
    remindAt: number;
}

interface PermanentEntry {
    taskId: string;
    skippedAt: number;
    // Stored only so the SettingsTab can show a human-readable label next to
    // the "Re-enable" button. Not used for matching — taskId is authoritative.
    label: string;
    filePath: string;
}
```

- Persisted via `plugin.saveData()` / `plugin.loadData()`.
- Disk writes are debounced 500 ms.
- Load is defensive: on `schemaVersion` mismatch or parse error, default
  to empty state and show a Notice.

### Settings

```ts
interface DocPromptSettings {
    schemaVersion: 1;

    // Trigger
    doneStatusSymbols: string[];          // Default: ['x', 'X']
    enabledFolders: string[];             // empty = all folders

    // Defer
    defaultDeferDurationMinutes: number;  // Default: 240
    autoRepromptOnStart: boolean;         // Default: true

    // Writer
    fallbackLogPath: string;              // Default: 'Tasks Doc-Prompt — Lost.md'

    // Future-proofing for migration to B
    enforcedMode: boolean;                // Default: false; ignored in MVP
}
```

### TaskIdentity

```ts
function computeId(event: CompletionEvent): string {
    if (event.blockId) return `block:${event.blockId}`;
    const desc = stripTasksFields(event.taskLine);
    return `path:${event.file.path}::${sha1(desc)}`;
}
```

`stripTasksFields` removes:
- Status marker `- [x]` / `- [ ]`
- Tasks emoji fields and their values (📅 ⏳ 🛫 ➕ ✅ 🔁 🆔 ⛔ 🏁 🔼 🔽 ⏫ 🔺 ⏬ 📝, plus Dataview-style `[due:: ...]` etc.)
- Leading/trailing whitespace

This makes IDs stable across status, date, priority, and recurrence
metadata changes — but breaks if the user rewords the task description.
Acceptable for MVP.

If the task line has a block-ID `^xyz`, that wins (stable across edits
and renames).

### SettingsTab

Standard `PluginSettingTab` with sections:

- **Trigger:** done-status symbols, folder include list
- **Defer:** default duration (minutes), auto-reprompt-on-start toggle
- **Writer:** fallback-log path
- **Deferred tasks:** count + "Process all now" button
- **Permanently skipped:** list with "Re-enable" buttons per entry
- **Enforced mode:** disabled toggle with tooltip "Available once the
  Tasks plugin exposes a completion hook"

## 9. Plugin Lifecycle

```ts
class DocPromptPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.skipStore = await SkipStateStore.load(this);
        this.detector = new FileWatchDetector(this.app, this.settings);
        this.orchestrator = new PromptOrchestrator({
            app: this.app,
            skipStore: this.skipStore,
            writer: new SubBulletWriter(this.app, this.settings),
            fallbackLog: new FallbackLog(this.app, this.settings),
            settings: this.settings,
        });
        this.detector.onCompletion(e => this.orchestrator.handle(e));
        this.detector.start();

        this.registerInterval(window.setInterval(
            () => this.orchestrator.checkDeferred(), 60_000));

        this.addCommand({
            id: 'process-deferred',
            name: 'Process all deferred',
            callback: () => this.orchestrator.processAllDeferred(),
        });
        this.addRibbonIcon('file-pen-line', 'Process deferred docs',
            () => this.orchestrator.processAllDeferred());

        this.addSettingTab(new DocPromptSettingsTab(this));

        if (this.settings.autoRepromptOnStart) {
            window.setTimeout(
                () => this.orchestrator.checkDeferred(), 3000);
        }
    }

    onunload() {
        this.detector.stop();
        // registerInterval handles cleanup
    }
}
```

## 10. Error Handling Principles

- **Never lose user text.** Save-write fails → FallbackLog. FallbackLog
  fails → Notice with text contents and console error.
- **Never block the editor.** All modify-event handlers wrap their work
  in try/catch; errors go to console + Notice, never thrown.
- **Defensive deserialization.** Schema-version check; on mismatch or
  parse error, default to empty state + Notice.

## 11. Testing Strategy

### Unit tests (Jest, no Obsidian mock)

- `TaskIdentity.computeId` — stability across status / date / priority /
  recurrence changes; sensitivity to description rewording.
- `FileWatchDetector.diff` — pure function over (oldSnapshots, newLines)
  → CompletionEvent[]. Cases: recurrence insert, multi-toggle, mixed
  status changes, indentation variations.
- `SubBulletWriter.compose` — pure over (lines, lineIndex, text,
  indentationStyle) → newLines. Tab/space, multi-line, top-level,
  nested.
- `SkipStateStore` — JSON roundtrip, schema-version mismatch, debounce
  semantics.

### Integration tests (with light Obsidian mock)

End-to-end flow: file modify → event → orchestrator → modal stub →
save action → file contents include sub-bullet.

### Manual testing

After each build, deploy to test vault, exercise:

1. Toggle task in Live Preview → modal → save → sub-bullet appears.
2. Toggle task in Reading mode (Tasks-query result) → modal → save.
3. Recurring task → only one modal, recurrence-instance line ignored.
4. Defer + manual command → modal returns.
5. Permanent skip → no further modal on re-completion of same task line.
6. Restart Obsidian → permanent skip persists, deferred entries fire if
   due.

## 12. Out-of-MVP / Roadmap

- **Phase 2:** Per-defer duration dropdown on "Not now" button.
- **Phase 3:** Storage options (central daily-note / done-log in addition
  to or instead of sub-bullet).
- **Phase 4:** Migration to TasksApiDetector + activate enforced mode.
- **Phase 5:** Pending-documentation inbox view.
- **Phase 6:** Statistics (completion rate, time-to-document).

## 13. Estimated Scope

| Module | LOC |
|---|---|
| `main.ts` + Settings + SettingsTab | ~200 |
| Detector | ~200 |
| Orchestrator + ModalQueue | ~150 |
| Modal | ~120 |
| SubBulletWriter + FallbackLog | ~120 |
| SkipStateStore + TaskIdentity | ~150 |
| Tests | ~400 |
| **Total** | **~1340** |

Estimated time to MVP: **16–22 hours** (excluding any time on the future
B-migration, which is estimated at 6–8 hours additional when it happens).

## 14. Explicit Non-Goals

- No support for `OnCompletion::Delete` tasks in MVP.
- No automatic suggestions for documentation text (e.g. AI-generated
  summaries).
- No multi-vault sync of skip state.
- No Svelte components — Vanilla DOM only.
- No dependency on Tasks plugin internals; only on Obsidian's public API.
- No upstream PR to `obsidian-tasks-group/obsidian-tasks` in MVP scope
  (that is part of Phase 4).
