import { SentinelDriver } from './core/driver.js';
import { StateParser } from './core/state-parser.js';
import { ActionEngine } from './api/act.js';
import { ExtractionEngine } from './api/extract.js';
import { ObservationEngine } from './api/observe.js';
import { GeminiService } from './utils/gemini.js';
import { Verifier } from './reliability/verifier.js';
export class Sentinel {
    driver;
    stateParser = null;
    actionEngine = null;
    extractionEngine = null;
    observationEngine = null;
    verifier = null;
    gemini;
    constructor(apiKey, driverOptions) {
        this.driver = new SentinelDriver(driverOptions);
        this.gemini = new GeminiService(apiKey);
    }
    async init() {
        await this.driver.initialize();
        const page = this.driver.getPage();
        const cdp = this.driver.getCDPSession();
        this.stateParser = new StateParser(page, cdp);
        this.actionEngine = new ActionEngine(page, this.stateParser, this.gemini);
        this.extractionEngine = new ExtractionEngine(page, this.stateParser, this.gemini);
        this.observationEngine = new ObservationEngine(page, this.stateParser, this.gemini);
        this.verifier = new Verifier(page, this.stateParser, this.gemini);
    }
    async goto(url) {
        await this.driver.goto(url);
    }
    async act(instruction, retries = 2) {
        if (!this.actionEngine || !this.stateParser || !this.verifier)
            throw new Error('Sentinel not initialized');
        let currentAttempt = 0;
        while (currentAttempt <= retries) {
            const stateBefore = await this.stateParser.parse();
            const result = await this.actionEngine.act(instruction);
            if (!result.success) {
                console.warn(`Action failed: ${result.message}. Retrying...`);
                currentAttempt++;
                continue;
            }
            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait for stability
            const stateAfter = await this.stateParser.parse();
            const verification = await this.verifier.verifyAction(instruction, stateBefore, stateAfter);
            if (verification.success && verification.confidence > 0.7) {
                return { success: true, message: verification.message };
            }
            else {
                console.warn(`Verification failed (${verification.confidence}): ${verification.message}. Retrying with more context...`);
                currentAttempt++;
            }
        }
        return { success: false, message: `Failed to execute action "${instruction}" after ${retries} retries.` };
    }
    async extract(instruction, schema) {
        if (!this.extractionEngine)
            throw new Error('Sentinel not initialized');
        return await this.extractionEngine.extract(instruction, schema);
    }
    async observe() {
        if (!this.observationEngine)
            throw new Error('Sentinel not initialized');
        return await this.observationEngine.observe();
    }
    async close() {
        await this.driver.close();
    }
}
//# sourceMappingURL=index.js.map