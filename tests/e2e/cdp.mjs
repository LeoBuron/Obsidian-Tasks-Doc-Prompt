// Minimal Chrome DevTools Protocol driver for Obsidian's renderer process.
//
// Obsidian is an Electron app, so launching it with --remote-debugging-port
// exposes its renderer as a CDP target. This lets us evaluate arbitrary JS in
// the live `app` context — install probes, drive the vault, inspect plugin
// internals — which is the only way to exercise the real vault event plumbing
// that the Jest mocks cannot.
//
// Importable:  import { evaluate } from './cdp.mjs'
// CLI (ad-hoc): node cdp.mjs '<js-expression>'   or   node cdp.mjs --file snippet.js
import { readFileSync } from 'node:fs';

const DEFAULT_PORT = Number(process.env.CDP_PORT || 9333);

async function pageWsUrl(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes('obsidian.md'));
    if (!page) throw new Error('no Obsidian page target on CDP port ' + port);
    return page.webSocketDebuggerUrl;
}

/** How long a single CDP command may stay unanswered before we give up. */
const REQUEST_TIMEOUT_MS = Number(process.env.CDP_REQUEST_TIMEOUT_MS || 60000);

/**
 * Open a CDP session, hand `fn` a `send(method, params)`, and always close it.
 *
 * In-flight requests are rejected if the socket closes, errors, or goes quiet.
 * Without that, a renderer that disconnects mid-command leaves the promise
 * pending forever and the whole harness hangs with no output and no teardown.
 */
async function withSession(port, fn) {
    const ws = new WebSocket(await pageWsUrl(port));
    let id = 0;
    const pending = new Map();

    const failAll = (err) => {
        for (const { rej, timer } of pending.values()) {
            clearTimeout(timer);
            rej(err);
        }
        pending.clear();
    };

    const send = (method, params) => {
        const p = new Promise((res, rej) => {
            const mid = ++id;
            const timer = setTimeout(() => {
                pending.delete(mid);
                rej(new Error(`CDP timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
            }, REQUEST_TIMEOUT_MS);
            pending.set(mid, { res, rej, timer });
            try {
                ws.send(JSON.stringify({ id: mid, method, params }));
            } catch (err) {
                clearTimeout(timer);
                pending.delete(mid);
                rej(err);
            }
        });
        // Mark as handled so a request abandoned mid-flight (socket closed, or
        // the session torn down) cannot surface as an unhandled rejection and
        // kill the runner. Awaiting `p` still observes the rejection normally.
        p.catch(() => {});
        return p;
    };

    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('CDP socket error before open on port ' + port));
        ws.onclose = () => rej(new Error('CDP socket closed before open on port ' + port));
    });

    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { res, rej, timer } = pending.get(msg.id);
            clearTimeout(timer);
            pending.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        }
    };
    ws.onclose = () => failAll(new Error('CDP socket closed with requests in flight'));
    ws.onerror = () => failAll(new Error('CDP socket error with requests in flight'));

    try {
        return await fn(send);
    } finally {
        failAll(new Error('CDP session ended with requests in flight'));
        ws.close();
    }
}

/** Evaluate a JS expression in Obsidian's renderer; awaits promises, returns the value. */
export async function evaluate(expression, { port = DEFAULT_PORT } = {}) {
    const r = await withSession(port, async (send) => {
        await send('Runtime.enable', {});
        return send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        });
    });
    if (r.exceptionDetails) {
        throw new Error(
            'EVAL EXCEPTION: ' +
                JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails),
        );
    }
    return r.result.value;
}

/**
 * Send a REAL key event through Chrome's input pipeline to the focused element.
 *
 * Why not a synthetic `new KeyboardEvent(...)` in the renderer: a synthetic
 * event cannot prove that Obsidian's own hotkey layer leaves the combination
 * alone, and `isTrusted` differs. `Input.dispatchKeyEvent` enters at the same
 * point a physical keypress does, so an Obsidian global hotkey that swallows
 * the combination will swallow this one too.
 *
 * Modifier bitmask (CDP): Alt=1, Ctrl=2, Meta=4, Shift=8.
 */
export async function dispatchKey(
    { key, code, keyCode, modifiers = 0 },
    { port = DEFAULT_PORT } = {},
) {
    const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await withSession(port, async (send) => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    });
}

/** Wait until the CDP endpoint answers (Obsidian finished booting). */
export async function waitForCdp(port = DEFAULT_PORT, { timeoutMs = 40000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
            return;
        } catch {
            if (Date.now() > deadline) throw new Error('CDP did not come up on port ' + port);
            await new Promise((r) => setTimeout(r, 500));
        }
    }
}

// CLI mode (only when run directly, not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
    const arg = process.argv[2];
    const expr = arg === '--file' ? readFileSync(process.argv[3], 'utf8') : arg;
    const out = await evaluate(expr);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
}
