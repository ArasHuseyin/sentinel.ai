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
import { GeminiProvider } from './utils/providers/gemini-provider.js';
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
import { RateLimiter } from './utils/rate-limiter.js';
import { createLogger, type Logger } from './utils/logger.js';
import { createLocatorCache } from './core/locator-cache.js';
import { createPatternCache, type IPatternCache } from './core/pattern-cache.js';
import { detectCaptcha, describeCaptcha } from './reliability/captcha-detector.js';
import { attemptAutoSolve, type CaptchaSolverOptions } from './reliability/captcha-solver.js';
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
import { SentinelError, ActionError, ExtractionError, NavigationError, AgentError, NotInitializedError, BudgetExceededError, RateLimitError, CaptchaDetectedError } from './types/errors.js';
export { SentinelError, ActionError, ExtractionError, NavigationError, AgentError, NotInitializedError, BudgetExceededError, RateLimitError, CaptchaDetectedError };
export type { CaptchaType } from './types/errors.js';
export type { Logger, LogEvent, LogLevel, JsonSink } from './utils/logger.js';
export { ConsoleLogger, JsonLogger, createLogger, createFileSink } from './utils/logger.js';
export type { IPatternCache, PatternSequence, StoredPattern, PatternCacheStats, FingerprintLayer } from './core/pattern-cache.js';
export { InMemoryPatternCache, FilePatternCache, createPatternCache } from './core/pattern-cache.js';
export type { PatternFingerprint } from './core/pattern-signature.js';
export type { RecordedWorkflow };
export { GeminiProvider } from './utils/providers/gemini-provider.js';
export { OpenAIProvider } from './utils/providers/openai-provider.js';
export { ClaudeProvider } from './utils/providers/claude-provider.js';
export { OllamaProvider } from './utils/providers/ollama-provider.js';
export { generateTOTP } from './utils/totp.js';
import { z } from 'zod';
// Re-export z and types so users can do: import { Sentinel, z } from './index.js'
export { z };
export type { ActOptions, ActionResult, ActionAttempt, ObserveResult, AgentRunOptions, AgentResult, AgentStepEvent, BoundingBox };
export type { AIFixture } from './test/index.js';

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
   * @deprecated Use `mode` instead.
   */
  visionFallback?: boolean;
  /**
   * Element detection mode:
   *  - 'aom' (default): Accessibility Object Model via CDP. Fast and cheap.
   *  - 'hybrid': AOM primary, Vision when coordinates mismatch or AOM fails. Best reliability/cost balance.
   *  - 'vision': Screenshot + Vision LLM for every action (CUA-style). Most reliable but ~5x cost.
   */
  mode?: 'aom' | 'hybrid' | 'vision';
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
   * Enable anti-bot stealth patches on the browser launcher. Requires the
   * optional peer dependencies `playwright-extra` and
   * `puppeteer-extra-plugin-stealth` to be installed:
   *
   * ```
   * npm install playwright-extra puppeteer-extra-plugin-stealth
   * ```
   *
   * Patches applied: `navigator.webdriver = false`, WebGL fingerprint
   * normalization, Chrome runtime presence, plugins/mimeTypes coherence,
   * Permissions API determinism, Accept-Language / platform alignment.
   *
   * Impact: reduces CAPTCHA encounter rates on bot-gated sites by roughly
   * 90%. Preferable to configuring a CAPTCHA solver because most CAPTCHAs
   * never appear in the first place.
   *
   * Falls back gracefully to plain Playwright with a console warning if
   * the peer deps aren't installed.
   *
   * Default: `false`.
   */
  stealth?: boolean;
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
   * Separate LLM provider for the agent planner. Allows using a stronger model
   * for planning decisions while keeping a faster/cheaper model for act/extract.
   * @example new GeminiProvider({ apiKey: '...', model: 'gemini-3.1-pro-preview' })
   */
  plannerProvider?: LLMProvider;
  /**
   * Gemini model name for the planner (shorthand for plannerProvider).
   * Creates a GeminiProvider with this model name using the same API key.
   * @example 'gemini-3.1-pro-preview'
   */
  plannerModel?: string;
  /**
   * MFA/TOTP configuration for automated 2FA login flows.
   * When set, the agent automatically generates TOTP codes when it encounters
   * a verification code field during a login flow.
   * @example { type: 'totp', secret: 'JBSWY3DPEHPK3PXP' }
   */
  mfa?: { type: 'totp'; secret: string; digits?: number; period?: number };
  /**
   * How long (ms) to wait for the DOM to settle after navigation/actions
   * (default: 5000, hard-capped internally at 8000). Settling uses a
   * two-signal strategy: MutationObserver silence (~300 ms) AND no
   * visible loading indicators (aria-busy, progressbar, skeleton,
   * spinner, loading classes). Modern SPAs often need 3-5 s for GraphQL
   * hydration — raising from the old 3 s default fixes silent stale-state
   * issues on Shopify, Airbnb, and similar apps.
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
  /**
   * Hard cap on total tokens (input + output) across all LLM calls in this
   * instance's lifetime. Once exceeded, the next LLM call throws
   * `BudgetExceededError`. Prevents runaway agent loops from burning budget
   * during dev/CI or when a page pattern confuses the planner.
   */
  maxTokens?: number;
  /**
   * Hard cap on estimated USD cost across all LLM calls, derived from the
   * model's pricing table in `TokenTracker`. Same semantics as `maxTokens`.
   */
  maxCostUsd?: number;
  /**
   * Per-hostname navigation rate limit (requests per second). Applied inside
   * `Sentinel.goto()`. Omit (or 0) to disable. Default: unlimited.
   *
   * Example: `rateLimit: 2` throttles `goto('https://amazon.com/...')` to at
   * most two requests per second regardless of how many parallel workers
   * target the host, while other domains are unaffected.
   */
  rateLimit?: number;
  /**
   * Structured logging mode:
   *  false / omitted — legacy plain-text `console.log` (default)
   *  true            — JSON lines written to stdout, one object per event
   *  string          — JSON lines appended to this file path
   *
   * Verbose level still gates which events are emitted. Warnings bypass the
   * filter in both modes. Use `logger` for a custom transport (Pino, Winston,
   * OpenTelemetry log exporter, etc.).
   */
  logFormat?: false | true | string;
  /**
   * Inject a fully custom logger. Overrides `logFormat` entirely.
   * Useful for routing logs through Pino, Winston, or your own transport.
   */
  logger?: Logger;
  /**
   * File path for persistent cost audit. When set, every LLM token usage
   * entry is flushed to this file as JSON — survives process restarts and
   * is mergeable across parallel runs.
   *
   * Omit for in-memory only (default — matches prior behaviour).
   */
  costAuditPath?: string;
  /**
   * CAPTCHA handling strategy. When Sentinel detects a CAPTCHA blocking
   * an action, one of these strategies runs before `CaptchaDetectedError`
   * is surfaced:
   *
   *  `'auto'` (default) — built-in solver: click the reCAPTCHA v2
   *     checkbox and/or wait for Turnstile's proof-of-work to resolve.
   *     Works for the subset that solves "for free" (~50-70% in the
   *     wild). No external API keys required.
   *  `'skip'` — detect only, don't attempt to solve. The error surfaces
   *     with the exact CAPTCHA type so callers can route to their own
   *     solver (2captcha, CapSolver, etc.).
   *  `'manual'` — headful only: pause action and poll until the human
   *     solves the CAPTCHA in the browser, then resume.
   *
   * Or pass an object to override the per-attempt `timeoutMs` (default 20s).
   */
  captcha?: 'auto' | 'skip' | 'manual' | { strategy: 'auto' | 'skip' | 'manual'; timeoutMs?: number };
  /**
   * Cross-site widget-pattern cache. Fingerprints interactive widgets by
   * ARIA / library-class / DOM-topology and reuses successful interaction
   * sequences across ANY site that renders the same widget shape:
   *
   *  true (default)  — in-memory cache, cleared when the instance closes.
   *                    Every act() that succeeds populates the cache; repeat
   *                    interactions within the same session skip the LLM.
   *  false           — disabled entirely (no fingerprinting overhead)
   *  string          — file path for JSON persistence across runs. Patterns
   *                    survive restarts and can be pre-seeded from a benchmark
   *                    run (→ zero-token hits on known widgets from Day 1).
   *
   * Unlike `locatorCache` (which is URL-scoped), patterns transfer between
   * sites: a DatePicker interaction learned on site A works on site B.
   * Sensitive-field values (password / tel) are redacted before persist.
   * On cache miss the LLM path runs as normal — no behaviour change.
   */
  patternCache?: false | true | string;
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
  private plannerLLM: LLMProvider | null = null;
  private readonly visionFallback: boolean;
  private readonly mode: 'aom' | 'hybrid' | 'vision';
  private readonly mfaConfig: { type: 'totp'; secret: string; digits?: number; period?: number } | undefined;
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
  private readonly patternCacheInstance: IPatternCache | null;
  private readonly rateLimiter: RateLimiter | null;
  private readonly logger: Logger;
  private readonly captchaOption: 'auto' | 'skip' | 'manual' | { strategy: 'auto' | 'skip' | 'manual'; timeoutMs?: number };
  private _tokenUsageCallback: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;

  constructor(options: SentinelOptions) {
    super();
    const driverOptions: DriverOptions = {
      headless: options.headless ?? false,
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.humanLike ? { humanLike: options.humanLike } : {}),
      ...(options.stealth ? { stealth: options.stealth } : {}),
      ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
      ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
    };
    this.driver = new SentinelDriver(driverOptions);
    // Use custom provider if supplied, otherwise fall back to GeminiService
    this.gemini = (options.provider as any) ?? new GeminiService(options.apiKey);
    this.verbose = options.verbose ?? 1;
    this.logger = createLogger(options.logFormat ?? false, this.verbose, options.logger).child('Sentinel');
    this.enableCaching = options.enableCaching ?? true;
    this.domSettleTimeoutMs = options.domSettleTimeoutMs ?? 5000;
    this.maxElements = options.maxElements ?? 50;
    this.humanLike = options.humanLike ?? false;
    // mode: 'hybrid' and 'vision' both enable vision grounding
    this.mode = options.mode ?? 'aom';
    this.visionFallback = options.visionFallback ?? (this.mode === 'hybrid' || this.mode === 'vision');
    this.mfaConfig = options.mfa;
    this.locatorCacheInstance = createLocatorCache(options.locatorCache ?? false);
    this.promptCacheInstance = createPromptCache(options.promptCache ?? false);
    this.patternCacheInstance = createPatternCache(options.patternCache ?? true);
    this.apiKey = options.apiKey;
    this.recorder = new WorkflowRecorder();
    this.tokenTracker = new TokenTracker(
      process.env.GEMINI_VERSION ?? 'gemini-3-flash-preview',
      {
        budget: {
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
        },
        ...(options.costAuditPath !== undefined ? { persistPath: options.costAuditPath } : {}),
      }
    );
    this.captchaOption = options.captcha ?? 'auto';
    this.rateLimiter = options.rateLimit && options.rateLimit > 0
      ? new RateLimiter(options.rateLimit)
      : null;

    // Separate planner LLM (optional — uses stronger model for planning decisions)
    if (options.plannerProvider) {
      this.plannerLLM = options.plannerProvider;
    } else if (options.plannerModel) {
      this.plannerLLM = new GeminiProvider({ apiKey: options.apiKey, model: options.plannerModel });
    }

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
      this.visionGrounding = new VisionGrounding(this.gemini, this.verbose);
    }
    this.actionEngine = new ActionEngine(page, this.stateParser, this.gemini, this.visionGrounding ?? undefined, this.domSettleTimeoutMs, this.locatorCacheInstance, this.maxElements, this.verbose, this.humanLike, this.mode, this.patternCacheInstance);
    this.extractionEngine = new ExtractionEngine(page, this.stateParser, this.gemini);
    this.observationEngine = new ObservationEngine(page, this.stateParser, this.gemini);
    this.verifier = new Verifier(page, this.stateParser, this.gemini);
    this.agentLoop = new AgentLoop(this.actionEngine, this.extractionEngine, this.stateParser, this.gemini, page, this.visionGrounding ?? undefined, this.plannerLLM ?? undefined, this.mfaConfig, this.logger);

    this.log(1, '🚀 Sentinel initialized');
  }

  async goto(url: string) {
    if (this.rateLimiter) {
      try {
        const hostname = new URL(url).hostname;
        if (hostname) await this.rateLimiter.acquire(hostname);
      } catch {
        // Invalid URL — let driver.goto surface the real navigation error.
      }
    }
    await this.driver.goto(url);
    this.stateParser?.invalidateCache();
    this.recorder.record({ type: 'goto', url, pageUrl: url, pageTitle: '' });

    // Proactive blocker dismissal. Cookie/consent banners and third-party
    // overlay widgets are almost universally present on commercial pages and
    // silently block subsequent interactions — the previous reactive-only
    // flow paid two extra LLM calls and one act-retry before the recovery
    // path fired. Clearing them here (once per goto) fixes the false-positive
    // chain observed on mui.com / amazon.de / reddit.com during live testing
    // and gives extract() a clean viewport from the first call.
    if (this.actionEngine && this.stateParser) {
      try {
        const state = await this.stateParser.parse();
        const dismissed = await this.actionEngine.tryRecoverFromBlocker(state);
        if (dismissed) {
          this.stateParser.invalidateCache();
          this.log(1, '🍪 Blocker dismissed after navigation');
        }
      } catch (err: any) {
        this.log(2, `[goto] Proactive blocker dismissal skipped: ${err.message}`);
      }
    }

    this.emit('navigate', { url });
    this.log(1, `🌐 Navigated to ${url}`);
  }

  async close() {
    const provider = this.gemini as any;
    if (this._tokenUsageCallback && typeof provider === 'object' && provider !== null) {
      provider.onTokenUsage = undefined;
      this._tokenUsageCallback = undefined;
    }
    // Flush any pending locator-cache writes before releasing the browser, so
    // debounced entries make it to disk even on short-lived runs.
    if (this.locatorCacheInstance?.flush) {
      await this.locatorCacheInstance.flush().catch(() => { /* best-effort */ });
    }
    this.locatorCacheInstance?.close?.();
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
        if (sentinel) {
          try {
            await sentinel.close();
          } catch (closeErr: any) {
            // Don't let a close failure propagate — we still want the other tasks to finish
            // and the caller to see the task result. But surface it so zombie browsers
            // don't stay silently undetected.
            if ((options.verbose ?? 1) >= 1) {
              console.warn(`[Sentinel.parallel] close() failed for task ${index} (${task.url}): ${closeErr?.message ?? closeErr}`);
            }
          }
        }
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
        let captchaSolveAttempts = 0;
        const captchaCfg: CaptchaSolverOptions = typeof this.captchaOption === 'string'
          ? { strategy: this.captchaOption }
          : this.captchaOption;
        // Verifier-rejection feedback accumulated across retry attempts, so the
        // planner can escalate strategy instead of repeating the same action.
        const previousFailures: string[] = [];

        while (currentAttempt <= retries) {
          stateParser.invalidateCache();
          const stateBefore = await stateParser.parse();
          let result;
          try {
            const attemptOptions: ActOptions & { retries?: number } = {
              ...(options ?? {}),
              ...(previousFailures.length > 0 ? { previousFailures } : {}),
            };
            result = await actionEngine.act(instruction, attemptOptions);
          } catch (err: any) {
            // CAPTCHA detected mid-action: try the configured solver once,
            // then retry. If the solver can't clear it, surface the error
            // so the caller can route to an external service.
            if (err instanceof CaptchaDetectedError && captchaSolveAttempts === 0) {
              captchaSolveAttempts++;
              this.log(1, `🧩 ${describeCaptcha(err.type, (err.context?.captchaSource) as string | undefined)}`);
              this.log(2, `[Captcha] attempting ${captchaCfg.strategy ?? 'auto'} strategy...`);
              const solved = await attemptAutoSolve(this.driver.getPage(), err.type, captchaCfg);
              if (solved) {
                this.log(1, `✅ CAPTCHA cleared, retrying action`);
                continue; // re-enter while loop with same currentAttempt
              }
              this.log(1, `❌ CAPTCHA solve failed — surfacing ${err.type} error`);
            }
            throw err;
          }

          if (!result.success) {
            this.log(1, `⚠️  Action failed: ${result.message}. Attempt ${currentAttempt + 1}/${retries + 1}`);
            previousFailures.push(`Action did not execute: ${result.message}`);
            currentAttempt++;
            continue;
          }

          // Skip verification for scroll actions — scroll never fails and produces
          // no meaningful state diff (the verifier already handles this as fast path 3,
          // but skipping the extra parse saves time).
          const isScrollAction = /scroll/i.test(result.action ?? '');
          if (isScrollAction) {
            this.log(1, `✅ "${instruction}" completed (scroll — skipping verification)`);
            const actionResult: ActionResult = {
              success: true,
              message: result.message,
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
          }

          const stateAfter = await stateParser.parse();
          // Pass the technical action label (e.g. 'click on "Switch demo" (checkbox)')
          // rather than the user instruction ('Toggle the first switch') so the
          // verifier's fast-paths can detect the target role accurately.
          const verification = await verifier.verifyAction(result.action ?? instruction, stateBefore, stateAfter, instruction);

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
            // Record what the planner just did and why the verifier rejected it,
            // so the next attempt can escalate (e.g. fill → press Enter) rather
            // than repeat the same action.
            const executedAction = result.action ?? 'unknown action';
            previousFailures.push(`Tried: ${executedAction}. Verifier rejected: ${verification.message}`);
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
   * Intercept network responses matching a URL pattern while performing an action.
   * Captures the raw API data (JSON) instead of scraping the DOM — more reliable,
   * structured, and complete.
   *
   * @param urlPattern  Glob pattern to match response URLs (e.g. 'api/search')
   * @param trigger     Action that triggers the network request
   * @returns           Array of intercepted response bodies (parsed JSON or raw text)
   */
  async intercept<T = any>(urlPattern: string, trigger: () => Promise<any>): Promise<T[]> {
    if (!this.actionEngine) throw new Error('Sentinel not initialized. Call init() first.');
    const page = this.driver.getPage();
    const captured: T[] = [];

    const handler = async (response: any) => {
      try {
        const url = response.url();
        // Match URL pattern (convert glob to simple matching)
        const pattern = urlPattern
          .replace(/\*\*/g, '___GLOBSTAR___')
          .replace(/\*/g, '___STAR___')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/___GLOBSTAR___/g, '.*')
          .replace(/___STAR___/g, '[^/]*');
        if (!new RegExp(pattern).test(url)) return;

        const contentType = response.headers()['content-type'] ?? '';
        if (contentType.includes('json')) {
          const body = await response.json().catch(() => null);
          if (body) captured.push(body);
        } else {
          const text = await response.text().catch(() => null);
          if (text) captured.push(text as any);
        }
      } catch {
        // Response body not available (e.g. redirects, streams)
      }
    };

    page.on('response', handler);
    try {
      await trigger();
      // Wait for async/lazy-loaded responses. Use networkidle if possible,
      // fall back to fixed timeout. This catches GraphQL calls that fire
      // after the initial page navigation completes.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500); // extra buffer for late responses
    } finally {
      page.off('response', handler);
    }

    this.log(1, `🔌 Intercepted ${captured.length} response(s) matching "${urlPattern}"`);
    return captured;
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
    if (prev) {
      try {
        await prev.detach();
      } catch (err: any) {
        // Session may already be stale (page closed, target detached upstream).
        // Log at verbose >= 2 so we see it during debugging but don't spam prod.
        this.log(2, `[Sentinel.extend] Previous CDP session detach failed: ${err?.message ?? err}`);
      }
    }

    const cdp = await page.context().newCDPSession(page);
    this.extendedPages.set(page, cdp);
    const stateParser = new StateParser(page, cdp);
    const mode = this.visionFallback ? (this.visionGrounding ? 'hybrid' : 'aom') : 'aom';
    const actionEngine = new ActionEngine(
      page, stateParser, this.gemini,
      this.visionGrounding ?? undefined,
      this.domSettleTimeoutMs,
      this.locatorCacheInstance,
      this.maxElements,
      this.verbose,
      this.humanLike,
      mode,
      this.patternCacheInstance
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
   * Fill a form declaratively with a JSON object. Sentinel automatically maps
   * JSON keys to form fields via LLM and fills them — one call, no step-by-step.
   *
   * @param data     Key-value pairs to fill into the form (e.g. { brand: 'BMW', year: 2020 })
   * @param options  Optional: maxSteps for the internal agent loop
   *
   * @example
   * await sentinel.fillForm({
   *   brand: 'BMW', model: '4er', year: 2020,
   *   fuel: 'Benzin', postalCode: '1010'
   * });
   */
  async fillForm(data: Record<string, string | number | boolean>, options?: { maxSteps?: number }): Promise<AgentResult> {
    if (!this.agentLoop) throw new Error('Sentinel not initialized. Call init() first.');

    // Build a natural language goal from the JSON data
    const fieldList = Object.entries(data)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');

    const goal =
      `Fill the form on this page with the following data:\n${fieldList}\n\n` +
      `Match each key to the most appropriate form field by meaning (keys may be in a different language than the form labels). ` +
      `Fill all fields top-to-bottom, then click the submit/next button if one is visible.`;

    this.log(1, `📝 fillForm: ${Object.keys(data).length} fields`);
    return this.run(goal, { maxSteps: options?.maxSteps ?? 15 });
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
    this.log(1, `✔️ Agent finished: ${result.message}`);
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
    // Delegates to the configured Logger so verbose-gating semantics are
    // preserved while also enabling structured/JSON output when opted in.
    if (level === 0) return;
    if (level === 1) this.logger.info(message);
    else if (level === 2) this.logger.notice(message);
    else this.logger.debug(message);
  }
}
