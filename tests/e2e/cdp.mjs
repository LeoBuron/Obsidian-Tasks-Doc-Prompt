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

/** Evaluate a JS expression in Obsidian's renderer; awaits promises, returns the value. */
export async function evaluate(expression, { port = DEFAULT_PORT } = {}) {
    const ws = new WebSocket(await pageWsUrl(port));
    let id = 0;
    const pending = new Map();
    const send = (method, params) =>
        new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
        });
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
    });
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        }
    };
    await send('Runtime.enable', {});
    const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    });
    ws.close();
    if (r.exceptionDetails) {
        throw new Error(
            'EVAL EXCEPTION: ' +
                JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails),
        );
    }
    return r.result.value;
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
