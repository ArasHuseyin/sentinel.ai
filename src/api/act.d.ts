import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export declare class ActionEngine {
    private page;
    private stateParser;
    private gemini;
    constructor(page: Page, stateParser: StateParser, gemini: GeminiService);
    act(instruction: string): Promise<{
        success: boolean;
        message: string;
    }>;
}
//# sourceMappingURL=act.d.ts.map