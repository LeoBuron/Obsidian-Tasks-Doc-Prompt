// Runs in Obsidian's renderer (via CDP). Returns a JSON verdict.
//
// Regression for: a task completed in a file that first appeared AFTER the
// plugin started (a new daily note, or one synced in by livesync) must still
// open the documentation modal. Before the `vault.on('create')` fix, the
// detector had no baseline snapshot for such a file and silently dropped the
// first completion.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = app.plugins.plugins['tasks-doc-prompt'];
  if (!p || !p.detector) return JSON.stringify({ ok: false, error: 'plugin/detector not loaded' });

  const date = new Date().toISOString().slice(0, 10);
  const modalOpened = () =>
    [...document.querySelectorAll('.modal-container')].some((m) =>
      /What did you do/.test(m.textContent || ''),
    );
  const closeModals = () =>
    document.querySelectorAll('.modal-container .modal-close-button').forEach((b) => b.click());

  const steps = {};

  // --- CONTROL: pre-existing (warm-cached) file completes and prompts ---
  const base = app.vault.getAbstractFileByPath('Notes.md');
  await app.vault.modify(base, '# Notes\n\n- [ ] control task\n');
  await sleep(400);
  await app.vault.modify(base, `# Notes\n\n- [x] control task ✅ ${date}\n`);
  await sleep(600);
  steps.control_cachedFile_modal = modalOpened();
  closeModals();
  await sleep(200);

  // --- REGRESSION: file created AFTER startup completes and prompts ---
  let ex = app.vault.getAbstractFileByPath('E2E-new.md');
  if (ex) { await app.vault.delete(ex); await sleep(200); }

  const f = await app.vault.create('E2E-new.md', '# New\n\n- [ ] fresh task\n');
  await sleep(400);
  steps.newFile_inDetectorCache = p.detector.cache.has('E2E-new.md');

  await app.vault.modify(f, `# New\n\n- [x] fresh task ✅ ${date}\n`);
  await sleep(700);
  steps.newFile_modal = modalOpened();
  closeModals();
  await sleep(150);

  // cleanup
  ex = app.vault.getAbstractFileByPath('E2E-new.md');
  if (ex) await app.vault.delete(ex);

  const ok = steps.control_cachedFile_modal === true &&
             steps.newFile_inDetectorCache === true &&
             steps.newFile_modal === true;
  return JSON.stringify({ ok, steps }, null, 2);
})()
