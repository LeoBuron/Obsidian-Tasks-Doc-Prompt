// End-to-end runner: exercises the plugin inside a REAL Obsidian instance.
//
// Why this exists: the Jest suite drives the detector through a mock vault, so
// it cannot catch bugs in the live `vault.on(...)` event plumbing (e.g. the
// missing 'create' handler that dropped completions in files appearing after
// startup). This harness launches an isolated Obsidian, drives it over CDP, and
// asserts the documentation modal actually opens.
//
// Local-only (needs a real Obsidian install); not run in CI. macOS defaults;
// override OBSIDIAN_BIN / OBSIDIAN_SUPPORT for other platforms.
//
//   npm run test:e2e
//   TASKS_PLUGIN_SRC=/path/to/obsidian-tasks-plugin npm run test:e2e   # also load Tasks
import { spawn, execSync } from 'node:child_process';
import {
    mkdirSync, rmSync, cpSync, writeFileSync, readFileSync,
    readdirSync, existsSync, copyFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { evaluate, waitForCdp } from './cdp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const WORK = process.env.E2E_WORK || join(__dirname, '.work');
const VAULT = join(WORK, 'vault');
const USERDATA = join(WORK, 'userdata');
const PORT = Number(process.env.CDP_PORT || 9333);
const OBSIDIAN_BIN = process.env.OBSIDIAN_BIN || '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const OBSIDIAN_SUPPORT =
    process.env.OBSIDIAN_SUPPORT || join(homedir(), 'Library/Application Support/obsidian');
const TASKS_SRC = process.env.TASKS_PLUGIN_SRC || '';

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureBuild() {
    if (process.env.E2E_SKIP_BUILD) return;
    log('building plugin…');
    execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
}

function newestAsar() {
    try {
        const asars = readdirSync(OBSIDIAN_SUPPORT)
            .filter((f) => /^obsidian-.*\.asar$/.test(f))
            .sort();
        return asars.length ? join(OBSIDIAN_SUPPORT, asars[asars.length - 1]) : null;
    } catch {
        return null;
    }
}

function setupVault() {
    rmSync(WORK, { recursive: true, force: true });
    const pluginDir = join(VAULT, '.obsidian', 'plugins', 'tasks-doc-prompt');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(USERDATA, { recursive: true });

    copyFileSync(join(REPO, 'main.js'), join(pluginDir, 'main.js'));
    copyFileSync(join(REPO, 'manifest.json'), join(pluginDir, 'manifest.json'));
    writeFileSync(
        join(pluginDir, 'data.json'),
        JSON.stringify({
            settings: {
                schemaVersion: 1,
                doneStatusSymbols: ['x', 'X', '-'],
                enabledFolders: [],
                defaultDeferDurationMinutes: 240,
                autoRepromptOnStart: false,
                fallbackLogPath: 'Lost.md',
                enforcedMode: false,
            },
        }),
    );

    const community = ['tasks-doc-prompt'];
    if (TASKS_SRC) {
        cpSync(TASKS_SRC, join(VAULT, '.obsidian', 'plugins', 'obsidian-tasks-plugin'), {
            recursive: true,
        });
        community.unshift('obsidian-tasks-plugin');
    }
    writeFileSync(join(VAULT, '.obsidian', 'app.json'), '{}');
    writeFileSync(join(VAULT, '.obsidian', 'community-plugins.json'), JSON.stringify(community));
    writeFileSync(join(VAULT, 'Notes.md'), '# Notes\n\n- [ ] control task\n');

    const asar = newestAsar();
    if (asar) {
        copyFileSync(asar, join(USERDATA, basename(asar)));
        log('asar:', basename(asar));
    } else {
        log('WARN: no updated asar in', OBSIDIAN_SUPPORT, '— running bundled version');
    }
    writeFileSync(
        join(USERDATA, 'obsidian.json'),
        JSON.stringify({
            vaults: { '0000000000e2e2e2': { path: VAULT, ts: 1700000000000, open: true } },
            updateDisabled: true,
        }),
    );
}

function killHarness() {
    try {
        execSync('pkill -f ' + JSON.stringify(USERDATA));
    } catch {
        /* nothing to kill */
    }
}

function launch() {
    const child = spawn(
        OBSIDIAN_BIN,
        [`--user-data-dir=${USERDATA}`, `--remote-debugging-port=${PORT}`],
        { detached: true, stdio: 'ignore' },
    );
    child.unref();
}

async function waitForApp() {
    const deadline = Date.now() + 30000;
    for (;;) {
        try {
            const ready = await evaluate(
                `(typeof app !== 'undefined' && !!app.plugins && !!app.workspace && app.workspace.layoutReady === true)`,
                { port: PORT },
            );
            if (ready === true) return;
        } catch {
            /* renderer still loading / navigating between targets */
        }
        if (Date.now() > deadline) throw new Error('Obsidian app did not become ready');
        await sleep(500);
    }
}

async function enablePlugins() {
    const ids = TASKS_SRC ? ['obsidian-tasks-plugin', 'tasks-doc-prompt'] : ['tasks-doc-prompt'];
    return evaluate(
        `(async () => {
            try { app.plugins.setEnable && app.plugins.setEnable(true); } catch (e) {}
            for (const id of ${JSON.stringify(ids)}) {
                try { if (!app.plugins.enabledPlugins.has(id)) await app.plugins.enablePlugin(id); } catch (e) {}
            }
            return Object.keys(app.plugins.plugins);
        })()`,
        { port: PORT },
    );
}

async function main() {
    if (!existsSync(OBSIDIAN_BIN)) {
        console.error('Obsidian binary not found at', OBSIDIAN_BIN, '— set OBSIDIAN_BIN');
        process.exit(2);
    }
    ensureBuild();
    killHarness();
    setupVault();

    log('launching isolated Obsidian (CDP :' + PORT + ')…');
    launch();
    await waitForCdp(PORT);
    await waitForApp();

    let loaded = await enablePlugins();
    if (!loaded.includes('tasks-doc-prompt')) {
        await sleep(1500);
        loaded = await enablePlugins();
    }
    log('plugins:', loaded.join(', ') || '(none)');
    if (!loaded.includes('tasks-doc-prompt')) {
        killHarness();
        console.error('plugin failed to load in harness Obsidian');
        process.exit(1);
    }
    await sleep(1500); // let warmCache settle

    const caseSrc = readFileSync(join(__dirname, 'cases', 'new-file-completion.js'), 'utf8');
    const raw = await evaluate(caseSrc, { port: PORT });
    let result;
    try {
        result = JSON.parse(raw);
    } catch {
        result = { ok: false, error: 'unparseable result: ' + raw };
    }
    log('new-file-completion →', JSON.stringify(result, null, 2));

    killHarness();
    if (!result.ok) {
        console.error('\n❌ E2E FAILED');
        process.exit(1);
    }
    console.log('\n✅ E2E PASSED');
}

main().catch((err) => {
    killHarness();
    console.error(err);
    process.exit(1);
});
