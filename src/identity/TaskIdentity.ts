import { createHash } from 'crypto';
import type { CompletionEvent } from '../detection/types';

const TASKS_EMOJIS = ['📅', '⏳', '🛫', '➕', '✅', '🔁', '🆔', '⛔', '🏁', '🔼', '🔽', '⏫', '🔺', '⏬', '📝'];

const EMOJI_ALT = TASKS_EMOJIS.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const EMOJI_RE = new RegExp(
    `(?:${EMOJI_ALT})\\s*\\S*(?:\\s+(?!\\[|${EMOJI_ALT})\\S+)*`,
    'gu',
);

const DV_FIELD_RE = /\[[a-zA-Z][\w-]*::[^\]]*\]/g;
const STATUS_RE = /^\s*[-*+]\s*\[[^\]]\]\s*/;
const BLOCK_ID_RE = /\s*\^[A-Za-z0-9-]+\s*$/;

export function stripTasksFields(taskLine: string): string {
    let s = taskLine;
    s = s.replace(STATUS_RE, '');
    s = s.replace(BLOCK_ID_RE, '');
    s = s.replace(DV_FIELD_RE, '');
    s = s.replace(EMOJI_RE, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

export function computeId(event: CompletionEvent): string {
    if (event.blockId) {
        return `block:${event.blockId}`;
    }
    const desc = stripTasksFields(event.taskLine);
    const hash = createHash('sha1').update(desc).digest('hex').slice(0, 16);
    return `path:${event.file.path}::${hash}`;
}
