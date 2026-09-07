/**
 * Hashtag pattern adapted from the Tasks plugin
 * (`TaskRegularExpressions.hashTags`). We deliberately mirror Tasks rather
 * than Obsidian's stricter tag rules: the question here is "what will Tasks
 * index as a tag on the new line", so the follow-up inherits exactly the tags
 * Tasks already sees on the parent, including a global-filter tag.
 *
 * One deviation: the negated class uses `\s` where Tasks has a literal space.
 * Tasks strips emoji fields off the end of the line before it looks for tags,
 * so a tab never reaches its regex; we run on the raw line, so any whitespace
 * must terminate a tag or `#work\t📅\t2026-09-10` would be one "tag".
 */
const HASH_TAGS_RE = /(^|\s)#[^\s!@#$%^&*(),.?":{}|<>]+/g;

/**
 * Tags of a task line, as Tasks would recognise them, in order of first
 * appearance and deduplicated case-insensitively. Runs on the raw line
 * (not the identity-stripped description) because Tasks accepts tags placed
 * after emoji fields such as 📅 and ✅.
 */
export function extractTags(taskLine: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of taskLine.match(HASH_TAGS_RE) ?? []) {
        const tag = match.trim();
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/**
 * Builds the bullet content for a follow-up task from the user's textarea
 * input: the first line becomes `[ ] <text> <inherited tags>`, later lines are
 * kept verbatim as continuation lines (only the first line is a task, so only
 * it carries the tags). Parent tags already present on the first line are not
 * repeated. Blank input yields '' so callers create nothing.
 */
export function composeFollowUpText(userText: string, parentTags: string[]): string {
    const trimmed = userText.replace(/\s+$/, '');
    if (trimmed.trim() === '') return '';

    const lines = trimmed.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    const [first, ...rest] = lines;
    const firstLine = first.replace(/\s+$/, '');
    const present = new Set(extractTags(firstLine).map((t) => t.toLowerCase()));
    const missing = parentTags.filter((t) => !present.has(t.toLowerCase()));
    const taskLine = [`[ ] ${firstLine}`, ...missing].join(' ');
    return [taskLine, ...rest].join('\n');
}
