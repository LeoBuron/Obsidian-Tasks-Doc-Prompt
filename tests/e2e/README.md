# End-to-end harness (real Obsidian, driven over CDP)

The Jest suite exercises the detector against a **mock** vault, so it can't see
bugs in the live `vault.on(...)` event plumbing. This harness launches a real,
**isolated** Obsidian instance, drives it over the Chrome DevTools Protocol, and
asserts that the documentation modal actually opens.

It was built to reproduce — and now guards against — the regression where a task
completed in a file that first appeared **after** the plugin started (a new daily
note, or one synced in by livesync) silently failed to prompt, because the
detector had no baseline snapshot for that file. See
`cases/new-file-completion.js`.

## Run

```bash
npm run test:e2e
```

Optionally also load the Tasks plugin (to drive a real `tasks` query checkbox):

```bash
TASKS_PLUGIN_SRC="/path/to/.obsidian/plugins/obsidian-tasks-plugin" npm run test:e2e
```

Exit code is non-zero if any case fails. The harness runs against the plugin
build (`npm run build` is invoked automatically; set `E2E_SKIP_BUILD=1` to reuse
the existing `main.js`).

All cases run in order against one Obsidian instance. Run a subset with
`E2E_CASES` (comma-separated file names), e.g. while iterating on one case:

```bash
E2E_CASES=two-field-prompt.mjs E2E_SKIP_BUILD=1 npm run test:e2e
```

## How it works

1. **Build** the plugin → `main.js`.
2. **Set up** a throwaway vault + isolated Obsidian profile under `.work/`
   (gitignored), wholly separate from your real vaults/session.
3. Copy the newest installed `obsidian-*.asar` into the profile so it runs the
   **same Obsidian version** you use (a fresh profile would otherwise boot the
   older bundled asar; Tasks 8.x needs app ≥ 1.8.7).
4. **Launch** Obsidian with `--user-data-dir=<profile> --remote-debugging-port`.
5. **Force-enable** the plugin over CDP (deterministic on a fresh profile).
6. **Evaluate** a case script in the renderer — it drives `app.vault`, inspects
   `app.plugins.plugins['tasks-doc-prompt'].detector.cache`, and checks the DOM
   for the modal — then returns a JSON verdict the runner asserts on.

## Files

| File | Role |
|------|------|
| `run-e2e.mjs` | Orchestrator: build → setup → launch → enable → run cases → assert → teardown |
| `cdp.mjs` | Minimal CDP driver (`evaluate`, `dispatchKey`, `waitForCdp`); also usable ad-hoc: `node cdp.mjs '<expr>'` |
| `cases/new-file-completion.js` | Regression case for the after-startup-file bug |
| `cases/two-field-prompt.mjs` | The documentation + follow-up fields, the Cmd/Ctrl+Enter shortcut from either one, and the fallback log's blank-entry guard |

## Case flavours

- **`.js` — renderer script.** Its source is evaluated in the page and must
  return a JSON string verdict. Simple, but limited to the Runtime domain.
- **`.mjs` — driver module.** Exports `run({ evaluate, dispatchKey })`. Needed
  when a case must reach beyond `Runtime.evaluate` — `two-field-prompt.mjs`
  sends the Cmd/Ctrl+Enter shortcut through CDP's Input domain, because a
  synthetic `KeyboardEvent` built in the renderer cannot show whether Obsidian's
  own hotkey layer leaves the combination alone in the second textarea.

## Two traps when writing a case

Both of these produced convincing false failures before they were understood.

1. **The prompt on screen may not be yours.** Prompts are serialised through
   `ModalQueue`, and a prompt left open by an earlier case blocks the queue, so
   a newly completed task's prompt never appears. Wait for a prompt whose
   `.tdp-context-line` shows *your* task line, and close everything and wait for
   quiet before each step.
2. **Closing a prompt needs Escape.** Modern Obsidian (1.13) renders no
   `.modal-close-button`, so clicking that selector does nothing. Only a driver
   module can send a real Escape. `new-file-completion.js` still uses the old
   click and therefore leaves its prompts open — harmless for its own
   assertions, but every later case has to clean up after it.

Indentation of written lines follows the vault's `useTab` setting (Obsidian
defaults to tabs), so never assert on a hardcoded four spaces.

## Environment overrides

| Var | Default | Purpose |
|-----|---------|---------|
| `OBSIDIAN_BIN` | `/Applications/Obsidian.app/Contents/MacOS/Obsidian` | Obsidian executable |
| `OBSIDIAN_SUPPORT` | `~/Library/Application Support/obsidian` | where `obsidian-*.asar` lives |
| `CDP_PORT` | `9333` | remote-debugging port |
| `TASKS_PLUGIN_SRC` | _(unset)_ | copy a Tasks plugin install into the vault |
| `E2E_WORK` | `tests/e2e/.work` | throwaway vault/profile location |
| `E2E_SKIP_BUILD` | _(unset)_ | reuse existing `main.js` |

## Limitations

- macOS-oriented defaults; Electron flags are cross-platform but paths need overriding elsewhere.
- Requires a desktop session (Obsidian opens a window). Not wired into CI.
