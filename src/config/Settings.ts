export interface DocPromptSettings {
    schemaVersion: 1;

    // Trigger
    doneStatusSymbols: string[];
    enabledFolders: string[];

    // Defer
    defaultDeferDurationMinutes: number;
    autoRepromptOnStart: boolean;

    // Writer
    fallbackLogPath: string;

    // Future-proofing for migration to TasksApiDetector
    enforcedMode: boolean;
}

export const DEFAULT_SETTINGS: DocPromptSettings = {
    schemaVersion: 1,
    doneStatusSymbols: ['x', 'X'],
    enabledFolders: [],
    defaultDeferDurationMinutes: 240,
    autoRepromptOnStart: true,
    fallbackLogPath: 'Tasks Doc-Prompt — Lost.md',
    enforcedMode: false,
};

export function mergeWithDefaults(loaded: unknown): DocPromptSettings {
    if (!loaded || typeof loaded !== 'object') return { ...DEFAULT_SETTINGS };
    const obj = loaded as Record<string, unknown>;
    if (obj.schemaVersion !== 1) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(obj as Partial<DocPromptSettings>) };
}
