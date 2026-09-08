// Driver-side case: exercises the two-field prompt (documentation + follow-up
// task) inside a REAL Obsidian instance.
//
// Why this is a driver module (.mjs) and not a renderer script (.js) like
// new-file-completion.js: one of the claims is that Cmd/Ctrl+Enter saves from
// EITHER field, and a synthetic KeyboardEvent built in the renderer cannot
// prove Obsidian's own hotkey layer leaves that combination alone in a second
// textarea. Sending it through CDP's Input domain enters at the same point a
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
//   1. the live modal has both fields and no "Create follow-up" button
//   2. Save writes the documentation comment, then the follow-up task below it
//   3. a real Cmd/Ctrl+Enter saves both fields from EITHER textarea
//   4. either field alone writes only its own line
//   5. both fields blank writes nothing and still closes the prompt
//   6. blank fields + a parent line that moved leaves NO fallback-log entry
//   7. …while typed text + the same moved parent DOES produce one (control:
//      proves 6 is not passing because the fallback path is simply broken)

const NOTE = 'E2E-followup.md';
const DESC = 'write report';
// Matches `fallbackLogPath` in the harness vault's data.json.
const LOST = 'Lost.md';

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const META = 4;

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
    // What the note becomes when we make the parent "vanish" mid-prompt: still
    // a done task, but a different description, so the writer's locate() finds
    // nothing. A description change on an already-done line is not an
    // open→done transition, so the detector raises no second prompt.
    const parentGone = '- [x] a completely different task';

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Indentation follows the vault's useTab setting — accept either style.
    // Takes PLAIN text lines; asserts they appear as a consecutive block.
    const indented = (...plain) =>
        new RegExp('^' + plain.map((l) => '(\\t+| +)' + esc(l)).join('\\n') + '$', 'm');
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

    /**
     * Fill our prompt's fields. Passing null for a field leaves it untouched;
     * `focus` decides which textarea receives a subsequent key event.
     */
    const fillPrompt = ({ doc = null, followUp = null, focus = 'doc' }) => evaluate(`(() => {
        ${H}
        const m = ourPrompt();
        if (!m) return { ok: false, reason: 'our prompt not on screen' };
        const d = m.querySelector('.tdp-textarea-doc');
        const f = m.querySelector('.tdp-textarea-followup');
        if (!d || !f) return { ok: false, reason: 'fields missing', hasDoc: !!d, hasFollowUp: !!f };
        const docVal = ${JSON.stringify(doc)};
        const fuVal = ${JSON.stringify(followUp)};
        if (docVal !== null) d.value = docVal;
        if (fuVal !== null) f.value = fuVal;
        const target = ${JSON.stringify(focus)} === 'followUp' ? f : d;
        target.focus();
        return { ok: document.activeElement === target, focused: ${JSON.stringify(focus)} };
    })()`);

    /** Replace the note so the completed line no longer matches (writer can't locate it). */
    const vanishParent = () => evaluate(`(async () => {
        ${H}
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
        if (!f) return false;
        await app.vault.modify(f, '# Follow-up\\n\\n${parentGone}\\n');
        await sleep(400); // let the detector's debounced diff run and re-cache
        return true;
    })()`);

    const readNote = () => evaluate(
        `(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}); return f ? await app.vault.read(f) : ''; })()`,
    );
    /** Fallback log content, or null when the file does not exist at all. */
    const readLost = () => evaluate(
        `(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(LOST)}); return f ? await app.vault.read(f) : null; })()`,
    );
    const deleteLost = () => evaluate(`(async () => {
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(LOST)});
        if (f) await app.vault.delete(f);
        return true;
    })()`);
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

    // --- 1: the live modal's shape ----------------------------------------
    steps.promptOpened_forShape = await openPrompt();
    steps.shape = await evaluate(`(() => {
        ${H}
        const m = ourPrompt();
        if (!m) return { reason: 'our prompt not on screen' };
        return {
            textareaCount: m.querySelectorAll('textarea').length,
            hasDocField: !!m.querySelector('.tdp-textarea-doc'),
            hasFollowUpField: !!m.querySelector('.tdp-textarea-followup'),
            hasFollowUpButton: !!byText(m, 'button', 'Create follow-up'),
            hasSaveButton: !!byText(m, 'button', 'Save'),
        };
    })()`);

    // --- 2: Save writes the comment, then the task below it ----------------
    steps.filled_forSave = await fillPrompt({ doc: 'Drafted v1.', followUp: 'send it to Bob' });
    steps.inventory_forSave = await inventory();
    steps.clicked_forSave = await clickInPrompt('Save');
    steps.afterSave_note = await readNote();
    steps.afterSave_promptClosed = !(await ourPromptOpen());

    // --- 3: Cmd/Ctrl+Enter as a real key event, from EACH field -----------
    //
    // Both fields are checked because the claim is that the shortcut works
    // wherever the cursor is; a pass in one textarea says nothing about the
    // other. Retries because delivering a synthesized keystroke is
    // timing-sensitive: focus has to have settled in the renderer before
    // Input.dispatchKeyEvent lands. A shortcut Obsidian genuinely swallows
    // still fails every attempt, so the check keeps its meaning.
    const saveWithKey = async ({ doc, followUp, focus, expect }) => {
        let note = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
            const filled = await fillPrompt({ doc, followUp, focus });
            if (filled && filled.ok) {
                await pause(250);
                await dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13, modifiers: META });
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
        return { ok: false, note };
    };

    // 3a: cursor in the documentation field.
    steps.promptOpened_forDocKey = await openPrompt();
    steps.docKey = await saveWithKey({
        doc: 'Chased the numbers.',
        followUp: 'book the review',
        focus: 'doc',
        expect: indented('- Chased the numbers.', '- [ ] book the review #work #project/alpha'),
    });

    // 3b: cursor in the follow-up field. Distinct text so a note left over
    // from 3a could never satisfy this expectation.
    steps.promptOpened_forFollowUpKey = await openPrompt();
    steps.followUpKey = await saveWithKey({
        doc: 'Filed the receipts.',
        followUp: 'chase the invoice',
        focus: 'followUp',
        expect: indented('- Filed the receipts.', '- [ ] chase the invoice #work #project/alpha'),
    });

    // --- 4a: follow-up alone ----------------------------------------------
    steps.promptOpened_forTaskOnly = await openPrompt();
    steps.filled_forTaskOnly = await fillPrompt({ doc: '', followUp: 'ask about the budget' });
    steps.clicked_forTaskOnly = await clickInPrompt('Save');
    steps.afterTaskOnly_note = await readNote();

    // --- 4b: documentation alone ------------------------------------------
    steps.promptOpened_forDocOnly = await openPrompt();
    steps.filled_forDocOnly = await fillPrompt({ doc: 'Nothing left to do.', followUp: '' });
    steps.clicked_forDocOnly = await clickInPrompt('Save');
    steps.afterDocOnly_note = await readNote();

    // --- 5: both blank writes nothing, and the prompt still closes ---------
    steps.promptOpened_forBlank = await openPrompt();
    steps.filled_forBlank = await fillPrompt({ doc: '   ', followUp: '  ' });
    steps.clicked_forBlank = await clickInPrompt('Save');
    steps.afterBlank_note = await readNote();
    steps.afterBlank_promptClosed = !(await ourPromptOpen());

    // --- 6: blank fields + a parent that moved → no fallback entry ---------
    // Asserted before the control below, so "no Lost.md" means the file was
    // never created rather than merely not appended to.
    await deleteLost();
    steps.promptOpened_forPhantom = await openPrompt();
    steps.filled_forPhantom = await fillPrompt({ doc: '', followUp: '' });
    steps.vanished_forPhantom = await vanishParent();
    steps.clicked_forPhantom = await clickInPrompt('Save');
    await pause(600);
    steps.afterPhantom_lost = await readLost();

    // --- 7: control — typed text + the same moved parent DOES get logged ---
    steps.promptOpened_forControl = await openPrompt();
    steps.filled_forControl = await fillPrompt({ doc: 'Salvage me.', followUp: 'and me too' });
    steps.vanished_forControl = await vanishParent();
    steps.clicked_forControl = await clickInPrompt('Save');
    await pause(600);
    steps.afterControl_lost = await readLost();

    await evaluate(`(async () => {
        ${H}
        closeAll();
        await sleep(300);
        for (const p of [${JSON.stringify(NOTE)}, ${JSON.stringify(LOST)}]) {
            const f = app.vault.getAbstractFileByPath(p);
            if (f) await app.vault.delete(f);
        }
    })()`);

    const shape = steps.shape || {};
    const checks = {
        prompt_opens: steps.promptOpened_forShape === true,
        two_fields_present:
            shape.textareaCount === 2 && shape.hasDocField === true && shape.hasFollowUpField === true,
        follow_up_button_gone: shape.hasFollowUpButton === false && shape.hasSaveButton === true,

        save_writes_comment_then_task: indented(
            '- Drafted v1.',
            '- [ ] send it to Bob #work #project/alpha',
        ).test(steps.afterSave_note),
        save_closes_prompt: steps.afterSave_promptClosed === true,
        parent_line_intact: steps.afterSave_note.includes(parentDone),

        shortcut_from_doc_field_saves_both: steps.docKey.ok === true,
        shortcut_from_followup_field_saves_both: steps.followUpKey.ok === true,

        follow_up_alone_writes_only_the_task:
            indented('- [ ] ask about the budget #work #project/alpha').test(steps.afterTaskOnly_note) &&
            steps.afterTaskOnly_note.split('\n').filter((l) => /^(\t+| +)/.test(l)).length === 1,
        documentation_alone_writes_only_the_comment:
            indented('- Nothing left to do.').test(steps.afterDocOnly_note) &&
            !/- \[ \]/.test(steps.afterDocOnly_note),

        // "Nothing was written" and "no prompt is open" are both true when the
        // step never ran at all, so gate them on the step having happened.
        blank_step_ran:
            steps.promptOpened_forBlank === true &&
            steps.filled_forBlank?.ok === true &&
            steps.clicked_forBlank?.ok === true,
        blank_writes_nothing: !/^(\t+| +)\S/m.test(steps.afterBlank_note),
        blank_closes_prompt: steps.afterBlank_promptClosed === true,

        // The smell fix: nothing typed, nothing to lose, no phantom log entry.
        // Gated the same way, plus on the parent HAVING moved — an unmoved
        // parent never reaches the fallback branch, so "no log" would be true
        // for a reason that has nothing to do with the guard.
        phantom_step_ran:
            steps.promptOpened_forPhantom === true &&
            steps.filled_forPhantom?.ok === true &&
            steps.vanished_forPhantom === true &&
            steps.clicked_forPhantom?.ok === true,
        blank_with_moved_parent_logs_nothing: steps.afterPhantom_lost === null,
        // …and the fallback itself still works, so the check above isn't vacuous.
        text_with_moved_parent_is_logged:
            typeof steps.afterControl_lost === 'string' &&
            steps.afterControl_lost.includes('Salvage me.') &&
            steps.afterControl_lost.includes('- [ ] and me too #work #project/alpha'),
    };

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    return { ok: failed.length === 0, failed, checks, steps };
}
