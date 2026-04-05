import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { SimplifiedState } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export interface VerificationResult {
    done: boolean;
    success: boolean;
    message: string;
    confidence: number;
}
export declare class Verifier {
    private page;
    private stateParser;
    private gemini;
    constructor(page: Page, stateParser: StateParser, gemini: GeminiService);
    verifyAction(action: string, stateBefore: SimplifiedState, stateAfter: SimplifiedState): Promise<VerificationResult>;
}
//# sourceMappingURL=verifier.d.ts.map