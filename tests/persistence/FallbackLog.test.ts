import { TFile } from 'obsidian';
import { FallbackLog, formatLogEntry } from '../../src/persistence/FallbackLog';

describe('formatLogEntry', () => {
    test('renders the expected markdown block', () => {
        const out = formatLogEntry({
            timestamp: new Date('2026-05-07T14:23:00Z'),
            taskLine: '- [x] write report',
            userText: 'Drafted v1.\nSent for review.',
            filePath: 'Notes/work.md',
            lineNumber: 12,
            reason: 'line-not-found',
        });
        expect(out).toContain('## 2026-05-07');
        expect(out).toContain('— write report');
        expect(out).toContain('Drafted v1.\nSent for review.');
        expect(out).toContain('[Original location: Notes/work.md:12]');
        expect(out).toContain('---');
    });
});

describe('FallbackLog', () => {
    function makeFakeVault() {
        const files = new Map<string, string>();
        return {
            files,
            getAbstractFileByPath(path: string) {
                return files.has(path) ? new TFile(path) : null;
            },
            async create(path: string, data: string) {
                files.set(path, data);
                return new TFile(path);
            },
            async append(file: TFile, data: string) {
                const cur = files.get(file.path) ?? '';
                files.set(file.path, cur + data);
            },
        };
    }

    test('creates the log file on first append', async () => {
        const vault = makeFakeVault();
        const log = new FallbackLog({ vault } as any, 'Lost.md');
        await log.append({
            timestamp: new Date('2026-05-07T14:23:00Z'),
            taskLine: '- [x] task',
            userText: 'text',
            filePath: 'a.md',
            lineNumber: 0,
            reason: 'r',
        });
        expect(vault.files.has('Lost.md')).toBe(true);
        expect(vault.files.get('Lost.md')).toContain('— task');
    });

    test('appends to existing log', async () => {
        const vault = makeFakeVault();
        vault.files.set('Lost.md', 'preexisting\n');
        const log = new FallbackLog({ vault } as any, 'Lost.md');
        await log.append({
            timestamp: new Date('2026-05-07T14:23:00Z'),
            taskLine: '- [x] task',
            userText: 'second',
            filePath: 'a.md',
            lineNumber: 0,
            reason: 'r',
        });
        const content = vault.files.get('Lost.md')!;
        expect(content.startsWith('preexisting')).toBe(true);
        expect(content).toContain('second');
    });
});
