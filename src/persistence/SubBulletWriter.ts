export interface IndentationStyle {
    indentWithTabs: boolean;
    tabSize: number; // used only when indentWithTabs is false
}

export function composeSubBullet(
    lines: string[],
    lineIndex: number,
    userText: string,
    style: IndentationStyle,
): string[] {
    if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error(`composeSubBullet: lineIndex ${lineIndex} out of range (0..${lines.length - 1})`);
    }

    const taskLine = lines[lineIndex];
    const existingIndent = taskLine.match(/^(\s*)/)?.[1] ?? '';
    const oneStep = style.indentWithTabs ? '\t' : ' '.repeat(style.tabSize);
    const childIndent = existingIndent + oneStep;
    const continuationIndent = childIndent + '  '; // align with text after "- "

    const trimmed = userText.replace(/\s+$/, '');
    const userLines = trimmed.split('\n');
    if (userLines.length === 0 || (userLines.length === 1 && userLines[0] === '')) {
        return lines.slice();
    }

    const composed: string[] = [];
    composed.push(`${childIndent}- ${userLines[0]}`);
    for (let i = 1; i < userLines.length; i++) {
        composed.push(`${continuationIndent}${userLines[i]}`);
    }

    const out = lines.slice();
    out.splice(lineIndex + 1, 0, ...composed);
    return out;
}
