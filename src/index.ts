import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { Page, BrowserContext } from 'playwright';
import { SentinelDriver } from './core/driver.js';
import type { DriverOptions, BrowserType, ProxyOptions } from './core/driver.js';
export type { BrowserType, ProxyOptions };
import { StateParser } from './core/state-parser.js';
import { ActionEngine } from './api/act.js';
import type { ActOptions, ActionResult } from './api/act.js';
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
export type { ActOptions, ActionResult, ObserveResult, AgentRunOptions, AgentResult, AgentStepEvent, BoundingBox };

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
   * Enable Vision Grounding fallback via Gemini Vision when AOM cannot find an element (default: false).
   */
  visionFallback?: boolean;
  /**
   * Browser engine to use (default: 'chromium'). Firefox and WebKit do not support CDP/AOM.
   */
  browser?: BrowserType;
  /**
   * Proxy configuration.
   */
  proxy?: ProxyOptions;
  /**
   * Add random human-like delays between actions (default: false).
   */
  humanLike?: boolean;
  /**
   * Path to a session file to load/save cookies & storage state.
   */
  sessionPath?: string;
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

  private readonly verbose: 0 | 1 | 2;
  private readonly enableCaching: boolean;
  private readonly domSettleTimeoutMs: number;

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
    this.visionFallback = options.visionFallback ?? false;
    this.apiKey = options.apiKey;
    this.recorder = new WorkflowRecorder();
    this.tokenTracker = new TokenTracker(process.env.GEMINI_VERSION ?? 'gemini-3-flash-preview');
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
    if (this.visionFallback) {
      this.visionGrounding = new VisionGrounding(this.gemini);
    }
    this.actionEngine = new ActionEngine(page, this.stateParser, this.gemini, this.visionGrounding ?? undefined);
    this.extractionEngine = new ExtractionEngine(page, this.stateParser, this.gemini);
    this.observationEngine = new ObservationEngine(page, this.stateParser, this.gemini);
    this.verifier = new Verifier(page, this.stateParser, this.gemini);
    this.agentLoop = new AgentLoop(this.actionEngine, this.stateParser, this.gemini);

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
    await this.driver.close();
    this.emit('close');
    this.log(1, '🔒 Sentinel closed');
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
        const actionResult = { success: true, message: verification.message, ...(result.action ? { action: result.action } : {}) };
        this.recorder.record({ type: 'act', instruction, pageUrl: this.driver.getPage().url(), pageTitle: '' });
        this.emit('action', { instruction, result: actionResult });
        return actionResult;
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
    const result = await this.agentLoop.run(goal, options);
    this.log(1, `🤖 Agent finished: ${result.message}`);
    return result;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private log(level: 0 | 1 | 2, message: string) {
    if (this.verbose >= level) {
      console.log(`[Sentinel] ${message}`);
    }
  }
}
