# Per-Defer Time + Recurrence — Design

**Status:** Draft (awaiting user review)
**Date:** 2026-05-07
**Author:** Leo Buron, with Claude

---

## 1. Goal

Extend the deferral mechanism in `tasks-doc-prompt` so the user can specify
*when* a deferred prompt should re-fire, instead of only the global default
duration. Add an optional recurrence: a single deferral can fire once at the
next match, or repeatedly until acted on.

This was anticipated in the MVP design spec §5: *"A future modal version may
show a dropdown … and pass a different timestamp; no other code needs to
change."* The MVP infrastructure already carries a per-entry `remindAt`
timestamp, so the load-bearing data model is in place — this spec adds the
input UX, an editable list of pending deferrals, and a small pure scheduling
module.

## 2. User Mental Model

The user thinks of a defer as either:

- **Once** — "remind me at this time, then leave me alone": fire one prompt
  at the matching moment. If the user closes that prompt without acting,
  fall back to the default duration.
- **Recurring** — "keep nudging me at this pattern until I deal with it":
  fire at every match (e.g., every day at 9:00) until the user clicks Save
  or "Don't ask".

Both are selected per-defer; there is no global recurrence mode.

## 3. Input Format

Three space-separated fields: **`Day Hour Min`**.

- `Day`: integer ≥ 0 (days from now), or `*` (any day).
- `Hour`: integer in `0..23`, or `*` (any hour).
- `Min`: integer in `0..59`, or `*` (any minute).

The parser **rejects all-wildcard `* * *`** as ambiguous, and rejects any
field outside its valid range. Whitespace tolerance: any amount, any
combination of spaces and tabs.

### Examples

| Input       | Reference time   | Next match                   |
|-------------|------------------|------------------------------|
| `* * 55`    | 14:30:00         | 14:55 today                  |
| `* * 55`    | 14:55:00         | 15:55 today                  |
| `* * 55`    | 14:56:00         | 15:55 today                  |
| `0 17 0`    | 14:55, day D     | 17:00 day D                  |
| `0 17 0`    | 17:30, day D     | 17:00 day D+1 (forward only) |
| `1 9 0`     | any time, day D  | 09:00 day D+1                |
| `7 9 0`     | any time, day D  | 09:00 day D+7                |
| `* 9 0`     | 08:55            | 09:00 today                  |
| `* 9 0`     | 10:00            | 09:00 tomorrow               |
| `* * *`     | —                | rejected (parse error)       |

### Algorithm sketch

`computeNextMatch(pattern, now)`:

1. Compute candidate from the fixed (non-wildcard) fields, treating each
   wildcard as "the smallest value that doesn't push the result past `now`".
2. If the candidate is ≤ `now`, increment the smallest wildcard field by
   one of its natural step (+1 minute / +1 hour / +1 day) and recompute.
3. Return candidate as ms-since-epoch.

For wildcards in the `Day` field with the hour and minute fixed: walk
day-by-day from day 0. For wildcard hour with fixed minute: walk hour-by-hour
from the current hour. Other combinations are similar; the implementation
plan will spell out the table.

DST and timezone changes are explicitly **out of scope** — patterns are
applied in local time, naïve.

## 4. Architecture

### New module — `src/scheduling/DeferPattern.ts` (pure)

```ts
export interface DeferPattern {
    daysFromNow: number | null;   // null = wildcard
    hour: number | null;          // 0..23 or null
    minute: number | null;        // 0..59 or null
}

export function parseDeferInput(input: string): DeferPattern;
export function computeNextMatch(pattern: DeferPattern, now: Date): number;
```

Pure functions, full TDD coverage. No Obsidian dependency.

### Extension — `DeferredEntry` in `SkipStateStore`

```ts
interface DeferredEntry {
    taskId: string;
    snapshot: { filePath: string; lineNumber: number; taskLine: string };
    deferredAt: number;
    remindAt: number;
    recurrence?: DeferPattern;     // NEW; optional
}
```

`recurrence` is the pattern that produced this `remindAt`. Whenever the
orchestrator processes a defer for this entry, the recurrence is preserved
unless the user explicitly clears it (see §6). On each fire, the next
`remindAt` is `computeNextMatch(recurrence, now)`.

Schema version stays `1` — the field is optional and old `data.json`
files load without modification.

`SkipStateStore` gains one new method: `getDeferredById(taskId): DeferredEntry | undefined` — needed by the orchestrator to read the
current recurrence before processing a result.

### Extension — `DocumentationModal`

The modal grows a fourth button and an expandable panel. Layout:

```text
┌────────────────────────────────────────────────────────────┐
│ What did you do?                                           │
│ - [x] write the report                                     │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ [textarea]                                           │   │
│ └──────────────────────────────────────────────────────┘   │
│ [Save]  [Not now]  [Defer until…]    [Don't ask]          │
└────────────────────────────────────────────────────────────┘
```

Click **Defer until…** expands an inline panel:

```text
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

**Preset buttons** compute a concrete `remindAt` directly (skipping the
pattern logic) and set `recurrence = null`. The presets are:

| Preset            | Computation                                            |
|-------------------|--------------------------------------------------------|
| `in 1h`           | `now + 1h`                                             |
| `in 4h`           | `now + 4h`                                             |
| `tomorrow 9:00`   | next day at 09:00                                      |
| `next :00`        | next hour boundary                                     |

**Custom input** runs through `parseDeferInput` to a pattern, then
`computeNextMatch`. If the recurring checkbox is set, `recurrence = pattern`;
otherwise `recurrence = null`.

**Validation errors** show a `Notice` and leave the panel open with the
focus on the offending field.

#### `ModalResult` — extended (backwards compatible)

```ts
type ModalResult =
    | { kind: 'save'; text: string }
    | { kind: 'defer'; remindAt?: number; recurrence?: DeferPattern }
    | { kind: 'permanent-skip' };
```

`{kind: 'defer'}` with no `remindAt` is the existing fast-path "Not now".
The orchestrator interprets it (see §6).

#### Edit-mode constructor

```ts
new DocumentationModal(app, taskLine, prefill?: {
    remindAt: number;
    recurrence?: DeferPattern;
});
```

When `prefill` is provided:
- The textarea, "Save", and "Don't ask" buttons are hidden.
- The Defer-until panel is open by default with the prefilled values.
- The result is always `{kind: 'defer'; remindAt; recurrence?}` — never
  `save` or `permanent-skip`.

### Extension — `SettingsTab` "Deferred tasks" section

Replaces the current single-line counter with a list:

```text
Deferred tasks  (3)                      [Process all now]

· write the report           tomorrow 9:00     ⟲ daily   [Edit] [Cancel]
· call the dentist           in 4h             ·         [Edit] [Cancel]
· standup follow-up          today 17:00       ·         [Edit] [Cancel]
```

- `⟲ <label>` badge appears when `recurrence` is set; the label summarises
  the pattern in plain English (e.g., `daily`, `every 7 days at 9:00`,
  `every :55`). When `recurrence` is null, the column shows `·`.
- **Edit** opens `DocumentationModal` in edit-mode. Confirm calls
  `skipStore.markDeferred(id, snapshot, newRemindAt, newRecurrence)` —
  existing API; entry is overwritten in place.
- **Cancel** calls `skipStore.removeDeferred(id)`.
- After either action, `this.display()` re-renders the list (same pattern
  used by the permanent-skip "Re-enable" button).

The list is also re-rendered when the SettingsTab is opened, so it always
reflects the current store state.

### Extension — `PromptOrchestrator.process()`

```ts
async function process(item) {
  const existing = this.skipStore.getDeferredById(item.id);
  const result = await this.modalShow(item.event.taskLine);

  if (result.kind === 'defer') {
    let { remindAt, recurrence } = result;

    if (remindAt === undefined) {
      // "Not now" fastpath
      if (existing?.recurrence) {
        // Preserve recurring schedule
        remindAt = computeNextMatch(existing.recurrence, new Date(this.now()));
        recurrence = existing.recurrence;
      } else {
        // Plain default-duration defer
        remindAt = this.now() + this.settings.defaultDeferDurationMinutes * 60_000;
      }
    }
    this.skipStore.markDeferred(item.id, {
      filePath: item.event.file.path,
      lineNumber: item.event.lineNumber,
      taskLine: item.event.taskLine,
    }, remindAt, recurrence);
  }
  // save and permanent-skip branches unchanged; both call removeDeferred
  // which discards both remindAt and recurrence.
}
```

`checkDeferred` is unchanged — it still enqueues entries whose
`remindAt <= now`.

## 5. User Flows

### 5.1 Quick defer (existing behaviour, unchanged)

User completes task → modal opens → click **Not now** → entry deferred for
`defaultDeferDurationMinutes` (no recurrence).

### 5.2 Custom one-off

Modal → click **Defer until…** → panel opens → click `tomorrow 9:00`
preset → click Confirm. Entry has `remindAt = tomorrow 9:00`, no recurrence.

### 5.3 Recurring defer

Modal → **Defer until…** → type `* * 55` in custom fields → check
"recurring" → Confirm. Entry has `remindAt = next :55`, `recurrence = {null, null, 55}`. Each subsequent fire reschedules to the next :55.

### 5.4 Demote a recurring defer to one-off via "Not now"

A recurring re-prompt opens at :55. The user clicks plain **Not now**
without opening the panel. Per §6, the orchestrator preserves the existing
recurrence and reschedules to the next match. Recurrence is preserved.

### 5.5 Demote a recurring defer to one-off via "Defer until…"

A recurring re-prompt opens. User clicks **Defer until…**, picks a preset
or unchecks the recurring checkbox, Confirms. The result carries an absent
`recurrence` field, which overrides the existing recurrence (per §6).
The entry becomes one-off.

### 5.6 Edit from settings

Settings → Deferred tasks → row → **Edit** → modal opens in edit-mode with
prefilled values → user changes → Confirm. Entry overwritten via
`markDeferred`.

### 5.7 Cancel from settings

Settings → Deferred tasks → row → **Cancel** → entry removed via
`removeDeferred`. No modal involved.

## 6. Recurrence Preservation Rules (formal)

Triggered when the orchestrator processes a `{kind: 'defer'}` result:

| Result shape                                  | Existing entry has recurrence | New `remindAt`                          | New `recurrence` field           |
|-----------------------------------------------|-------------------------------|-----------------------------------------|----------------------------------|
| `{kind: 'defer'}` (Not now)                   | yes                           | `computeNextMatch(existing.recurrence)` | preserved (existing pattern)     |
| `{kind: 'defer'}` (Not now)                   | no                            | `now + defaultDeferDurationMinutes`     | absent                           |
| `{kind: 'defer', remindAt}` (preset)          | any                           | as-given                                | absent (overrides existing)      |
| `{kind: 'defer', remindAt, recurrence}`       | any                           | as-given                                | as-given (overrides existing)    |

The orchestrator's `markDeferred(id, snapshot, remindAt, recurrence?)`
overwrites the entry; passing `undefined` for the 4th argument clears any
previous recurrence.

This way, "Not now" is safe to use repeatedly on a recurring entry — the
recurrence is sticky until explicitly overridden via "Defer until…".

## 7. Error Handling

- Parse errors in the custom input show a `Notice` and keep the panel open.
  Validation runs on Confirm, not on every keystroke.
- Modal closed via Esc with the panel open: treat as Cancel of the panel
  (panel collapses). Closing the whole modal via Esc when panel is closed
  remains "defer with default" as before.
- An entry whose `recurrence` produces an unreachable next match (e.g.,
  pathological pattern after extreme date arithmetic): falls back to
  default duration with a console warning. Should not be possible with the
  validated input space, but defensive.

## 8. Testing

### Unit tests (Jest, no Obsidian mock)

- `parseDeferInput` — valid patterns, whitespace variations, range
  violations, all-wildcard rejection, empty/missing-field rejection,
  non-numeric input.
- `computeNextMatch` — fixed-`now` table tests covering: each wildcard
  combination; rollover at hour/day boundaries; precise `now == match`
  edge; large `Day` offsets.
- `SkipStateStore` — roundtrip with `recurrence`, backwards compat
  (entries without `recurrence` load), `getDeferredById`.
- `PromptOrchestrator` — preservation rules from §6: each row in the
  table verified with appropriate fakes.

### Manual tests (vault checklist, follow-up to Task 16)

1. Modal layout displays correctly; "Defer until…" panel expands inline.
2. Each preset writes the expected `remindAt`.
3. Custom input round-trip: type `* * 55`, Confirm, verify modal closes
   and entry is in store with the right values.
4. Recurring entry: defer with recurring checked, wait for fire, verify
   modal returns; click Not now; verify next match is computed correctly.
5. Edit from settings: open settings, edit row, change values, Confirm,
   verify the row updates.
6. Cancel from settings: row disappears.
7. Backwards compat: existing `data.json` with old-style entries (no
   `recurrence`) loads cleanly and behaves as before.

## 9. Out of Scope

- Full cron syntax (no minute-list, no day-of-week, no month).
- DST-aware scheduling.
- "Skip next occurrence" for recurring (achievable via Edit).
- Live preview of "next match: …" while the user types in the custom
  field (nice-to-have, not MVP).
- Translation / i18n.
- Quick keyboard shortcut to open the Defer-until panel (could be added
  in a follow-up).

## 10. Estimated Scope

| Module                                  | LOC  |
|-----------------------------------------|------|
| `DeferPattern.ts` (parse + match)       | ~80  |
| Modal extension (panel + presets)       | ~120 |
| SettingsTab list with Edit/Cancel       | ~80  |
| Orchestrator preservation logic         | ~30  |
| SkipStateStore extension                | ~20  |
| Tests                                   | ~250 |
| **Total**                               | **~580** |

Estimated implementation time: **8–12 hours**.

## 11. Migration Notes for Future Phases

This design intentionally keeps `recurrence` as a `DeferPattern` (the same
shape the parser produces). A later phase that wants richer scheduling
(e.g., real cron, named patterns) can replace `DeferPattern` with a
discriminated union — only the `scheduling/` module and the modal's panel
need changes. The store, orchestrator, and settings list keep working as
long as `computeNextMatch(pattern, now)` is implemented for the new
variants.
