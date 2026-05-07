import type { CompletionEvent } from './types';

export type CompletionHandler = (event: CompletionEvent) => Promise<void>;

export interface CompletionDetector {
    onCompletion(handler: CompletionHandler): void;
    start(): void;
    stop(): void;
}
