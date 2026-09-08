// Driver-side case: exercises the "Create follow-up" button inside a REAL
// Obsidian instance.
//
// Why this is a driver module (.mjs) and not a renderer script (.js) like
// new-file-completion.js: the interesting half of this feature is the
// Cmd/Ctrl+Shift+Enter shortcut, and a synthetic KeyboardEvent built in the
// renderer cannot prove Obsidian's own hotkey layer leaves that combination
// alone. Sending it through CDP's Input domain enters at the same point a
// physical keypress does, which needs the driver side.
//
// Two traps this case has to avoid, both of which produced false failures:
//   - Prompts are serialised through ModalQueue, and earlier cases leave their
//     own prompts behind, so "the modal that is on screen" is NOT necessarily
//     the one for the task we just completed. Every step therefore waits for a
//     prompt whose context line shows OUR task, and waits for quiet before
//     starting the next step.
//   - Indentation follows the vault's `useTab` setting (Obsidian defaults to
//     tabs), so assertions must not hardcode four spaces.
//
// Covered:
//   1. the button is present in the live modal (Jest only sees a fake DOM)
//   2. clicking it writes `- [ ] <text> <parent tags>` indented under the parent
//   3. Cmd/Ctrl+Shift+Enter reaches the textarea and does the same
//   4. Cmd/Ctrl+Enter still saves a plain comment (no regression)
//   5. blank text is refused and the prompt stays open

const NOTE = 'E2E-followup.md';
const DESC = 'write report';

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const META = 4;
const SHIFT = 8;

/** Renderer helpers, prepended to every evaluate() in this case. */
const H = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const prompts = () => [...document.querySelectorAll('.modal-container')]
        .filter((m) => /What did you do/.test(m.textContent || ''));
    // The prompt for OUR task: its context line echoes the task line.
    const ourPrompt = () => prompts().find((m) => {
        const ctx = m.querySelector('.tdp-context-line');
        return !!ctx && (ctx.textContent || '').includes(${JSON.stringify(DESC)});
    }) || null;
    const byText = (root, tag, text) =>
        [...root.querySelectorAll(tag)].find((el) => (el.textContent || '').trim() === text) || null;
    const closeAll = () =>
        document.querySelectorAll('.modal-container .modal-close-button').forEach((b) => b.click());
`;

export async function run({ evaluate, dispatchKey }) {
    const steps = {};
    const date = new Date().toISOString().slice(0, 10);
    const parentOpen = `- [ ] ${DESC} #work #project/alpha`;
    const parentDone = `- [x] ${DESC} #work #project/alpha ✅ ${date}`;

    // Indentation follows the vault's useTab setting — accept either style.
    // Takes PLAIN text: it does the regex escaping itself.
    const indented = (line) => new RegExp('^(\\t+| +)' + line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm');
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const promptCount = () => evaluate(`(() => { ${H} return prompts().length; })()`);

    /**
     * Close every open prompt and wait until the queue stops opening more.
     *
     * Driver-side because clicking `.modal-close-button` is not enough: that
     * element does not exist in every Obsidian version, and a prompt left open
     * by an earlier case BLOCKS ModalQueue, so our own task's prompt never
     * appears. A real Escape key always closes an Obsidian modal.
     */
    const settleQuiet = async () => {
        for (let i = 0; i < 25; i++) {
            if ((await promptCount()) === 0) {
                // The queue may open the next one — require two clear checks.
                await pause(350);
                if ((await promptCount()) === 0) return true;
            }
            await evaluate(`(() => { ${H} closeAll(); return true; })()`);
            await dispatchKey({ key: 'Escape', code: 'Escape', keyCode: 27 });
            await pause(250);
        }
        return false;
    };

    /** Recreate the note, complete the task, wait for ITS prompt. */
    const openPrompt = async () => {
        const quiet = await settleQuiet();
        const opened = await evaluate(`(async () => {
            ${H}
            const old = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
            if (old) { await app.vault.delete(old); await sleep(300); }
            const f = await app.vault.create(${JSON.stringify(NOTE)}, '# Follow-up\\n\\n${parentOpen}\\n');
            await sleep(500);
            await app.vault.modify(f, '# Follow-up\\n\\n${parentDone}\\n');
            for (let i = 0; i < 40 && !ourPrompt(); i++) await sleep(100);
            return !!ourPrompt();
        })()`);
        return quiet && opened;
    };

    /** Put text in our prompt's textarea and focus it (for key dispatch). */
    const typeIntoPrompt = (text) => evaluate(`(() => {
        ${H}
        const m = ourPrompt();
        if (!m) return { ok: false, reason: 'our prompt not on screen' };
        const ta = m.querySelector('textarea');
        ta.value = ${JSON.stringify(text)};
        ta.focus();
        return { ok: ta.value === ${JSON.stringify(text)} && document.activeElement === ta };
    })()`);

    const readNote = () => evaluate(
        `(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}); return f ? await app.vault.read(f) : ''; })()`,
    );
    /** What prompts are on screen, by the task line each one shows. */
    const inventory = () => evaluate(`(() => {
        ${H}
        return prompts().map((m) => {
            const c = m.querySelector('.tdp-context-line');
            return c ? (c.textContent || '').trim() : '(no context line)';
        });
    })()`);
    /** Click a button in our prompt; never throws, reports what it saw. */
    const clickInPrompt = (label) => evaluate(`(async () => {
        ${H}
        const m = ourPrompt();
        if (!m) return { ok: false, reason: 'our prompt not on screen' };
        const b = byText(m, 'button', ${JSON.stringify('LABEL')});
        if (!b) return { ok: false, reason: 'button not found' };
        b.click();
        await sleep(900);
        return { ok: true };
    })()`.replace('LABEL', label));
    const ourPromptOpen = () => evaluate(`(() => { ${H} return !!ourPrompt(); })()`);


    // Evidence for future maintenance: which close affordances this Obsidian
    // build actually offers on a prompt.
    steps.modalDom = await evaluate(`(() => {
        ${H}
        const m = prompts()[0];
        if (!m) return 'no prompt open at start';
        return {
            hasCloseButton: !!m.querySelector('.modal-close-button'),
            containerClasses: m.className,
            modalClasses: (m.querySelector('.modal') || {}).className || null,
        };
    })()`);

    /**
     * Type `text`, send `keyOpts`, and wait for `expect` to appear in the note.
     *
     * Retries because delivering a synthesized keystroke is timing-sensitive:
     * focus has to have settled in the renderer before Input.dispatchKeyEvent
     * lands. A shortcut that Obsidian genuinely swallows still fails every
     * attempt, so the check keeps its meaning.
     */
    const typeAndSendKey = async (text, keyOpts, expect, attempts = 3) => {
        let note = '';
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const typed = await typeIntoPrompt(text);
            if (typed && typed.ok) {
                await pause(250);
                await dispatchKey(keyOpts);
                // Poll instead of one fixed sleep: the write is async.
                for (let i = 0; i < 12; i++) {
                    await pause(200);
                    note = await readNote();
                    if (expect.test(note)) return { ok: true, attempt, note };
                }
            } else {
                note = await readNote();
                if (expect.test(note)) return { ok: true, attempt, note };
            }
        }
        return { ok: false, attempts, note };
    };

    // --- 1 + 2: the button exists and writes the follow-up task ------------
    steps.promptOpened_forButton = await openPrompt();
    steps.buttonPresent = await evaluate(`(() => {
        ${H}
        const m = ourPrompt();
        return !!(m && byText(m, 'button', 'Create follow-up'));
    })()`);
    steps.typed_forButton = await typeIntoPrompt('send it to Bob');
    steps.inventory_forButton = await inventory();
    steps.clicked_forButton = await clickInPrompt('Create follow-up');
    steps.afterButton_note = await readNote();
    steps.afterButton_promptClosed = !(await ourPromptOpen());

    // --- 3: the Cmd/Ctrl+Shift+Enter shortcut, as a real key event ---------
    steps.promptOpened_forShortcut = await openPrompt();
    steps.shortcut = await typeAndSendKey(
        'chase the numbers',
        { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: META | SHIFT },
        indented('- [ ] chase the numbers #work #project/alpha'),
    );
    steps.afterShortcut_note = steps.shortcut.note;
    steps.afterShortcut_promptClosed = !(await ourPromptOpen());

    // --- 4: plain Cmd/Ctrl+Enter still writes a comment --------------------
    steps.promptOpened_forSave = await openPrompt();
    steps.save = await typeAndSendKey(
        'Drafted v1.',
        { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: META },
        indented('- Drafted v1.'),
    );
    steps.afterSave_note = steps.save.note;

    // --- 5: blank text is refused, prompt stays open -----------------------
    steps.promptOpened_forBlank = await openPrompt();
    steps.blank_promptStaysOpen = await evaluate(`(async () => {
        ${H}
        const m = ourPrompt();
        if (!m) return false;
        m.querySelector('textarea').value = '   ';
        const b = byText(m, 'button', 'Create follow-up');
        if (!b) return false;
        b.click();
        await sleep(700);
        return !!ourPrompt();
    })()`);
    steps.blank_noteUnchanged = await readNote();

    await evaluate(`(async () => {
        ${H}
        closeAll();
        await sleep(300);
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
        if (f) await app.vault.delete(f);
    })()`);

    const checks = {
        prompt_opens: steps.promptOpened_forButton === true,
        button_present: steps.buttonPresent === true,
        button_writes_task_with_tags:
            indented('- [ ] send it to Bob #work #project/alpha').test(steps.afterButton_note),
        button_closes_prompt: steps.afterButton_promptClosed === true,
        parent_line_intact: steps.afterButton_note.includes(parentDone),
        shortcut_writes_task_with_tags:
            indented('- [ ] chase the numbers #work #project/alpha').test(steps.afterShortcut_note),
        shortcut_closes_prompt: steps.afterShortcut_promptClosed === true,
        plain_enter_still_saves_comment: indented('- Drafted v1.').test(steps.afterSave_note),
        comment_is_not_a_task: !/- \[ \] Drafted v1\./.test(steps.afterSave_note),
        blank_text_keeps_prompt_open: steps.blank_promptStaysOpen === true,
        blank_text_writes_nothing: !/- \[ \]/.test(steps.blank_noteUnchanged.split('\n').slice(2).join('\n')),
    };

    checks.reached_quiet_state = steps.promptOpened_forButton === true;
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    return { ok: failed.length === 0, failed, checks, steps };
}
