import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export declare class ObservationEngine {
    private page;
    private stateParser;
    private gemini;
    constructor(page: Page, stateParser: StateParser, gemini: GeminiService);
    observe(): Promise<string[]>;
}
//# sourceMappingURL=observe.d.ts.map