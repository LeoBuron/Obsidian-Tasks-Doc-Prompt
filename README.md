# Tasks Doc-Prompt

An Obsidian plugin that prompts you to write a short paragraph when you mark a
task done. The note is saved as an indented sub-bullet directly under the task,
so the documentation lives next to the work it describes.

> Companion plugin to [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks).
> Detection is file-watch based today; the architecture is designed to swap in
> a Tasks-API hook the moment one is exposed.

## Who is this for?

You're the audience if you fall into any of these:

- You use Obsidian Tasks and want a worklog, not just a checked/unchecked state.
- You work in a research, engineering, or lab-notebook style where each closed
  task should carry a one- or two-sentence note about what was done or learned.
- You frequently check a task off and, three days later, have no idea what you
  actually did.

## The problem it solves

Marking a task done costs two seconds. Capturing *what* you did — the outcome,
the snag, the decision — has its own friction, so it usually doesn't happen.
That captured detail is exactly what matters later: at the weekly review, when
a similar task comes back, when someone asks how you handled something.

This plugin removes the friction by folding the writing step into the same beat
as the task transition. The moment the checkbox flips, the prompt is open and
the cursor is in the textarea. One sentence is fine. The note is saved as an
indented sub-bullet under the task, in the same file, at the same scroll
position — no context switch.

## What it does

When a task line transitions from open (`- [ ]`) to a configured "done" status
(default `x` or `X`), a modal opens:

```
┌────────────────────────────────────────────────────────────┐
│ What did you do?                                           │
│ - [x] write the report                                     │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ [textarea]                                           │   │
│ └──────────────────────────────────────────────────────┘   │
│ [Save]  [Not now]  [Defer until…]    [Don't ask]          │
└────────────────────────────────────────────────────────────┘
```

- **Save** writes the paragraph as an indented sub-bullet under the task.
- **Not now** defers the prompt; it re-fires after the configured duration.
- **Defer until…** opens an inline panel for picking *when* to be re-prompted
  (presets or custom time, optionally recurring).
- **Don't ask for this** marks the task permanently skipped.

If the modal is closed without an explicit choice, it's treated as "Not now".

## Defer-until panel

```
┌────────────────────────────────────────────────────────────┐
│ Defer to:                                                  │
│ [in 1h] [in 4h] [tomorrow 9:00] [next :00]                 │
│                                                            │
│ Custom:  [  *  ] [  *  ] [ 55 ]                            │
│           Days    Hour    Min                              │
│ [ ] recurring                                              │
│                                                            │
│              [Cancel]  [Confirm]                           │
└────────────────────────────────────────────────────────────┘
```

The custom field accepts three space-separated values: `Day Hour Min`. Each
field is either a non-negative integer (in its natural range) or `*` for "any".
The `*` wildcard means "the next matching moment".

| Input       | Meaning                                           |
|-------------|---------------------------------------------------|
| `0 17 0`    | today at 17:00 (rolls to tomorrow if past)        |
| `1 9 0`     | tomorrow at 09:00                                 |
| `7 9 0`     | seven days from now at 09:00                      |
| `* 9 0`     | next 09:00 (today or tomorrow, whichever is next) |
| `* * 55`    | next time the minute hits :55                     |

`* * *` is rejected as ambiguous.

If **recurring** is checked, the pattern is preserved on the entry. Each time
the prompt fires, clicking "Not now" advances the next reminder along the same
pattern, so a defer like `* * 55` keeps nudging at every :55 until you act.

Clicking a preset, or running Confirm with **recurring** unchecked, produces a
one-off defer that overrides any prior recurrence.

## Pending deferrals (Settings)

The Settings tab shows every pending deferral with the next reminder time, the
recurrence label (`⟲ daily at 9:00`, `⟲ every :55`, …), and Edit/Cancel
buttons. Editing reopens the Defer-until panel pre-filled with the current
pattern; Cancel removes the entry.

## Installation

This plugin is not in the official community store yet. There are two ways to
install it.

### Option A — BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is a community plugin that
installs and auto-updates plugins from any GitHub repository.

1. Install **BRAT** from the community store and enable it.
2. Open the BRAT settings → *Add Beta plugin*.
3. Paste the repository path: `LeoBuron/Obsidian-Tasks-Doc-Prompt`
4. Confirm. BRAT downloads the latest release and installs it under
   `.obsidian/plugins/tasks-doc-prompt/`.
5. Settings → Community plugins → enable **Tasks Doc-Prompt**.

BRAT will track new GitHub releases and offer to update the plugin
automatically.

### Option B — Manual install

1. Download `main.js`, `manifest.json`, and `versions.json` from the
   [latest release](https://github.com/LeoBuron/Obsidian-Tasks-Doc-Prompt/releases/latest).
2. Copy them into `<vault>/.obsidian/plugins/tasks-doc-prompt/`.
3. Settings → Community plugins → enable **Tasks Doc-Prompt**.

Or build from source: `npm install && npm run build` produces `main.js`.

Requires Obsidian 1.5.0 or later. Desktop-only for now (mobile-tested in a
future release).

## Settings

| Setting                        | Description                                                          |
|--------------------------------|----------------------------------------------------------------------|
| Done status symbols            | Comma-separated list of status chars that count as DONE (default `x,X`). |
| Enabled folders                | Comma-separated paths. Empty = all folders.                          |
| Default defer duration         | How long plain "Not now" postpones the prompt, in minutes.           |
| Auto re-prompt on start        | Re-fire any due deferred items shortly after Obsidian (re)starts.    |
| Fallback log path              | Where to log entries that couldn't be written back to the source file. |
| Deferred tasks                 | Editable list of pending deferrals (Edit / Cancel per row).          |
| Permanently skipped            | Tasks dismissed via "Don't ask"; can be re-enabled per row.          |

## Architecture

- `src/scheduling/DeferPattern.ts` — pure parser + `computeNextMatch` + plain-English label
- `src/persistence/SkipStateStore.ts` — debounced JSON persistence for skipped + deferred entries (schemaVersion 1)
- `src/orchestration/PromptOrchestrator.ts` — folder filter, queue, recurrence preservation table
- `src/orchestration/ModalQueue.ts` — FIFO serialisation so two completed tasks never race for the modal
- `src/detection/FileWatchDetector.ts` — pure-diff file-watch detector behind a `CompletionDetector` interface
- `src/persistence/SubBulletWriter.ts` — vault-aware writer with pure `compose()` for the bullet line
- `src/ui/DocumentationModal.ts` — Modal + Defer-until panel + edit-mode constructor

The persistence schema is version `1`. New fields (such as `recurrence` on a
deferred entry) are optional — older `data.json` files load unchanged.

## Development

```sh
npm install
npm run dev        # esbuild watch
npm test           # Jest (TDD-first; pure modules have full coverage)
npm run build      # tsc --noEmit + production esbuild
```

Tests live alongside the modules they exercise (`tests/<domain>/...`). DOM-driven
modal logic is verified manually against a test vault; pure logic and
persistence are exercised in Jest.

## License

MIT.
