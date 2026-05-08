import {
    parseDeferInput,
    DeferPatternParseError,
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
});
