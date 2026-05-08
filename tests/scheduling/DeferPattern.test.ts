import {
    parseDeferInput,
    DeferPatternParseError,
    computeNextMatch,
    type DeferPattern,
} from '../../src/scheduling/DeferPattern';

describe('parseDeferInput', () => {
    test('parses three integers', () => {
        expect(parseDeferInput('0 17 0')).toEqual<DeferPattern>({
            daysFromNow: 0, hour: 17, minute: 0,
        });
    });

    test('parses wildcards', () => {
        expect(parseDeferInput('* * 55')).toEqual<DeferPattern>({
            daysFromNow: null, hour: null, minute: 55,
        });
        expect(parseDeferInput('* 9 0')).toEqual<DeferPattern>({
            daysFromNow: null, hour: 9, minute: 0,
        });
        expect(parseDeferInput('1 * 0')).toEqual<DeferPattern>({
            daysFromNow: 1, hour: null, minute: 0,
        });
    });

    test('parses large day offsets', () => {
        expect(parseDeferInput('365 9 0')).toEqual<DeferPattern>({
            daysFromNow: 365, hour: 9, minute: 0,
        });
    });

    test('tolerates extra whitespace and tabs', () => {
        expect(parseDeferInput('  0\t17   0  ')).toEqual<DeferPattern>({
            daysFromNow: 0, hour: 17, minute: 0,
        });
    });

    test('rejects all-wildcard', () => {
        expect(() => parseDeferInput('* * *')).toThrow(DeferPatternParseError);
    });

    test('rejects fewer than three fields', () => {
        expect(() => parseDeferInput('0 17')).toThrow(DeferPatternParseError);
        expect(() => parseDeferInput('0')).toThrow(DeferPatternParseError);
        expect(() => parseDeferInput('')).toThrow(DeferPatternParseError);
    });

    test('rejects more than three fields', () => {
        expect(() => parseDeferInput('0 17 0 0')).toThrow(DeferPatternParseError);
    });

    test('rejects non-numeric, non-wildcard tokens', () => {
        expect(() => parseDeferInput('a 17 0')).toThrow(DeferPatternParseError);
        expect(() => parseDeferInput('0 ?? 0')).toThrow(DeferPatternParseError);
        expect(() => parseDeferInput('1.5 9 0')).toThrow(DeferPatternParseError);
    });

    test('rejects negative day', () => {
        expect(() => parseDeferInput('-1 9 0')).toThrow(DeferPatternParseError);
    });

    test('rejects hour out of 0..23', () => {
        expect(() => parseDeferInput('0 24 0')).toThrow(DeferPatternParseError);
        expect(() => parseDeferInput('0 -1 0')).toThrow(DeferPatternParseError);
    });

    test('rejects minute out of 0..59', () => {
        expect(() => parseDeferInput('0 9 60')).toThrow(DeferPatternParseError);
        expect(() => parseDeferInput('0 9 -1')).toThrow(DeferPatternParseError);
    });

    test('normalises -0 to 0', () => {
        const p = parseDeferInput('-0 9 0');
        expect(p.daysFromNow).toBe(0);
        expect(Object.is(p.daysFromNow, 0)).toBe(true);
        expect(Object.is(p.daysFromNow, -0)).toBe(false);
    });

    test('error.reason holds the bare reason; message has the prefix', () => {
        try {
            parseDeferInput('* * *');
            fail('expected DeferPatternParseError');
        } catch (e) {
            expect(e).toBeInstanceOf(DeferPatternParseError);
            const err = e as DeferPatternParseError;
            expect(err.reason).toBe('all-wildcard pattern is ambiguous');
            expect(err.message).toBe('Invalid defer pattern: all-wildcard pattern is ambiguous');
        }
    });
});

// Helper: build a Date at a precise local time. Tests use a fixed reference
// day (2026-05-07, Thursday) so they're independent of when they run.
function at(y: number, m: number, d: number, h: number, min: number): Date {
    return new Date(y, m - 1, d, h, min, 0, 0);
}

describe('computeNextMatch', () => {
    describe('wildcard minute (* * M)', () => {
        test('next :55 in same hour when before :55', () => {
            const now = at(2026, 5, 7, 14, 30);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: null, minute: 55 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 7, 14, 55).getTime());
        });
        test('strictly forward: at :55 returns next hour :55', () => {
            const now = at(2026, 5, 7, 14, 55);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: null, minute: 55 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 7, 15, 55).getTime());
        });
        test('after :55 moves to next hour', () => {
            const now = at(2026, 5, 7, 14, 56);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: null, minute: 55 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 7, 15, 55).getTime());
        });
        test('rolls over midnight to next day', () => {
            const now = at(2026, 5, 7, 23, 56);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: null, minute: 55 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 0, 55).getTime());
        });
    });

    describe('fixed day, hour, minute (D H M)', () => {
        test('today 17:00 from 14:55', () => {
            const now = at(2026, 5, 7, 14, 55);
            const next = new Date(computeNextMatch({ daysFromNow: 0, hour: 17, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 7, 17, 0).getTime());
        });
        test('forward only: 17:00 already past today rolls to D+1', () => {
            const now = at(2026, 5, 7, 17, 30);
            const next = new Date(computeNextMatch({ daysFromNow: 0, hour: 17, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 17, 0).getTime());
        });
        test('exactly at the matching minute returns next-day match', () => {
            // strictly-greater rule applies to whole minutes
            const now = at(2026, 5, 7, 17, 0);
            const next = new Date(computeNextMatch({ daysFromNow: 0, hour: 17, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 17, 0).getTime());
        });
        test('+1 day at 09:00 always tomorrow', () => {
            const now = at(2026, 5, 7, 8, 30);
            const next = new Date(computeNextMatch({ daysFromNow: 1, hour: 9, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 9, 0).getTime());
        });
        test('+7 days at 09:00', () => {
            const now = at(2026, 5, 7, 23, 0);
            const next = new Date(computeNextMatch({ daysFromNow: 7, hour: 9, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 14, 9, 0).getTime());
        });
    });

    describe('wildcard day, fixed hour+minute (* H M)', () => {
        test('today before window', () => {
            const now = at(2026, 5, 7, 8, 55);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: 9, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 7, 9, 0).getTime());
        });
        test('today after window rolls to tomorrow', () => {
            const now = at(2026, 5, 7, 10, 0);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: 9, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 9, 0).getTime());
        });
        test('exactly at the matching minute moves to next day', () => {
            const now = at(2026, 5, 7, 9, 0);
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: 9, minute: 0 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 9, 0).getTime());
        });
    });

    describe('fixed day, wildcard hour+minute (D * *)', () => {
        test('+1 day, any time → tomorrow 00:00', () => {
            const now = at(2026, 5, 7, 14, 30);
            const next = new Date(computeNextMatch({ daysFromNow: 1, hour: null, minute: null }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 0, 0).getTime());
        });
    });

    describe('wildcard hour, fixed minute (* * M) with day pinned (D * M)', () => {
        test('+1 day, any hour, minute 30 → tomorrow 00:30', () => {
            const now = at(2026, 5, 7, 14, 30);
            const next = new Date(computeNextMatch({ daysFromNow: 1, hour: null, minute: 30 }, now));
            expect(next.getTime()).toBe(at(2026, 5, 8, 0, 30).getTime());
        });
    });

    describe('seconds in `now` are ignored', () => {
        test('any second within :55 still advances to next :55', () => {
            const now = new Date(2026, 4, 7, 14, 55, 17, 250); // 14:55:17.250
            const next = new Date(computeNextMatch({ daysFromNow: null, hour: null, minute: 55 }, now));
            // Strictly greater than the *minute* — so this is 15:55.
            expect(next.getTime()).toBe(at(2026, 5, 7, 15, 55).getTime());
        });
    });
});
