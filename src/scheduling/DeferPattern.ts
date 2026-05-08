export interface DeferPattern {
    daysFromNow: number | null;   // null = wildcard
    hour: number | null;          // 0..23 or null
    minute: number | null;        // 0..59 or null
}

export class DeferPatternParseError extends Error {
    constructor(public readonly reason: string) {
        super(`Invalid defer pattern: ${reason}`);
        this.name = 'DeferPatternParseError';
    }
}

export function parseDeferInput(input: string): DeferPattern {
    const tokens = input.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length !== 3) {
        throw new DeferPatternParseError(
            `expected 3 fields (Day Hour Min), got ${tokens.length}`,
        );
    }
    const [dayTok, hourTok, minTok] = tokens;
    const daysFromNow = parseField(dayTok, 'Day', 0, Number.POSITIVE_INFINITY);
    const hour = parseField(hourTok, 'Hour', 0, 23);
    const minute = parseField(minTok, 'Min', 0, 59);

    if (daysFromNow === null && hour === null && minute === null) {
        throw new DeferPatternParseError('all-wildcard pattern is ambiguous');
    }
    return { daysFromNow, hour, minute };
}

function parseField(
    token: string, name: string, min: number, max: number,
): number | null {
    if (token === '*') return null;
    if (!/^-?\d+$/.test(token)) {
        throw new DeferPatternParseError(
            `${name}: '${token}' is not an integer or '*'`,
        );
    }
    const n = parseInt(token, 10);
    const normalised = n === 0 ? 0 : n;   // collapse IEEE -0 to +0
    if (normalised < min || normalised > max) {
        throw new DeferPatternParseError(
            `${name}: ${normalised} out of range ${min}..${
                Number.isFinite(max) ? max : '∞'
            }`,
        );
    }
    return normalised;
}
