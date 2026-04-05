import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export declare class ExtractionEngine {
    private page;
    private stateParser;
    private gemini;
    constructor(page: Page, stateParser: StateParser, gemini: GeminiService);
    extract<T>(instruction: string, schema: any): Promise<T>;
}
//# sourceMappingURL=extract.d.ts.map