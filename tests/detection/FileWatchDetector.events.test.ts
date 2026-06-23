import { FileWatchDetector } from '../../src/detection/FileWatchDetector';
import { TFile } from '../__mocks__/obsidian';
import type { CompletionEvent } from '../../src/detection/types';
import { DEFAULT_SETTINGS } from '../../src/config/Settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal controllable vault: lets a test fire vault events and mutate file
 * contents the way Obsidian / livesync / the Tasks plugin would at runtime.
 */
function makeApp(initial: Record<string, string>) {
    const files: Record<string, string> = { ...initial };
    const handlers: Record<string, Array<(...a: any[]) => any>> = {};
    const vault: any = {
        getMarkdownFiles: () => Object.keys(files).map((p) => new TFile(p)),
        read: async (f: TFile) => files[f.path] ?? '',
        on: (name: string, cb: (...a: any[]) => any) => {
            (handlers[name] ||= []).push(cb);
            return { name, cb };
        },
        offref: () => {},
    };
    const app: any = { vault };
    const fire = (name: string, ...args: any[]) =>
        (handlers[name] || []).forEach((h) => h(...args));
    const write = (path: string, content: string) => {
        files[path] = content;
    };
    return { app, fire, write };
}

describe('FileWatchDetector — files appearing after startup', () => {
    const settings = { ...DEFAULT_SETTINGS, doneStatusSymbols: ['x', 'X'] };

    test('emits a completion for a task in a file CREATED after start (livesync / new daily note)', async () => {
        const { app, fire, write } = makeApp({ 'Existing.md': '- [ ] old task' });
        const detector = new FileWatchDetector(app, settings);
        const events: CompletionEvent[] = [];
        detector.onCompletion(async (e) => {
            events.push(e);
        });
        detector.start();
        await wait(10); // let warmCache finish snapshotting existing files

        // A note appears AFTER startup — created with an open task.
        const path = 'Daily/2026-06-23.md';
        write(path, '- [ ] fresh task');
        fire('create', new TFile(path));
        await wait(20);

        // The task is completed (e.g., from a query view; Tasks rewrites the file).
        write(path, '- [x] fresh task ✅ 2026-06-23');
        fire('modify', new TFile(path));
        await wait(150); // 75ms debounce + async read

        expect(events).toHaveLength(1);
        expect(events[0].file.path).toBe(path);
        expect(events[0].previousStatus).toBe(' ');
        expect(events[0].newStatus).toBe('x');

        detector.stop();
    });
});
