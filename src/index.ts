import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { Page, BrowserContext } from 'playwright';
import { SentinelDriver } from './core/driver.js';
import type { DriverOptions, BrowserType, ProxyOptions } from './core/driver.js';
export type { BrowserType, ProxyOptions };
import { StateParser } from './core/state-parser.js';
import { ActionEngine } from './api/act.js';
import type { ActOptions, ActionResult, ActionAttempt } from './api/act.js';
import { ExtractionEngine } from './api/extract.js';
import { ObservationEngine } from './api/observe.js';
import type { ObserveResult } from './api/observe.js';
import { GeminiService } from './utils/gemini.js';
import type { SchemaInput } from './utils/gemini.js';
import { Verifier } from './reliability/verifier.js';
import { AgentLoop } from './agent/agent-loop.js';
import type { AgentRunOptions, AgentResult, AgentStepEvent } from './agent/agent-loop.js';
import { VisionGrounding } from './core/vision-grounding.js';
import type { BoundingBox } from './core/vision-grounding.js';
import type { LLMProvider } from './utils/llm-provider.js';
export type { LLMProvider };
import { WorkflowRecorder } from './recorder/workflow-recorder.js';
import type { RecordedWorkflow } from './recorder/workflow-recorder.js';
import { TokenTracker } from './utils/token-tracker.js';
import { createLocatorCache } from './core/locator-cache.js';
import type { ILocatorCache, CachedLocator } from './core/locator-cache.js';
export type { ILocatorCache, CachedLocator };
import { createPromptCache, createCachingProvider } from './core/prompt-cache.js';
import type { IPromptCache } from './core/prompt-cache.js';
export type { IPromptCache };
import { RoundRobinProxyProvider, WebshareProxyProvider } from './utils/proxy-provider.js';
import type { IProxyProvider, WebshareProxyOptions } from './utils/proxy-provider.js';
export { RoundRobinProxyProvider, WebshareProxyProvider };
export type { IProxyProvider, WebshareProxyOptions };
import { withSpan, createTracingProvider, actCounter, actDuration, agentSteps, llmTokens } from './utils/telemetry.js';
export { slugifyInstruction } from './core/selector-generator.js';
import { SentinelError, ActionError, ExtractionError, NavigationError, AgentError, NotInitializedError } from './types/errors.js';
export { SentinelError, ActionError, ExtractionError, NavigationError, AgentError, NotInitializedError };
export type { RecordedWorkflow };
export { GeminiProvider } from './utils/providers/gemini-provider.js';
export { OpenAIProvider } from './utils/providers/openai-provider.js';
export { ClaudeProvider } from './utils/providers/claude-provider.js';
export { OllamaProvider } from './utils/providers/ollama-provider.js';
import { z } from 'zod';
// Re-export z and types so users can do: import { Sentinel, z } from './index.js'
export { z };
export type { ActOptions, ActionResult, ActionAttempt, ObserveResult, AgentRunOptions, AgentResult, AgentStepEvent, BoundingBox };

/**
 * A Playwright `Page` extended with Sentinel AI methods.
 * Created by `sentinel.extend(page)`.
 */
export type ExtendedPage = Page & {
  act(instruction: string, options?: ActOptions): Promise<ActionResult>;
  extract<T>(instruction: string, schema: SchemaInput<T>): Promise<T>;
  observe(instruction?: string): Promise<ObserveResult[]>;
};

// ─── Parallel execution types ─────────────────────────────────────────────────

/** A single task for `Sentinel.parallel()`. */
export interface ParallelTask {
  /** URL to navigate to before running the agent. */
  url: string;
  /** Natural-language goal passed to `sentinel.run()`. */
  goal: string;
  /** Maximum agent steps (default: 15). */
  maxSteps?: number;
}

/** Result for one task from `Sentinel.parallel()`. */
export interface ParallelResult {
  /** Position in the original task array — results are always returned in input order. */
  index: number;
  url: string;
  goal: string;
  goalAchieved: boolean;
  success: boolean;
  totalSteps: number;
  message: string;
  data?: unknown;
  /** Set when the task threw an unhandled exception (browser crash, network error, etc.). */
  error?: string;
}

export interface ParallelOptions {
  /**
   * Maximum number of browser sessions running simultaneously (default: 3).
   *
   * Monetisation note: this value is clamped to the tier limit in
   * `Sentinel.parallel()` — set `_maxConcurrency` to enforce it.
   */
  concurrency?: number;
  /**
   * Called each time a task finishes (success or failure).
   * Useful for progress bars, streaming dashboards, or early cancellation.
   */
  onProgress?: (completed: number, total: number, result: ParallelResult) => void;
}

export interface SentinelOptions {
  /** Gemini API key */
  apiKey: string;
  /** Run browser in headless mode (default: false) */
  headless?: boolean;
  /** Viewport size (default: 1280x720) */
  viewport?: { width: number; height: number };
  /**
   * Verbosity level:
   *  0 = silent
   *  1 = key actions only (default)
   *  2 = + LLM reasoning + fallback warnings
   *  3 = + chunk-processing stats + full LLM decision JSON
   */
  verbose?: 0 | 1 | 2 | 3;
  /**
   * Enable state caching between calls (default: true).
   * Set to false to always fetch a fresh AOM state.
   */
  enableCaching?: boolean;
  /**
   * Enable Vision Grounding fallback via Gemini Vision when AOM cannot find an element (default: false).
   */
  visionFallback?: boolean;
  /**
   * Browser engine to use (default: 'chromium'). Firefox and WebKit do not support CDP/AOM.
   */
  browser?: BrowserType;
  /**
   * Proxy configuration — either a static `ProxyOptions` object or a dynamic
   * `IProxyProvider` (e.g. `WebshareProxyProvider`, `RoundRobinProxyProvider`).
   */
  proxy?: ProxyOptions | IProxyProvider;
  /**
   * Add random human-like delays between actions (default: false).
   */
  humanLike?: boolean;
  /**
   * Path to a session file to load/save cookies & storage state.
   */
  sessionPath?: string;
  /**
   * Enable self-healing locator caching to skip the LLM on repeated actions:
   *  false (default) — disabled
   *  true            — in-memory cache (cleared when the Sentinel instance is closed)
   *  string          — file path for JSON persistence across runs
   */
  locatorCache?: false | true | string;
  /**
   * Path to a persistent browser profile directory.
   * Stores cookies, localStorage, IndexedDB, and ServiceWorkers on disk.
   * Use this for services that authenticate via IndexedDB (e.g. WhatsApp Web).
   * The directory is created automatically if it does not exist.
   * When set, sessionPath is ignored.
   */
  userDataDir?: string;
  /**
   * Custom LLM provider. If set, overrides the default Gemini provider.
   * @example new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' })
   */
  provider?: LLMProvider;
  /**
   * How long (ms) to wait for the DOM to settle after navigation/actions (default: 3000).
   */
  domSettleTimeoutMs?: number;
  /**
   * Maximum number of page elements sent to the LLM per `act()` call (default: 50).
   * On pages with more interactive elements, the list is pre-filtered by keyword
   * relevance to the instruction — reducing token usage and latency significantly.
   */
  maxElements?: number;
  /**
   * Cache LLM responses so identical (prompt, schema) pairs skip the model entirely:
   *  false  (default) — disabled
   *  true             — in-memory cache (cleared when the Sentinel instance is closed)
   *  string           — file path for JSON persistence across runs
   *
   * A cache hit costs zero tokens. Because the prompt includes the current page URL,
   * title, and element list, the cache naturally misses whenever the DOM changes —
   * no manual invalidation needed for normal navigation.
   *
   * Covers all LLM calls: `act()`, `extract()`, `observe()`, and the agent loop.
   */
  promptCache?: false | true | string;
}

export class Sentinel extends EventEmitter {
  private driver: SentinelDriver;
  private stateParser: StateParser | null = null;
  private actionEngine: ActionEngine | null = null;
  private extractionEngine: ExtractionEngine | null = null;
  private observationEngine: ObservationEngine | null = null;
  private verifier: Verifier | null = null;
  private agentLoop: AgentLoop | null = null;
  private visionGrounding: VisionGrounding | null = null;
  private recorder: WorkflowRecorder;
  private tokenTracker: TokenTracker;
  private gemini: GeminiService | LLMProvider;
  private readonly visionFallback: boolean;
  private readonly apiKey: string;
  /** Tracks active CDP sessions created by extend() so they can be detached on re-extend. */
  private readonly extendedPages = new WeakMap<Page, { detach(): Promise<void> }>();

  private readonly verbose: 0 | 1 | 2 | 3;
  private readonly enableCaching: boolean;
  private readonly domSettleTimeoutMs: number;
  private readonly maxElements: number;
  private readonly humanLike: boolean;
  private readonly locatorCacheInstance: ILocatorCache | null;
  private readonly promptCacheInstance: IPromptCache | null;
  private _tokenUsageCallback: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;

  constructor(options: SentinelOptions) {
    super();
    const driverOptions: DriverOptions = {
      headless: options.headless ?? false,
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.humanLike ? { humanLike: options.humanLike } : {}),
      ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
      ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
    };
    this.driver = new SentinelDriver(driverOptions);
    // Use custom provider if supplied, otherwise fall back to GeminiService
    this.gemini = (options.provider as any) ?? new GeminiService(options.apiKey);
    this.verbose = options.verbose ?? 1;
    this.enableCaching = options.enableCaching ?? true;
    this.domSettleTimeoutMs = options.domSettleTimeoutMs ?? 3000;
    this.maxElements = options.maxElements ?? 50;
    this.humanLike = options.humanLike ?? false;
    this.visionFallback = options.visionFallback ?? false;
    this.locatorCacheInstance = createLocatorCache(options.locatorCache ?? false);
    this.promptCacheInstance = createPromptCache(options.promptCache ?? false);
    this.apiKey = options.apiKey;
    this.recorder = new WorkflowRecorder();
    this.tokenTracker = new TokenTracker(process.env.GEMINI_VERSION ?? 'gemini-3-flash-preview');

    // Wire token usage tracking
    const provider = this.gemini as any;
    if (typeof provider === 'object' && provider !== null) {
      this._tokenUsageCallback = (usage: { inputTokens: number; outputTokens: number }) => {
        this.tokenTracker.track('llm-call', usage.inputTokens, usage.outputTokens);
      };
      provider.onTokenUsage = this._tokenUsageCallback;
    }
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

    // Extend the token usage callback to also emit OTel token metrics.
    // Doing this here (rather than inside createTracingProvider) avoids a race
    // condition: modifying provider.onTokenUsage per-call is unsafe when multiple
    // LLM calls run concurrently (e.g. via sentinel.extend()). The callback is
    // set once at init time on the original provider.
    const modelName = process.env.GEMINI_VERSION ?? 'unknown';
    if (this._tokenUsageCallback) {
      const prevCb = this._tokenUsageCallback;
      this._tokenUsageCallback = (usage) => {
        prevCb(usage);
        llmTokens.add(usage.inputTokens,  { 'llm.model': modelName, direction: 'input' });
        llmTokens.add(usage.outputTokens, { 'llm.model': modelName, direction: 'output' });
      };
      (this.gemini as any).onTokenUsage = this._tokenUsageCallback;
    }

    // Wrap with telemetry tracing (innermost — wraps real LLM calls with spans + metrics).
    this.gemini = createTracingProvider(this.gemini, modelName);

    // Wrap with prompt caching (outermost — cache hits bypass the tracing layer).
    if (this.promptCacheInstance) {
      this.gemini = createCachingProvider(this.gemini, this.promptCacheInstance);
    }

    this.stateParser = new StateParser(page, cdp);
    if (this.visionFallback) {
      this.visionGrounding = new VisionGrounding(this.gemini);
    }
    this.actionEngine = new ActionEngine(page, this.stateParser, this.gemini, this.visionGrounding ?? undefined, this.domSettleTimeoutMs, this.locatorCacheInstance, this.maxElements, this.verbose, this.humanLike);
    this.extractionEngine = new ExtractionEngine(page, this.stateParser, this.gemini);
    this.observationEngine = new ObservationEngine(page, this.stateParser, this.gemini);
    this.verifier = new Verifier(page, this.stateParser, this.gemini);
    this.agentLoop = new AgentLoop(this.actionEngine, this.extractionEngine, this.stateParser, this.gemini);

    this.log(1, '🚀 Sentinel initialized');
  }

  async goto(url: string) {
    await this.driver.goto(url);
    this.stateParser?.invalidateCache();
    this.recorder.record({ type: 'goto', url, pageUrl: url, pageTitle: '' });
    this.emit('navigate', { url });
    this.log(1, `🌐 Navigated to ${url}`);
  }

  async close() {
    const provider = this.gemini as any;
    if (this._tokenUsageCallback && typeof provider === 'object' && provider !== null) {
      provider.onTokenUsage = undefined;
      this._tokenUsageCallback = undefined;
    }
    await this.driver.close();
    this.emit('close');
    this.log(1, '🔒 Sentinel closed');
  }

  // ─── Parallel execution ───────────────────────────────────────────────────

  /**
   * Run multiple independent agent tasks in parallel, each in its own browser session.
   * Tasks are processed using a worker-pool so at most `concurrency` browsers run at once.
   * Results are returned in the same order as the input tasks regardless of completion order.
   *
   * @param tasks      Array of `{ url, goal, maxSteps? }` descriptors.
   * @param options    Shared `SentinelOptions` for every session plus `concurrency` and `onProgress`.
   *
   * @example
   * const results = await Sentinel.parallel(
   *   [
   *     { url: 'https://amazon.de', goal: 'Find cheapest laptop' },
   *     { url: 'https://ebay.de',   goal: 'Find cheapest laptop' },
   *   ],
   *   { apiKey: process.env.GEMINI_API_KEY!, concurrency: 2 }
   * );
   */
  static async parallel(
    tasks: ParallelTask[],
    options: SentinelOptions & ParallelOptions,
    /** @internal Injectable factory — used by tests to avoid spawning real browsers. */
    _factory?: (opts: SentinelOptions) => Promise<Sentinel>
  ): Promise<ParallelResult[]> {
    if (tasks.length === 0) return [];

    // ── Monetisation hook ──────────────────────────────────────────────────────
    // Clamp concurrency to the tier limit here. Example:
    //   const tierLimit = getTierLimit(options.apiKey);  // Free=1, Pro=5, Enterprise=∞
    //   const concurrency = Math.min(options.concurrency ?? 3, tierLimit);
    const concurrency = Math.max(1, options.concurrency ?? 3);

    const factory = _factory ?? (async (opts: SentinelOptions) => {
      const s = new Sentinel(opts);
      await s.init();
      return s;
    });

    const results: ParallelResult[] = new Array(tasks.length);
    let completed = 0;

    // Shared mutable queue — each worker pops tasks until empty
    const queue = tasks.map((task, index) => ({ task, index }));

    const runOne = async (task: ParallelTask, index: number): Promise<void> => {
      let sentinel: Sentinel | null = null;
      try {
        sentinel = await factory(options);
        await sentinel.goto(task.url);
        const result = await sentinel.run(task.goal, { maxSteps: task.maxSteps ?? 15 });
        results[index] = {
          index,
          url: task.url,
          goal: task.goal,
          goalAchieved: result.goalAchieved,
          success: result.success,
          totalSteps: result.totalSteps,
          message: result.message,
          ...(result.data !== undefined ? { data: result.data } : {}),
        };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        results[index] = {
          index,
          url: task.url,
          goal: task.goal,
          goalAchieved: false,
          success: false,
          totalSteps: 0,
          message: msg,
          error: msg,
        };
      } finally {
        await sentinel?.close().catch(() => {});
        completed++;
        options.onProgress?.(completed, tasks.length, results[index]!);
      }
    };

    // Worker: drains the queue sequentially
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item) break;
        await runOne(item.task, item.index);
      }
    };

    // Spawn min(concurrency, tasks.length) workers in parallel
    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
    );

    return results;
  }

  // ─── Recording ─────────────────────────────────────────────────────────────

  /** Start recording all actions into a replayable workflow. */
  startRecording(name?: string): void {
    this.recorder.startRecording(name);
    this.log(1, '🔴 Recording started');
  }

  /** Stop recording and return the captured workflow. */
  stopRecording(): RecordedWorkflow {
    const workflow = this.recorder.stopRecording();
    this.log(1, `⏹️  Recording stopped (${workflow.steps.length} steps)`);
    return workflow;
  }

  /** Export a recorded workflow as TypeScript code. */
  exportWorkflowAsCode(workflow: RecordedWorkflow): string {
    return this.recorder.exportAsCode(workflow);
  }

  /** Export a recorded workflow as JSON string. */
  exportWorkflowAsJSON(workflow: RecordedWorkflow): string {
    return this.recorder.exportAsJSON(workflow);
  }

  /** Replay a recorded workflow step by step. */
  async replay(workflow: RecordedWorkflow): Promise<void> {
    this.log(1, `▶️  Replaying workflow: "${workflow.name}" (${workflow.steps.length} steps)`);
    for (const step of workflow.steps) {
      if (step.type === 'goto' && step.url) {
        await this.goto(step.url);
      } else if ((step.type === 'act' || step.type === 'scroll' || step.type === 'press') && step.instruction) {
        await this.act(step.instruction);
      } else if (step.type === 'observe') {
        await this.observe(step.instruction);
      }
    }
    this.log(1, '✅ Replay complete');
  }

  // ─── Token Tracking ────────────────────────────────────────────────────────

  /** Get accumulated token usage and estimated cost. */
  getTokenUsage() {
    return this.tokenTracker.getUsage();
  }

  /**
   * Clear the prompt cache.
   * Has no effect when `promptCache` is disabled.
   */
  clearPromptCache(): void {
    if (!this.promptCacheInstance) return;
    this.promptCacheInstance.clear();
    this.log(1, '🗑️  Prompt cache cleared');
  }

  /** Export token usage log as JSON to a file path. */
  exportLogs(filePath: string): void {
    fs.writeFileSync(filePath, this.tokenTracker.exportAsJSON(), 'utf-8');
    this.log(1, `📊 Logs exported to ${filePath}`);
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
    const actionEngine = this.actionEngine;
    const stateParser = this.stateParser;
    const verifier = this.verifier;
    if (!actionEngine || !stateParser || !verifier) throw new NotInitializedError();

    const t0 = Date.now();
    return withSpan('sentinel.act', { 'sentinel.instruction': instruction }, async (span) => {
      let success = false;
      try {
        const retries = options?.retries ?? 2;
        let currentAttempt = 0;

        while (currentAttempt <= retries) {
          stateParser.invalidateCache();
          const stateBefore = await stateParser.parse();
          const result = await actionEngine.act(instruction, options);

          if (!result.success) {
            this.log(1, `⚠️  Action failed: ${result.message}. Attempt ${currentAttempt + 1}/${retries + 1}`);
            currentAttempt++;
            continue;
          }

          const stateAfter = await stateParser.parse();
          const verification = await verifier.verifyAction(instruction, stateBefore, stateAfter);

          if (verification.success && verification.confidence > 0.7) {
            this.log(1, `✅ "${instruction}" verified (confidence: ${(verification.confidence * 100).toFixed(0)}%)`);
            const actionResult: ActionResult = {
              success: true,
              message: verification.message,
              ...(result.action   ? { action:   result.action }   : {}),
              ...(result.selector ? { selector: result.selector } : {}),
            };
            this.recorder.record({ type: 'act', instruction, pageUrl: this.driver.getPage().url(), pageTitle: '' });
            this.emit('action', { instruction, result: actionResult });
            span.setAttributes({
              'sentinel.success': true,
              ...(actionResult.action   ? { 'sentinel.action':   actionResult.action }   : {}),
              ...(actionResult.selector ? { 'sentinel.selector': actionResult.selector } : {}),
            });
            success = true;
            return actionResult;
          } else {
            this.log(1,
              `⚠️  Verification weak (${(verification.confidence * 100).toFixed(0)}%): ${verification.message}. ` +
              `Retrying... (${currentAttempt + 1}/${retries + 1})`
            );
            currentAttempt++;
          }
        }

        const failResult: ActionResult = {
          success: false,
          message: `Failed to execute "${instruction}" after ${retries + 1} attempts.`,
        };
        span.setAttributes({ 'sentinel.success': false });
        return failResult;
      } finally {
        // Record metrics regardless of success, failure, or unexpected exception.
        actCounter.add(1, { success: String(success) });
        actDuration.record(Date.now() - t0);
      }
    });
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
    return withSpan('sentinel.extract', { 'sentinel.instruction': instruction }, () =>
      this.extractionEngine!.extract<T>(instruction, schema)
    );
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
    return withSpan(
      'sentinel.observe',
      instruction ? { 'sentinel.instruction': instruction } : {},
      () => this.observationEngine!.observe(instruction)
    );
  }

  /**
   * Save the current browser session (cookies, localStorage) to a JSON file.
   */
  async saveSession(filePath: string): Promise<void> {
    await this.driver.saveSession(filePath);
    this.log(1, `💾 Session saved to ${filePath}`);
  }

  /**
   * Open a new browser tab, optionally navigating to a URL.
   * @returns The index of the new tab.
   */
  async newTab(url?: string): Promise<number> {
    const index = await this.driver.newTab(url);
    this.stateParser?.invalidateCache();
    this.log(1, `🗂️  New tab opened (index ${index})`);
    return index;
  }

  /**
   * Switch to a tab by index.
   */
  async switchTab(index: number): Promise<void> {
    await this.driver.switchTab(index);
    this.stateParser?.invalidateCache();
    this.log(1, `🗂️  Switched to tab ${index}`);
  }

  /**
   * Close a tab by index.
   */
  async closeTab(index: number): Promise<void> {
    await this.driver.closeTab(index);
    this.stateParser?.invalidateCache();
    this.log(1, `🗂️  Tab ${index} closed`);
  }

  /** Number of open tabs */
  get tabCount(): number {
    return this.driver.tabCount;
  }

  /**
   * Extend an existing Playwright `Page` with Sentinel AI methods
   * (`act`, `extract`, `observe`).
   *
   * Creates a dedicated CDP session and engine set for the given page,
   * sharing the same LLM provider and configuration as this Sentinel instance.
   * Useful for integrating AI actions into an existing Playwright test or script.
   *
   * @example
   * // Inside a Playwright test — page comes from the test fixture
   * const ai = await sentinel.extend(page);
   * await ai.act('Click the login button');
   * const data = await ai.extract('Get all product names', z.array(z.string()));
   */
  async extend(page: Page): Promise<ExtendedPage> {
    // Detach any previous CDP session for this page to prevent leaks
    const prev = this.extendedPages.get(page);
    if (prev) await prev.detach().catch(() => {});

    const cdp = await page.context().newCDPSession(page);
    this.extendedPages.set(page, cdp);
    const stateParser = new StateParser(page, cdp);
    const actionEngine = new ActionEngine(
      page, stateParser, this.gemini,
      this.visionGrounding ?? undefined,
      this.domSettleTimeoutMs,
      this.locatorCacheInstance,
      this.maxElements,
      this.verbose,
      this.humanLike
    );
    const extractionEngine = new ExtractionEngine(page, stateParser, this.gemini);
    const observationEngine = new ObservationEngine(page, stateParser, this.gemini);

    const extended = page as ExtendedPage;
    extended.act = (instruction, options) => actionEngine.act(instruction, options);
    extended.extract = (instruction, schema) => extractionEngine.extract(instruction, schema);
    extended.observe = (instruction) => observationEngine.observe(instruction);
    return extended;
  }

  /**
   * Check if the current page has a login form.
   */
  async hasLoginForm(): Promise<boolean> {
    return this.driver.hasLoginForm();
  }

  /**
   * Take a screenshot of the current page.
   * @returns PNG image as a Buffer
   */
  async screenshot(): Promise<Buffer> {
    const buf = await this.driver.getPage().screenshot({ type: 'png', fullPage: false });
    this.log(2, '📸 Screenshot taken');
    return buf;
  }

  /**
   * Describe the current page visually using Gemini Vision.
   * Requires visionFallback: true in SentinelOptions.
   */
  async describeScreen(): Promise<string> {
    if (!this.visionGrounding) {
      throw new Error('Vision Grounding is disabled. Set visionFallback: true in SentinelOptions.');
    }
    const screenshot = await this.screenshot();
    return await this.visionGrounding.describeScreen(screenshot);
  }

  /**
   * Run an autonomous multi-step agent to achieve a high-level goal.
   *
   * @param goal     Natural language goal, e.g. "Go to Amazon, search for laptop, extract top 5 results"
   * @param options  Optional: maxSteps (default 15), onStep callback
   *
   * @example
   * const result = await sentinel.run('Search for "TypeScript" on Google and extract the first 3 results');
   */
  async run(goal: string, options?: AgentRunOptions): Promise<AgentResult> {
    if (!this.agentLoop) throw new Error('Sentinel not initialized. Call init() first.');
    this.log(1, `🤖 Agent starting: "${goal}"`);
    const result = await withSpan('sentinel.agent', {
      'sentinel.goal':      goal,
      'sentinel.max_steps': options?.maxSteps ?? 15,
    }, async (span) => {
      const r = await this.agentLoop!.run(goal, options);
      span.setAttributes({
        'sentinel.goal_achieved': r.goalAchieved,
        'sentinel.total_steps':   r.totalSteps,
      });
      agentSteps.record(r.totalSteps, { goal_achieved: String(r.goalAchieved) });
      return r;
    });
    this.log(1, `🤖 Agent finished: ${result.message}`);
    return result;
  }

  /**
   * Streaming variant of `run()` — yields each agent step as it happens, then
   * yields the final `AgentResult` when the run completes.
   *
   * Designed for Server-Sent Events (SSE) in Next.js API routes or any
   * async-iterable consumer.
   *
   * @example
   * // Next.js API route (App Router)
   * export async function GET() {
   *   const sentinel = new Sentinel({ apiKey });
   *   await sentinel.init();
   *   await sentinel.goto('https://example.com');
   *
   *   const stream = new ReadableStream({
   *     async start(controller) {
   *       for await (const event of sentinel.runStream('Find the price')) {
   *         controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
   *       }
   *       controller.close();
   *       await sentinel.close();
   *     },
   *   });
   *   return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
   * }
   */
  async *runStream(
    goal: string,
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStepEvent | AgentResult> {
    if (!this.agentLoop) throw new Error('Sentinel not initialized. Call init() first.');

    // Internal async queue for bridging the callback-based AgentLoop with AsyncGenerator
    const queue: Array<AgentStepEvent | AgentResult | Error | null> = [];
    let notify: (() => void) | null = null;

    const enqueue = (item: AgentStepEvent | AgentResult | Error | null) => {
      queue.push(item);
      notify?.();
    };

    const waitForItem = (): Promise<void> =>
      new Promise(resolve => {
        if (queue.length > 0) { resolve(); return; }
        notify = () => { notify = null; resolve(); };
      });

    // Run the agent in the background, feeding steps into the queue
    const runPromise = this.run(goal, {
      ...options,
      onStep: (step: AgentStepEvent) => {
        enqueue(step);
        options?.onStep?.(step);
      },
    }).then((result: AgentResult) => {
      enqueue(result);
      enqueue(null); // sentinel: done
    }).catch((err: unknown) => {
      enqueue(err instanceof Error ? err : new Error(String(err)));
      enqueue(null);
    });

    // Drain the queue as items arrive
    while (true) {
      await waitForItem();
      const item = queue.shift()!;
      if (item === null) break;      // done
      if (item instanceof Error) { await runPromise; throw item; }
      yield item as AgentStepEvent | AgentResult;
    }

    await runPromise;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private log(level: 0 | 1 | 2 | 3, message: string) {
    if (this.verbose >= level) {
      console.log(`[Sentinel] ${message}`);
    }
  }
}
