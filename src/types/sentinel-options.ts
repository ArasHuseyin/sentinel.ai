import type { Page } from 'playwright';
import type { ActOptions, ActionResult } from '../api/act.js';
import type { ObserveResult } from '../api/observe.js';
import type { SchemaInput } from '../utils/gemini.js';
import type { BrowserType, ProxyOptions } from '../core/driver.js';
import type { IProxyProvider } from '../utils/proxy-provider.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { Logger } from '../utils/logger.js';

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

/**
 * Every Sentinel option except the credential requirement.
 *
 * Exported so consumers can write `Partial<SentinelOptionsBase>` or extend the
 * shape; the credential rule lives in `SentinelOptions` below.
 */
export interface SentinelOptionsBase {
  /**
   * Gemini API key. Required only when no `provider` is supplied — see
   * `SentinelOptions`. Also used for `plannerModel`, which builds a
   * `GeminiProvider` under the hood.
   */
  apiKey?: string;
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
  captcha?:
    'auto' | 'skip' | 'manual' | { strategy: 'auto' | 'skip' | 'manual'; timeoutMs?: number };
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

/**
 * Options for `new Sentinel(...)`.
 *
 * Exactly one credential path must be satisfied: either a Gemini `apiKey`, or a
 * custom `provider` that brings its own credentials. `apiKey` used to be
 * unconditionally required, which forced OpenAI / Claude / Ollama users to pass
 * a dummy string for a key that was never read — and made it impossible for the
 * type system to catch a Sentinel constructed with neither.
 *
 * @example
 * new Sentinel({ apiKey: process.env.GEMINI_API_KEY! })
 * @example
 * new Sentinel({ provider: new OllamaProvider({ model: 'llama3.2' }) })
 */
export type SentinelOptions = SentinelOptionsBase &
  ({ apiKey: string } | { provider: LLMProvider });

/**
 * Runtime counterpart to the `SentinelOptions` union, for callers that reach
 * Sentinel from plain JavaScript or from a `Partial<...>` the compiler could not
 * check. Returns the key; throws with the actionable message otherwise.
 */
export function requireApiKey(options: SentinelOptionsBase, purpose: string): string {
  if (options.apiKey) return options.apiKey;
  throw new Error(
    `apiKey is required for ${purpose}. Pass { apiKey: '<gemini-key>' }, ` +
      `or supply a custom provider (e.g. { provider: new OpenAIProvider({ apiKey, model }) }).`
  );
}
