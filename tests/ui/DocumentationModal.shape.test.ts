import { DocumentationModal } from '../../src/ui/DocumentationModal';

describe('DocumentationModal constructor', () => {
    test('accepts taskLine without prefill', () => {
        const m = new DocumentationModal({} as any, '- [x] hi');
        expect(m.taskLine).toBe('- [x] hi');
    });
    test('accepts a prefill argument', () => {
        const m = new DocumentationModal({} as any, '- [x] hi', {
            remindAt: 1_000_000,
            recurrence: { daysFromNow: null, hour: null, minute: 55 },
        });
        expect(m.taskLine).toBe('- [x] hi');
    });
});
