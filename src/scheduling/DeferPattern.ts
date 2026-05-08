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

const ONE_YEAR_OF_MINUTES = 366 * 24 * 60;

/**
 * Returns ms-since-epoch of the next time strictly after `now` that
 * satisfies `pattern`. `now` is treated in local time; DST/TZ shifts
 * are out of scope.
 */
export function computeNextMatch(pattern: DeferPattern, now: Date): number {
    // Reference is `now` truncated to the start of its current minute.
    // Candidate must be strictly greater than this reference.
    const reference = new Date(now);
    reference.setSeconds(0, 0);

    const candidate = new Date(reference);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Initial coarse positioning: if we have a fixed `daysFromNow`, jump
    // the calendar day forward by that many days from `now`'s calendar day.
    if (pattern.daysFromNow !== null) {
        const target = startOfDay(now);
        target.setDate(target.getDate() + pattern.daysFromNow);
        if (candidate.getTime() < target.getTime()) {
            candidate.setTime(target.getTime());
        }
    }

    const refDay = startOfDay(reference).getTime();
    const deadline = reference.getTime() + ONE_YEAR_OF_MINUTES * 60_000;
    while (candidate.getTime() <= deadline) {
        if (matches(pattern, candidate, reference, refDay)) return candidate.getTime();
        candidate.setMinutes(candidate.getMinutes() + 1);
    }
    throw new Error('computeNextMatch: no match within one year');
}

function startOfDay(d: Date): Date {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

function matches(p: DeferPattern, candidate: Date, reference: Date, refDay: number): boolean {
    if (candidate.getTime() <= reference.getTime()) return false;
    if (p.hour !== null && candidate.getHours() !== p.hour) return false;
    if (p.minute !== null && candidate.getMinutes() !== p.minute) return false;
    if (p.daysFromNow !== null) {
        const candDay = startOfDay(candidate).getTime();
        const dayDiff = Math.round((candDay - refDay) / 86_400_000);
        if (dayDiff < p.daysFromNow) return false;
    }
    return true;
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

/** Short plain-English label for a recurrence badge. Never throws. */
export function formatDeferPattern(p: DeferPattern): string {
    const { daysFromNow: d, hour: h, minute: m } = p;
    const time = (hh: number, mm: number) => `${hh}:${mm.toString().padStart(2, '0')}`;

    // only minute is pinned; day and hour are wildcard
    if (d === null && h === null && m !== null) {
        return `every :${m.toString().padStart(2, '0')}`;
    }
    // every day at HH:MM
    if (d === null && h !== null && m !== null) {
        return `every day at ${time(h, m)}`;
    }
    // daily at HH:MM (D=1)
    if (d === 1 && h !== null && m !== null) {
        return `daily at ${time(h, m)}`;
    }
    // every N days at HH:MM (D>=2)
    if (d !== null && d >= 2 && h !== null && m !== null) {
        return `every ${d} days at ${time(h, m)}`;
    }
    // every N days (D>=1, time wildcards)
    if (d !== null && d >= 1 && h === null && m === null) {
        return d === 1 ? 'daily' : `every ${d} days`;
    }
    return 'custom';
}
