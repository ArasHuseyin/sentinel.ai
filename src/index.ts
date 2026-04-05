import type { Page, BrowserContext } from 'playwright';
import { SentinelDriver } from './core/driver.js';
import type { DriverOptions } from './core/driver.js';
import { StateParser } from './core/state-parser.js';
import { ActionEngine } from './api/act.js';
import type { ActOptions, ActionResult } from './api/act.js';
import { ExtractionEngine } from './api/extract.js';
import { ObservationEngine } from './api/observe.js';
import type { ObserveResult } from './api/observe.js';
import { GeminiService } from './utils/gemini.js';
import type { SchemaInput } from './utils/gemini.js';
import { Verifier } from './reliability/verifier.js';
import { z } from 'zod';

// Re-export z and types so users can do: import { Sentinel, z } from './index.js'
export { z };
export type { ActOptions, ActionResult, ObserveResult };

export interface SentinelOptions {
  /** Gemini API key */
  apiKey: string;
  /** Run browser in headless mode (default: false) */
  headless?: boolean;
  /** Viewport size (default: 1280x720) */
  viewport?: { width: number; height: number };
  /**
   * Verbosity level:
   *  0 = silent, 1 = key actions only (default), 2 = full debug
   */
  verbose?: 0 | 1 | 2;
  /**
   * Enable state caching between calls (default: true).
   * Set to false to always fetch a fresh AOM state.
   */
  enableCaching?: boolean;
  /**
   * How long (ms) to wait for the DOM to settle after navigation/actions (default: 3000).
   */
  domSettleTimeoutMs?: number;
}

export class Sentinel {
  private driver: SentinelDriver;
  private stateParser: StateParser | null = null;
  private actionEngine: ActionEngine | null = null;
  private extractionEngine: ExtractionEngine | null = null;
  private observationEngine: ObservationEngine | null = null;
  private verifier: Verifier | null = null;
  private gemini: GeminiService;

  private readonly verbose: 0 | 1 | 2;
  private readonly enableCaching: boolean;
  private readonly domSettleTimeoutMs: number;

  constructor(options: SentinelOptions) {
    const driverOptions: DriverOptions = {
      headless: options.headless ?? false,
      ...(options.viewport ? { viewport: options.viewport } : {}),
    };
    this.driver = new SentinelDriver(driverOptions);
    this.gemini = new GeminiService(options.apiKey);
    this.verbose = options.verbose ?? 1;
    this.enableCaching = options.enableCaching ?? true;
    this.domSettleTimeoutMs = options.domSettleTimeoutMs ?? 3000;
  }

  // ─── Playwright passthrough ───────────────────────────────────────────────

  /** Direct access to the Playwright Page object */
  get page(): Page {
    return this.driver.getPage();
  }

  /** Direct access to the Playwright BrowserContext object */
  get context(): BrowserContext {
    return this.driver.getContext();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async init() {
    await this.driver.initialize();
    const page = this.driver.getPage();
    const cdp = this.driver.getCDPSession();

    this.stateParser = new StateParser(page, cdp);
    this.actionEngine = new ActionEngine(page, this.stateParser, this.gemini);
    this.extractionEngine = new ExtractionEngine(page, this.stateParser, this.gemini);
    this.observationEngine = new ObservationEngine(page, this.stateParser, this.gemini);
    this.verifier = new Verifier(page, this.stateParser, this.gemini);

    this.log(1, '🚀 Sentinel initialized');
  }

  async goto(url: string) {
    await this.driver.goto(url);
    this.stateParser?.invalidateCache();
    this.log(1, `🌐 Navigated to ${url}`);
  }

  async close() {
    await this.driver.close();
    this.log(1, '🔒 Sentinel closed');
  }

  // ─── Core API ─────────────────────────────────────────────────────────────

  /**
   * Perform an action on the page described in natural language.
   *
   * @param instruction  Natural-language instruction, e.g. "Click the login button"
   * @param options      Optional: variables for interpolation, retry count
   *
   * @example
   * await sentinel.act('Fill %email% into the email field', { variables: { email: 'tom@example.com' } });
   */
  async act(instruction: string, options?: ActOptions & { retries?: number }): Promise<ActionResult> {
    if (!this.actionEngine || !this.stateParser || !this.verifier) {
      throw new Error('Sentinel not initialized. Call init() first.');
    }

    if (!this.enableCaching) this.stateParser.invalidateCache();

    const retries = options?.retries ?? 2;
    let currentAttempt = 0;

    while (currentAttempt <= retries) {
      const stateBefore = await this.stateParser.parse();
      const result = await this.actionEngine.act(instruction, options);

      if (!result.success) {
        this.log(1, `⚠️  Action failed: ${result.message}. Attempt ${currentAttempt + 1}/${retries + 1}`);
        currentAttempt++;
        continue;
      }

      const stateAfter = await this.stateParser.parse();
      const verification = await this.verifier.verifyAction(instruction, stateBefore, stateAfter);

      if (verification.success && verification.confidence > 0.7) {
        this.log(1, `✅ "${instruction}" verified (confidence: ${(verification.confidence * 100).toFixed(0)}%)`);
        return { success: true, message: verification.message, ...(result.action ? { action: result.action } : {}) };
      } else {
        this.log(1,
          `⚠️  Verification weak (${(verification.confidence * 100).toFixed(0)}%): ${verification.message}. ` +
          `Retrying... (${currentAttempt + 1}/${retries + 1})`
        );
        currentAttempt++;
      }
    }

    return { success: false, message: `Failed to execute "${instruction}" after ${retries + 1} attempts.` };
  }

  /**
   * Extract structured data from the current page.
   *
   * @param instruction  What to extract, e.g. "Get all product names and prices"
   * @param schema       Zod schema or raw JSON Schema describing the expected output
   *
   * @example
   * const data = await sentinel.extract('Get the page title', z.object({ title: z.string() }));
   */
  async extract<T>(instruction: string, schema: SchemaInput<T>): Promise<T> {
    if (!this.extractionEngine) throw new Error('Sentinel not initialized. Call init() first.');
    if (!this.enableCaching) this.stateParser?.invalidateCache();
    this.log(2, `🔍 Extracting: "${instruction}"`);
    return await this.extractionEngine.extract<T>(instruction, schema);
  }

  /**
   * Observe the current page and return a list of possible interactions.
   *
   * @param instruction  Optional focus hint, e.g. "Find all navigation links"
   *
   * @example
   * const actions = await sentinel.observe('Find login-related elements');
   */
  async observe(instruction?: string): Promise<ObserveResult[]> {
    if (!this.observationEngine) throw new Error('Sentinel not initialized. Call init() first.');
    if (!this.enableCaching) this.stateParser?.invalidateCache();
    this.log(2, `👁️  Observing${instruction ? `: "${instruction}"` : ''}`);
    return await this.observationEngine.observe(instruction);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private log(level: 0 | 1 | 2, message: string) {
    if (this.verbose >= level) {
      console.log(`[Sentinel] ${message}`);
    }
  }
}
