import type { Frame, Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement, SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { VisionGrounding } from '../core/vision-grounding.js';
import type { ILocatorCache } from '../core/locator-cache.js';
import type { IPatternCache } from '../core/pattern-cache.js';
import type { PatternFingerprint } from '../core/pattern-signature.js';
import { generateSelector } from '../core/selector-generator.js';
import { withTimeout } from '../utils/with-timeout.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { ActionError, CaptchaDetectedError } from '../types/errors.js';
import { detectCaptcha, describeCaptcha } from '../reliability/captcha-detector.js';

import type { ActOptions, ActionAttempt, ActionResult, ActionType } from './act/types.js';
import { waitForPageSettle } from './act/page-settle.js';
import { moveMouse } from './act/mouse.js';
import { buildFailureMessage } from './act/diagnostics.js';
import { filterRelevantElements } from './act/chunking.js';
import { PatternCacheCoordinator } from './act/pattern-cache.js';
import { BlockerRecovery } from './act/blocker-recovery.js';
import { clickLocator as clickLocatorFn } from './act/click-locator.js';
import { interpolateVariables, redactVariables, containsSecret } from './act/secrets.js';
import {
  documentCentroid,
  hasImpossibleCoordinates,
  resolveViewportPoint,
  readLabelAtPoint,
  isCoordinateMismatch,
  type ViewportPoint,
} from './act/coordinates.js';
import { fillSlider } from './act/slider.js';
import { fillDateLike } from './act/date-fill.js';
import { fillText, appendText } from './act/text-fill.js';
import { performSelect } from './act/select-action.js';
import { ignoreRejection } from '../utils/ignore-rejection.js';
import { isListboxPopoverVisible } from './act/dropdown.js';

// Public re-exports — consumers import these from '../api/act.js'.
export type { ActOptions, ActionAttempt, ActionResult, ActionType } from './act/types.js';
export type { DateParts } from './act/datepicker.js';
export { filterRelevantElements } from './act/chunking.js';
export { parseDateValue, formatNativeInputValue } from './act/datepicker.js';

/** Max retries after the LLM signals `notFound: true` (one scroll + re-ask per retry). */
const MAX_NOT_FOUND_SCROLL_RETRIES = 1;

/** Scroll step used when the LLM signals the target is not visible, as a fraction of viewport height. */
const NOT_FOUND_SCROLL_FRACTION = 0.8;

/**
 * Stable system instruction for action-decision LLM calls. Extracted to a module
 * constant so every act() in a session ships the exact same system text — that's
 * what lets Gemini's implicit caching, OpenAI's auto prompt cache, and Anthropic's
 * cache_control reuse the prefix and discount it on hits. Per-call variables
 * (URL, title, instruction, elements) stay in the user prompt.
 */
const ACT_SYSTEM_INSTRUCTION = `
You are a browser-automation action planner. Given a user instruction and the list of interactive elements on the current page, decide which element(s) to interact with and how.

Return up to 3 candidate elements ranked by confidence (best first).

Available actions:
- "click": single click on an element
- "double-click": double click on an element
- "right-click": right-click (context menu) on an element
- "fill": type text into an input field (requires "value")
- "append": add text to the end of an input field without clearing existing content (requires "value")
- "hover": move mouse over an element
- "press": press a keyboard key or shortcut (requires "value", e.g. "Enter", "Escape", "Tab", "Control+a")
- "select": pick an option from ANY dropdown — native <select> OR any element whose role is combobox/listbox (requires "value" = option text). This is a one-shot that opens the dropdown, filters to the option, and commits the selection. ALWAYS prefer "select" over "click" when the target is a dropdown and you know which option to pick — "click" only opens the dropdown and leaves you mid-flow.
- "upload": upload file(s) to an <input type="file"> (requires "value" = absolute path; for multiple files comma-separate: "/a.pdf,/b.pdf"). Prefer this over "click" for elements with role="file".
- "drag": drag one element onto another (requires "targetElementId" = the drop-target element id). Use for reorderable lists, kanban boards, file-manager style drops.
- "scroll-down": scroll the page down (elementId optional, use 0 if no specific element)
- "scroll-up": scroll the page up (elementId optional, use 0 if no specific element)
- "scroll-to": scroll to bring a specific element into view (requires elementId)

If the action is "fill", "append", "press", "select", or "upload", provide the "value" field.
If the action is "drag", provide the "targetElementId" field (the id of the drop target).
For scroll actions without a target element, set elementId to 0 in the first candidate.

If NONE of the listed elements is plausibly the target of the instruction (e.g. the target is likely off-screen, inside a collapsed section, or not yet rendered), set "notFound": true and leave candidates empty. Do NOT invent element IDs. The system will scroll once and re-ask.
`.trim();

/**
 * Optional wiring for {@link ActionEngine}.
 *
 * These used to be eight positional constructor parameters, which meant every
 * full call site was an unlabelled `(…, undefined, 3000, null, 50, 0, false,
 * 'aom', cache)` tail that had to be read against the signature to understand —
 * and adding a ninth would have been a silent-breakage hazard for anyone
 * passing them by position.
 */
export interface ActionEngineOptions {
  visionGrounding?: VisionGrounding | undefined;
  /** How long to wait for the DOM to settle after an action. Default 3000 ms. */
  domSettleTimeoutMs?: number;
  locatorCache?: ILocatorCache | null;
  /** Maximum elements sent to the LLM. Pages with more are pre-filtered by relevance. */
  maxElements?: number;
  /**
   * Verbosity level inherited from SentinelOptions:
   *  0 = silent
   *  1 = action summary only (default)
   *  2 = + reasoning + fallback warnings
   *  3 = + chunk-processing stats + full LLM decision
   */
  verbose?: 0 | 1 | 2 | 3;
  /** When true, mouse moves along a Bézier curve and per-action delays are added. */
  humanLike?: boolean;
  /**
   * Element detection mode:
   *  'aom' (default) — AOM coordinates, vision only as late fallback
   *  'hybrid' — AOM primary, vision on coordinate mismatch
   *  'vision' — Vision as primary, AOM as fallback
   */
  mode?: 'aom' | 'hybrid' | 'vision';
  /**
   * Cross-site widget pattern cache. When present, each `act()` call
   * first fingerprints the top relevant elements and probes the cache
   * — a hit routes past the LLM entirely. Successful and failed
   * actions write back to build up the library of learned patterns.
   */
  patternCache?: IPatternCache | null;
  /** Sink for action diagnostics. Defaults to a console logger at `verbose`. */
  logger?: Logger;
}

export class ActionEngine {
  private readonly logger: Logger;
  private readonly visionGrounding: VisionGrounding | undefined;
  private readonly domSettleTimeoutMs: number;
  private readonly locatorCache: ILocatorCache | null;
  private readonly maxElements: number;
  private readonly verbose: 0 | 1 | 2 | 3;
  private readonly humanLike: boolean;
  private readonly mode: 'aom' | 'hybrid' | 'vision';

  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider,
    options: ActionEngineOptions = {}
  ) {
    this.verbose = options.verbose ?? 0;
    this.logger = (options.logger ?? createLogger(false, this.verbose)).child('Act');
    this.visionGrounding = options.visionGrounding;
    this.domSettleTimeoutMs = options.domSettleTimeoutMs ?? 3000;
    this.locatorCache = options.locatorCache ?? null;
    this.maxElements = options.maxElements ?? 50;
    this.humanLike = options.humanLike ?? false;
    this.mode = options.mode ?? 'aom';

    this.patternCoord = new PatternCacheCoordinator(
      this.page,
      this.stateParser,
      options.patternCache ?? null,
      (l, m) => this.log(l, m),
      (l, m) => this.warn(l, m),
      this.domSettleTimeoutMs
    );
    this.blockerRecovery = new BlockerRecovery(
      this.page,
      (l, m) => this.log(l, m),
      (l, m) => this.warn(l, m),
      this.domSettleTimeoutMs
    );
  }

  private readonly patternCoord: PatternCacheCoordinator;
  private readonly blockerRecovery: BlockerRecovery;

  /** Level maps onto the shared verbose scale: 1 = info, 2 = notice, 3 = debug. */
  private log(level: 1 | 2 | 3, message: string): void {
    if (level >= 3) this.logger.debug(message);
    else if (level === 2) this.logger.notice(message);
    else this.logger.info(message);
  }

  /**
   * The verbose gate stays here rather than in the logger: `Logger.warn` is
   * contractually always-on (a warning must not be silently dropped), but
   * `verbose: 0` on the engine means silent. Honour the engine's contract by
   * not raising the warning at all below the threshold.
   */
  private warn(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) this.logger.warn(message);
  }

  /** Thin wrapper around the standalone `clickLocator` helper that injects the warn logger. */
  private async clickLocator(
    locator: import('playwright').Locator,
    options: { timeout?: number } = {}
  ): Promise<void> {
    return clickLocatorFn(locator, options, (l, m) => this.warn(l, m));
  }

  /**
   * Proactively dismisses blocking overlays (cookie banners, vendor
   * popups, generic modals) so subsequent actions can proceed. Exposed
   * publicly because `Sentinel.goto()` invokes it once per navigation.
   */
  async tryRecoverFromBlocker(state: SimplifiedState): Promise<boolean> {
    return this.blockerRecovery.tryRecover(state, (action, target) =>
      this.performAction(action, target)
    );
  }

  /**
   * Executes an action against an element that lives inside an iframe.
   *
   * Uses Playwright's frame-scoped locator API — `frame.getByRole(...)`
   * resolves within the frame's document, so the resulting click / fill /
   * keystroke is routed to the correct context without coordinate math.
   * The `[frame] ` prefix the parser adds for LLM visibility is stripped
   * before locator lookup because the element inside the iframe does not
   * carry that literal accessible name.
   *
   * Limitations (intentional for this iteration):
   *   - No slider / datepicker cascade inside frames — relies on direct fill.
   *   - No vision-grounding fallback inside frames.
   *   - No locator cache for frame elements (frameId is parse-local).
   */
  /**
   * Uploads file(s) to an `<input type="file">` via Playwright's
   * `locator.setInputFiles()`. Accepts a single absolute path or a
   * comma-separated list for multi-file uploads. Works with visually
   * hidden inputs — no click is dispatched.
   *
   * Locator resolution cascades through: accessible label → name/id/aria-label
   * attribute match → first file input in the context. This covers labeled
   * inputs, named inputs, and minimalist pages with a single file control.
   */
  private async performUpload(
    ctx: Page | Frame,
    target: UIElement,
    value: string | undefined
  ): Promise<void> {
    const paths = (value ?? '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      throw new ActionError('upload requires a file path in "value"', {
        element: target.name,
        action: 'upload',
      });
    }

    const escape = (s: string) => s.replace(/"/g, '\\"');
    const n = escape(target.name);
    const strategies: Array<() => ReturnType<typeof ctx.locator>> = [
      () => ctx.getByLabel(target.name, { exact: false }),
      () => ctx.locator(`input[type="file"][name="${n}"]`),
      () => ctx.locator(`input[type="file"][id="${n}"]`),
      () => ctx.locator(`input[type="file"][aria-label="${n}"]`),
      () => ctx.locator('input[type="file"]'),
    ];

    let lastErr: unknown;
    for (const build of strategies) {
      try {
        await build().first().setInputFiles(paths, { timeout: 3000 });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new ActionError(
      `Could not locate a file input for "${target.name}": ${(lastErr as Error)?.message ?? 'no strategy succeeded'}`,
      { element: target.name, action: 'upload' }
    );
  }

  /**
   * Drags the source element onto the drop target via Playwright's
   * `locator.dragTo()`, which dispatches the full HTML5 drag sequence
   * (dragstart → dragover on target → drop) and handles autoscroll when
   * the target is off-screen. Works for kanban boards, reorderable lists,
   * and file-manager-style drops.
   */
  private async performDrag(
    ctx: Page | Frame,
    source: UIElement,
    dropTarget: UIElement
  ): Promise<void> {
    const FRAME_PREFIX = '[frame] ';
    const strip = (s: string) => (s.startsWith(FRAME_PREFIX) ? s.slice(FRAME_PREFIX.length) : s);

    const srcLocator = ctx
      .getByRole(source.role as Parameters<Page['getByRole']>[0], {
        name: strip(source.name),
        exact: false,
      })
      .first();
    const dstLocator = ctx
      .getByRole(dropTarget.role as Parameters<Page['getByRole']>[0], {
        name: strip(dropTarget.name),
        exact: false,
      })
      .first();

    await srcLocator.dragTo(dstLocator, { timeout: 10_000 });
  }

  private async executeInFrame(
    frame: Frame,
    action: ActionType,
    target: UIElement,
    value?: string,
    dropTarget?: UIElement | null
  ): Promise<void> {
    const FRAME_PREFIX = '[frame] ';
    const nameInFrame = target.name.startsWith(FRAME_PREFIX)
      ? target.name.slice(FRAME_PREFIX.length)
      : target.name;

    const locator = frame
      .getByRole(target.role as Parameters<Frame['getByRole']>[0], {
        name: nameInFrame,
        exact: false,
      })
      .first();

    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(ignoreRejection);

    switch (action) {
      case 'click':
        await this.clickLocator(locator, { timeout: 10_000 });
        break;
      case 'double-click':
        await locator.dblclick({ timeout: 10_000 });
        break;
      case 'right-click':
        await locator.click({ button: 'right', timeout: 10_000 });
        break;
      case 'hover':
        await locator.hover({ timeout: 10_000 });
        break;
      case 'fill':
        await locator.fill(value ?? '', { timeout: 10_000 });
        break;
      case 'append':
        await locator.focus({ timeout: 10_000 });
        await this.page.keyboard.press('End');
        await this.page.keyboard.type(value ?? '', { delay: 90 });
        break;
      case 'press':
        await locator.focus({ timeout: 10_000 });
        await this.page.keyboard.press(value || 'Enter');
        break;
      case 'select':
        // Native <select> → selectOption; custom dropdown → click + type + Enter.
        try {
          await locator.selectOption(value ?? '', { timeout: 3000 });
        } catch {
          await this.clickLocator(locator, { timeout: 5000 });
          if (value) {
            await this.page.keyboard.type(value, { delay: 90 });
            await frame.waitForTimeout(300);
            await this.page.keyboard.press('Enter');
          }
        }
        break;
      case 'scroll-down':
        await frame.evaluate(() => {
          window.scrollBy(0, 300);
        });
        break;
      case 'scroll-up':
        await frame.evaluate(() => {
          window.scrollBy(0, -300);
        });
        break;
      case 'scroll-to':
        // scrollIntoViewIfNeeded already ran above; nothing more to do.
        break;
      case 'upload':
        await this.performUpload(frame, target, value);
        break;
      case 'drag':
        if (!dropTarget) {
          throw new ActionError('drag requires a drop-target element', { action });
        }
        if (dropTarget.frameId && dropTarget.frameId !== target.frameId) {
          throw new ActionError(
            'Cross-frame drag is not supported — source and drop target must share the same frame',
            { source: target.name, target: dropTarget.name }
          );
        }
        await this.performDrag(frame, target, dropTarget);
        break;
    }
  }

  /**
   * Writes a successful locator into the self-healing cache with any
   * variable-derived value redacted back to its `%placeholder%`.
   *
   * `containsSecret` is a belt-and-braces check: if redaction did not fully
   * cover the value (a variable shorter than the substring threshold embedded in
   * a longer string, say), the value is dropped entirely rather than persisted.
   * Losing a cached fill value costs one LLM call on the next run; leaking it
   * costs a credential.
   */
  private cacheLocator(
    url: string,
    keyInstruction: string,
    target: UIElement,
    decision: { action: ActionType; value?: string },
    variables?: Record<string, string>
  ): void {
    if (!this.locatorCache) return;
    let value =
      decision.value === undefined ? undefined : redactVariables(decision.value, variables);
    if (value !== undefined && containsSecret(value, variables)) value = undefined;
    this.locatorCache.set(url, keyInstruction, {
      action: decision.action,
      role: target.role,
      name: target.name,
      ...(value !== undefined ? { value } : {}),
    });
  }

  async act(instruction: string, options?: ActOptions): Promise<ActionResult> {
    const variables = options?.variables;
    const resolvedInstruction = interpolateVariables(instruction, variables);
    // Caches key on the *template*, never the resolved text. The resolved form
    // contains whatever the caller passed as a variable — passwords, TANs, card
    // numbers — and both caches can be file-backed, so using it as a key wrote
    // those straight to disk. The template identifies the element just as well
    // and additionally makes the entry reusable across different credentials.
    const cacheKeyInstruction = instruction;
    const state = await this.stateParser.parse();

    // ── Self-Healing Locator: cache lookup ────────────────────────────────────
    // Skipped when the outer retry loop signals prior verification failures:
    // the cached locator is the one that just failed verification, so reusing
    // it would just cycle. Fix D forces a re-plan with verifier feedback.
    if (this.locatorCache && !(options?.previousFailures && options.previousFailures.length > 0)) {
      const cached = this.locatorCache.get(state.url, cacheKeyInstruction);
      if (cached) {
        const target =
          state.elements.find(e => e.role === cached.role && e.name === cached.name) ?? null;
        if (target) {
          const actionLabel = `${cached.action} on "${target.name}" (${target.role}) [cached]`;
          this.log(1, `⚡ ${actionLabel}`);
          this.stateParser.invalidateCache();
          try {
            // The stored value is redacted back to %placeholders% — re-resolve
            // it against this call's variables so a cache hit types the current
            // credential, not a stale one.
            const cachedValue =
              cached.value === undefined
                ? undefined
                : interpolateVariables(cached.value, variables);
            await this.performAction(cached.action, target, cachedValue);
            await waitForPageSettle(this.page, this.domSettleTimeoutMs);
            return {
              success: true,
              message: `Successfully performed ${cached.action} on "${target.name}" (cached)`,
              action: actionLabel,
            };
          } catch {
            // Cached action failed — invalidate and fall through to LLM
            this.locatorCache.invalidate(state.url, cacheKeyInstruction);
          }
        } else {
          // Element no longer in DOM — invalidate stale entry
          this.locatorCache.invalidate(state.url, cacheKeyInstruction);
        }
      }
    }

    // ── LLM decision loop ─────────────────────────────────────────────────────
    // Ask the LLM first. If it signals `notFound: true` (target is not in the
    // current element list), scroll one viewport-height once and re-ask. No
    // blind pre-scrolling on keyword mismatch — that caused phantom scrolling
    // on pages where instruction tokens (brand names, sort values, etc.) don't
    // literally appear in role+name.
    let currentState = state;
    let decision!: {
      candidates: { elementId: number; confidence?: number }[];
      action: ActionType;
      value?: string;
      targetElementId?: number;
      reasoning: string;
      notFound?: boolean;
    };
    let candidateIds: number[] = [];
    let preActionFingerprints: Map<number, PatternFingerprint> = new Map();

    for (let attempt = 0; attempt <= MAX_NOT_FOUND_SCROLL_RETRIES; attempt++) {
      const visibleElements = filterRelevantElements(
        currentState.elements,
        resolvedInstruction,
        this.maxElements
      );

      if (currentState.elements.length > visibleElements.length) {
        this.log(
          3,
          `chunk-processing: ${currentState.elements.length} → ${visibleElements.length} elements sent to LLM (instruction: "${resolvedInstruction}")`
        );
      }

      // ── Pattern cache: cross-site learned widget interactions ───────────────
      // Fingerprint the top relevant candidates ONCE, pre-action. The same
      // fingerprint map feeds both lookup and post-success recording, so
      // the key written on run N matches the key probed on run N+1 — state
      // classes added by the action (e.g. focus indicators) don't drift
      // the hash.
      //
      // Skipped when previous attempts have failed verification: the cached
      // pattern is (by definition) the one that just failed, so using it
      // again would guarantee the same failure. Fix D forces the planner to
      // re-plan with feedback.
      const previousFailures = options?.previousFailures ?? [];
      if (previousFailures.length === 0) {
        preActionFingerprints = await this.patternCoord.fingerprintTop(visibleElements);
        const patternResult = await this.patternCoord.tryHit(
          visibleElements,
          preActionFingerprints,
          resolvedInstruction,
          (action, t, value) => this.performAction(action, t, value)
        );
        if (patternResult) return patternResult;
      } else {
        this.log(
          2,
          `Skipping pattern cache — ${previousFailures.length} prior verification failure(s), forcing re-plan`
        );
      }

      const failureBlock =
        previousFailures.length > 0
          ? `\n\nPrevious attempt(s) for THIS instruction failed verification. Do NOT repeat the same strategy — escalate or try a different approach (e.g. if "fill" didn't submit the form, try "press" Enter on the input; if "click" on a button name didn't open a target, try a different candidate):\n${previousFailures.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`
          : '';

      const prompt = `
Current Page URL: ${currentState.url}
Page Title: ${currentState.title}
Instruction: "${resolvedInstruction}"${failureBlock}

Elements on page (id | role | name | region):
${visibleElements.map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}`).join('\n')}
      `.trim();

      const schema = {
        type: 'object',
        properties: {
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                elementId: { type: 'number' },
                confidence: { type: 'number' },
              },
              required: ['elementId'],
            },
          },
          action: {
            type: 'string',
            enum: [
              'click',
              'double-click',
              'right-click',
              'fill',
              'append',
              'hover',
              'press',
              'select',
              'upload',
              'drag',
              'scroll-down',
              'scroll-up',
              'scroll-to',
            ],
          },
          value: { type: 'string' },
          targetElementId: { type: 'number' },
          reasoning: { type: 'string' },
          notFound: { type: 'boolean' },
        },
        required: ['candidates', 'action', 'reasoning'],
      };

      decision = await this.gemini.generateStructuredData<typeof decision>(prompt, schema, {
        systemInstruction: ACT_SYSTEM_INSTRUCTION,
      });

      // Normalize: support old single-elementId responses gracefully. If the LLM
      // returns empty candidates AND no legacy elementId, treat it as notFound
      // so we retry (or fail cleanly) instead of silently clicking element 0.
      const legacyElementId = (decision as any).elementId;
      if (decision.candidates?.length) {
        candidateIds = decision.candidates.map(c => c.elementId);
      } else if (typeof legacyElementId === 'number') {
        candidateIds = [legacyElementId];
      } else {
        candidateIds = [];
        if (!decision.notFound) {
          this.log(2, `LLM returned empty candidates without notFound — treating as notFound`);
          decision.notFound = true;
        }
      }

      if (decision.notFound && attempt < MAX_NOT_FOUND_SCROLL_RETRIES) {
        this.log(
          2,
          `LLM: target not in current view — scrolling ${Math.round(NOT_FOUND_SCROLL_FRACTION * 100)}% viewport and re-asking`
        );
        const vpHeight = await this.page.evaluate(() => window.innerHeight).catch(() => 720);
        await this.page.mouse.wheel(0, Math.floor(vpHeight * NOT_FOUND_SCROLL_FRACTION));
        await waitForPageSettle(this.page, 500);
        this.stateParser.invalidateCache();
        currentState = await this.stateParser.parse();
        continue;
      }
      break;
    }

    // Scroll actions without a target element are valid with elementId = 0
    const isScrollWithoutTarget =
      (decision.action === 'scroll-down' || decision.action === 'scroll-up') &&
      candidateIds[0] === 0;

    this.log(2, `reasoning: ${decision.reasoning}`);
    this.log(
      3,
      `decision: ${JSON.stringify({ candidates: candidateIds, action: decision.action, value: decision.value })}`
    );

    // ── Vision-primary mode: use screenshot + vision LLM before AOM coordinates ──
    if (this.mode === 'vision' && this.visionGrounding && !isScrollWithoutTarget) {
      const firstTarget = currentState.elements.find(e => e.id === candidateIds[0]) ?? null;
      if (firstTarget) {
        try {
          const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
          const screenshot = await this.visionGrounding.takeScreenshot(this.page);
          const bbox = await this.visionGrounding.findElement(
            `${decision.action} on "${firstTarget.name}"`,
            screenshot,
            viewport.width,
            viewport.height
          );
          if (bbox) {
            const cx = bbox.x + bbox.width / 2;
            const cy = bbox.y + bbox.height / 2;
            if (decision.action === 'fill' || decision.action === 'append') {
              await this.page.mouse.click(cx, cy);
              await this.page.waitForTimeout(150);
              await this.page.keyboard.press('Control+a');
              await this.page.waitForTimeout(150);
              await this.page.keyboard.type(decision.value || '', { delay: 90 });
            } else {
              await withTimeout(
                this.page.mouse.click(cx, cy),
                10_000,
                `vision click "${firstTarget.name}"`
              );
            }
            await waitForPageSettle(this.page, this.domSettleTimeoutMs);
            const selector = (await generateSelector(this.page, firstTarget)) ?? undefined;
            return {
              success: true,
              message: `Successfully performed ${decision.action} on "${firstTarget.name}" (via Vision)`,
              action: `${decision.action} on "${firstTarget.name}" (${firstTarget.role})`,
              ...(selector !== undefined ? { selector } : {}),
            };
          }
        } catch (visionErr: any) {
          this.warn(2, `Vision-primary failed: ${visionErr.message} — falling back to AOM`);
        }
      }
    }

    // ── Try each candidate in order ─────────────────────────────────────────
    // On failure, fall through to the next candidate without a new LLM call.
    const attempts: ActionAttempt[] = [];

    for (let ci = 0; ci < candidateIds.length; ci++) {
      const target = isScrollWithoutTarget
        ? null
        : (currentState.elements.find(e => e.id === candidateIds[ci]) ?? null);

      if (!isScrollWithoutTarget && !target) continue; // skip invalid candidate

      const actionLabel = target
        ? `${decision.action} on "${target.name}" (${target.role})`
        : `${decision.action} (page)`;

      if (ci === 0) this.log(1, `${actionLabel}`);
      else this.log(2, `Trying candidate #${ci + 1}: ${actionLabel}`);

      // Pre-action validation: check if element is actually clickable
      if (
        target &&
        (decision.action === 'click' ||
          decision.action === 'double-click' ||
          decision.action === 'right-click')
      ) {
        const blockReason = await this.validateTarget(target);
        if (blockReason) {
          this.warn(2, `Target blocked: ${blockReason}`);
          attempts.push({ path: 'coordinate-click', error: blockReason });
          continue; // try next candidate
        }
      }

      // Generate stable selector before action — DOM is still in pre-action state
      const selector = target
        ? ((await generateSelector(this.page, target)) ?? undefined)
        : undefined;

      // Invalidate cache after action – state will change
      this.stateParser.invalidateCache();

      // JIT pre-action fingerprint: if the LLM picked a target that wasn't
      // in the initial top-N fingerprinted pool, capture its fingerprint
      // NOW (still pre-action — performAction hasn't fired yet). This
      // guarantees the recorded fingerprint matches the state a future
      // pattern-cache lookup will probe — no post-action drift.
      if (target) {
        await this.patternCoord.ensureFingerprintFor(target, preActionFingerprints);
      }

      // For drag, resolve the drop-target element alongside the source.
      const dropTarget =
        decision.action === 'drag' && decision.targetElementId !== undefined
          ? (currentState.elements.find(e => e.id === decision.targetElementId) ?? null)
          : null;

      try {
        await this.performAction(decision.action, target, decision.value, dropTarget);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        // ── Self-Healing Locator: populate cache on success ──────────────────
        if (target && !isScrollWithoutTarget) {
          this.cacheLocator(currentState.url, cacheKeyInstruction, target, decision, variables);
        }
        // ── Pattern cache: record widget-level success for cross-site reuse ──
        if (target && !isScrollWithoutTarget) {
          await this.patternCoord.recordSuccess(
            target,
            {
              action: decision.action,
              role: target.role,
              name: target.name,
              ...(decision.value !== undefined
                ? { value: redactVariables(decision.value, variables) }
                : {}),
            },
            cacheKeyInstruction,
            preActionFingerprints
          );
        }
        return {
          success: true,
          message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''}${ci > 0 ? ` (candidate #${ci + 1})` : ''}`,
          action: actionLabel,
          ...(selector !== undefined ? { selector } : {}),
        };
      } catch (err: any) {
        const errorMsg: string = err.message ?? '';
        attempts.push({ path: 'coordinate-click', error: `candidate #${ci + 1}: ${errorMsg}` });
        this.warn(2, `Candidate #${ci + 1} failed: ${errorMsg}`);

        // If a widget/overlay intercepts pointer events, remove it and retry THIS candidate
        if (errorMsg.includes('intercepts pointer events') && ci === 0) {
          this.log(2, `Pointer-intercepting element detected — removing and retrying`);
          try {
            await this.page.evaluate(() => {
              document
                .querySelectorAll(
                  'getsitecontrol-widget, [class*="popup"], [class*="overlay"], [id*="widget"], [class*="chat-widget"], [class*="intercom"]'
                )
                .forEach(el => {
                  const s = window.getComputedStyle(el);
                  const z = parseInt(s.zIndex, 10);
                  if (
                    s.position === 'fixed' ||
                    s.position === 'absolute' ||
                    (Number.isFinite(z) && z > 999)
                  )
                    el.remove();
                });
            });
            // Retry the same candidate after removing the blocker
            await this.performAction(decision.action, target, decision.value, dropTarget);
            await waitForPageSettle(this.page, this.domSettleTimeoutMs);
            if (target && !isScrollWithoutTarget) {
              this.cacheLocator(currentState.url, cacheKeyInstruction, target, decision, variables);
            }
            return {
              success: true,
              message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''} (after removing blocker)`,
              action: actionLabel,
              ...(selector !== undefined ? { selector } : {}),
            };
          } catch {
            /* retry also failed — continue to next candidate */
          }
        }
      }
    }

    // All candidates failed — fall through to vision/semantic fallback with first valid target
    const fallbackTarget = isScrollWithoutTarget
      ? null
      : (currentState.elements.find(e => e.id === candidateIds[0]) ?? null);

    if (!isScrollWithoutTarget && !fallbackTarget) {
      return { success: false, message: `Could not find any candidate element`, attempts };
    }

    // ── Auto-recovery: try to dismiss common page blockers ──────────────────
    this.stateParser.invalidateCache();
    const recoveryState = await this.stateParser.parse();
    const recovered = await this.tryRecoverFromBlocker(recoveryState);
    if (recovered) {
      // Re-parse after recovery and retry the first candidate. Match by
      // role + name, NOT by `element.id`: the id is a parse-counter
      // (0..N) that the state-parser re-assigns on every parse, so
      // `candidateIds[0]` from the pre-recovery state points to an
      // arbitrary element in the fresh state (often a completely
      // unrelated widget that happens to land at that index). Role +
      // name are semantic and survive re-parse.
      this.stateParser.invalidateCache();
      const freshState = await this.stateParser.parse();
      const retryTarget = fallbackTarget
        ? (freshState.elements.find(
            e => e.role === fallbackTarget.role && e.name === fallbackTarget.name
          ) ?? null)
        : null;
      if (retryTarget) {
        try {
          await this.performAction(decision.action, retryTarget, decision.value);
          await waitForPageSettle(this.page, this.domSettleTimeoutMs);
          return {
            success: true,
            message: `Successfully performed ${decision.action} on "${retryTarget.name}" (after auto-recovery)`,
            action: `${decision.action} on "${retryTarget.name}" (${retryTarget.role})`,
          };
        } catch {
          /* recovery retry also failed — continue to vision/semantic fallback */
        }
      }
    }

    const actionLabel = fallbackTarget
      ? `${decision.action} on "${fallbackTarget.name}" (${fallbackTarget.role})`
      : `${decision.action} (page)`;
    const selector = fallbackTarget
      ? ((await generateSelector(this.page, fallbackTarget)) ?? undefined)
      : undefined;
    const target = fallbackTarget;

    // Vision-Grounding als zweite Stufe (nur wenn aktiviert)
    if (this.visionGrounding && target) {
      try {
        const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
        const screenshot = await this.visionGrounding.takeScreenshot(this.page);
        const bbox = await this.visionGrounding.findElement(
          `${decision.action} on "${target.name}"`,
          screenshot,
          viewport.width,
          viewport.height
        );
        if (bbox) {
          const cx = bbox.x + bbox.width / 2;
          const cy = bbox.y + bbox.height / 2;
          await withTimeout(this.page.mouse.click(cx, cy), 10_000, `vision click "${target.name}"`);
          await waitForPageSettle(this.page, this.domSettleTimeoutMs);
          return {
            success: true,
            message: `Successfully performed ${decision.action} on "${target.name}" (via Vision Grounding)`,
            action: actionLabel,
            ...(selector !== undefined ? { selector } : {}),
          };
        }
        attempts.push({ path: 'vision-grounding', error: 'Element nicht im Screenshot gefunden' });
      } catch (visionError: any) {
        attempts.push({ path: 'vision-grounding', error: visionError.message });
        this.warn(2, `Vision fallback failed: ${visionError.message}`);
      }
    }

    this.warn(2, `All candidates failed, trying semantic fallback...`);
    try {
      // Capture state before fallback to verify it actually changed something
      this.stateParser.invalidateCache();
      const stateBeforeFallback = await this.stateParser.parse();

      await this.blockerRecovery.performSemanticFallback(
        decision.action,
        target,
        decision.value,
        t => this.findBestLocator(t)
      );
      await waitForPageSettle(this.page, this.domSettleTimeoutMs);

      // Verify the fallback actually changed the page
      this.stateParser.invalidateCache();
      const stateAfterFallback = await this.stateParser.parse();
      const pageChanged =
        stateBeforeFallback.url !== stateAfterFallback.url ||
        stateBeforeFallback.title !== stateAfterFallback.title ||
        Math.abs(stateBeforeFallback.elements.length - stateAfterFallback.elements.length) >= 2 ||
        stateBeforeFallback.elements.some(e => e.state?.focused) !==
          stateAfterFallback.elements.some(e => e.state?.focused);

      if (!pageChanged) {
        this.warn(2, `Semantic fallback completed but page state unchanged — marking as failed`);
        attempts.push({
          path: 'locator-fallback',
          error: 'action completed but page state unchanged',
        });
        const message = buildFailureMessage(resolvedInstruction, target, attempts);
        return { success: false, message, action: actionLabel, attempts };
      }

      return {
        success: true,
        message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''} (via fallback)`,
        action: actionLabel,
        ...(selector !== undefined ? { selector } : {}),
      };
    } catch (fallbackError: any) {
      attempts.push({ path: 'locator-fallback', error: fallbackError.message });
      const message = buildFailureMessage(resolvedInstruction, target, attempts);
      this.warn(2, `All paths failed:\n${message}`);

      // Before giving up, check whether a CAPTCHA is blocking the page.
      // When one is present, the generic "action failed" message is useless —
      // the user needs to know they hit a bot-check so they can route the
      // call through an external solver, enable stealth patches, or fall
      // back to manual intervention. Throwing CaptchaDetectedError instead
      // of returning success:false short-circuits Sentinel's retry loop
      // (no point retrying the same CAPTCHA) and surfaces the exact type.
      const captcha = await detectCaptcha(this.page).catch(() => ({ type: null as null }));
      if (captcha.type) {
        throw new CaptchaDetectedError(
          captcha.type,
          describeCaptcha(captcha.type, captcha.source),
          { captchaSource: captcha.source, failedAttempts: attempts }
        );
      }

      return { success: false, message, action: actionLabel, attempts };
    }
  }

  private async performAction(
    action: ActionType,
    target: UIElement | null,
    value?: string,
    dropTarget?: UIElement | null
  ): Promise<void> {
    // Retry with backoff for transient failures (timeout, element detached, scroll issues).
    // Non-transient errors (wrong element, validation) are thrown immediately so the
    // caller can fall through to vision/semantic fallback instead of wasting retries.
    const RETRY_DELAYS = [200, 500];
    const isTransient = (err: any) =>
      /timeout|detach|disposed|intercept|not found|outside viewport/i.test(err?.message ?? '');

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        await this.performActionOnce(action, target, value, dropTarget);
        return;
      } catch (err) {
        if (attempt < RETRY_DELAYS.length && isTransient(err)) {
          this.warn(
            2,
            `Transient failure (attempt ${attempt + 1}), retrying in ${RETRY_DELAYS[attempt]}ms...`
          );
          await this.page.waitForTimeout(RETRY_DELAYS[attempt]!);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Executes one action against one element. Everything above this point has
   * decided *what* to do; this decides *how*, and it is the only place that
   * touches the mouse and keyboard.
   *
   * The order below is not arbitrary — each early return is a path where
   * coordinates are either unnecessary or actively wrong:
   *
   *   target-less scroll → nothing to aim at
   *   cross-frame        → coordinates are relative to the wrong document
   *   upload / drag      → Playwright's locator APIs do it properly
   *   radio              → the AOM rect covers the whole radio group
   *   impossible coords  → scrolling cannot rescue y = -3184
   *
   * What remains needs a real viewport point, so it is resolved once, verified
   * once, and then handed to the per-action handlers.
   */
  private async performActionOnce(
    action: ActionType,
    target: UIElement | null,
    value?: string,
    dropTarget?: UIElement | null
  ): Promise<void> {
    // Scroll actions that don't need a target element.
    // mouse.wheel dispatches a native wheel event at the current cursor position so
    // the browser routes it to whichever element is actually scrollable — works for
    // both window-level scroll and scrollable container divs (SPAs, iframes, etc.).
    if (action === 'scroll-down' && !target) {
      await this.page.mouse.wheel(0, 600);
      return;
    }
    if (action === 'scroll-up' && !target) {
      await this.page.mouse.wheel(0, -600);
      return;
    }

    if (!target) throw new ActionError('No target element provided', { action });

    // Cross-frame routing: element lives inside an iframe.
    // Delegate to Playwright's frame locator API, which dispatches clicks,
    // fills, and keystrokes into the frame's document — coordinate-based
    // paths would hit the iframe boundary rather than the inner content.
    if (target.frameId) {
      const frame = this.stateParser.getFrame(target.frameId);
      if (frame) {
        await this.executeInFrame(frame, action, target, value, dropTarget);
        return;
      }
      this.warn(2, `Frame "${target.frameId}" not in registry — falling back to main-frame path`);
    }

    // File upload: locator-based, no coordinates required (setInputFiles
    // works even for visually hidden <input type="file">).
    if (action === 'upload') {
      await this.performUpload(this.page, target, value);
      return;
    }

    // Drag & drop: source → drop-target via Playwright locator.dragTo().
    // Cross-frame drag is not supported in this iteration — both elements
    // must share the same context (main document or same iframe).
    if (action === 'drag') {
      if (!dropTarget) {
        throw new ActionError('drag requires a drop-target element', { action });
      }
      await this.performDrag(this.page, target, dropTarget);
      return;
    }

    // Radio buttons: AOM bounding boxes frequently cover the entire radio-
    // group container rather than the individual radio circle + label. Using
    // coordinate-based clicking at the AOM centroid therefore hits the group
    // wrapper, triggering a coordinate-mismatch error. Playwright's locator
    // API resolves the individual radio by accessible name — no coordinates
    // needed, works regardless of group nesting or label layout.
    if (action === 'click' && target.role === 'radio') {
      try {
        await this.page
          .getByRole('radio', { name: target.name, exact: false })
          .first()
          .click({ timeout: 10_000 });
        return;
      } catch {
        // Locator miss — fall through to coordinate path
      }
    }

    if (hasImpossibleCoordinates(documentCentroid(target))) {
      const centroid = documentCentroid(target);
      this.warn(
        2,
        `Impossible coordinates (${centroid.x.toFixed(0)}, ${centroid.y.toFixed(0)}) for "${target.name}" — using locator`
      );
      await this.actViaLocator(target, action, value, 5000);
      return;
    }

    const point = await resolveViewportPoint(this.page, target);

    const mismatch = await this.detectCoordinateMismatch(action, target, point);
    if (mismatch !== null) {
      await this.recoverFromCoordinateMismatch(target, action, value, point, mismatch);
      return;
    }

    await this.moveMouseHumanLike(action, point);
    await this.dispatchAction(action, target, value, point);
  }

  /**
   * Performs `action` through a Playwright locator instead of coordinates.
   * Used whenever the AOM's geometry cannot be trusted.
   */
  private async actViaLocator(
    target: UIElement,
    action: ActionType,
    value: string | undefined,
    timeout: number,
    name = target.name
  ): Promise<void> {
    const locator = this.page.getByRole(target.role as any, { name, exact: false });
    if (action === 'fill') {
      await locator.fill(value || '', { timeout });
    } else {
      await this.clickLocator(locator, { timeout });
    }
  }

  /**
   * Confirms the element at `point` is the one we meant to act on.
   *
   * Catches stale AOM geometry, where a dynamically-appeared element leaves
   * coordinates pointing at a different field — the reproducible case was a
   * "Motorleistung" input whose coordinates landed on "Treibstoff".
   *
   * Three cases opt out, all for the same underlying reason: the element at the
   * coordinates is legitimately not the target.
   *  - **slider + fill** — the locator fallback fails silently on ARIA-only
   *    sliders, and `fillSlider` has its own three-strategy element lookup.
   *  - **datepicker + fill** — same, via `fillDateLike`.
   *  - **select with an open popover** — the popover structurally covers the
   *    trigger, so `elementFromPoint` returns one of its options by design.
   *
   * @returns the conflicting label, or null when the coordinates are trustworthy.
   */
  private async detectCoordinateMismatch(
    action: ActionType,
    target: UIElement,
    point: ViewportPoint
  ): Promise<string | null> {
    if (action !== 'fill' && action !== 'click' && action !== 'select') return null;
    if (target.role === 'slider' && action === 'fill') return null;
    if ((target.role === 'datepicker' || target.role === 'timepicker') && action === 'fill') {
      return null;
    }
    if (action === 'select' && (await isListboxPopoverVisible(this.page))) return null;

    const hitName = await readLabelAtPoint(this.page, point);
    if (!isCoordinateMismatch(hitName, target.name)) return null;

    this.warn(
      2,
      `Coordinate mismatch: "${target.name}" at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) hits "${hitName}" — using locator fallback`
    );
    return hitName;
  }

  /**
   * Falls back to locators after a coordinate mismatch.
   *
   * Tries the full accessible name first, then the part after a colon —
   * composite names like "Filter: Marke" are common, and the visible control is
   * usually labelled with just the tail.
   */
  private async recoverFromCoordinateMismatch(
    target: UIElement,
    action: ActionType,
    value: string | undefined,
    point: ViewportPoint,
    hitName: string
  ): Promise<void> {
    const nameVariants = [target.name];
    if (target.name.includes(':')) {
      nameVariants.push(target.name.split(':').pop()!.trim());
    }
    for (const name of nameVariants) {
      try {
        await this.actViaLocator(target, action, value, 3000, name);
        return;
      } catch {
        continue;
      }
    }
    throw new ActionError(
      `Coordinate mismatch: target is "${target.name}" but element at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) is "${hitName}"`,
      { element: target.name, hitElement: hitName }
    );
  }

  /**
   * Moves the cursor to the target along a Bézier curve before acting.
   *
   * Only for actions a real user would approach with the mouse — keyboard-only
   * and scroll actions get nothing, because a mouse path to them would be a
   * fabricated signal rather than a realistic one.
   */
  private async moveMouseHumanLike(action: ActionType, point: ViewportPoint): Promise<void> {
    if (!this.humanLike) return;
    const MOUSE_ACTIONS: ActionType[] = [
      'click',
      'double-click',
      'right-click',
      'hover',
      'fill',
      'append',
    ];
    if (!MOUSE_ACTIONS.includes(action)) return;

    const cur = await this.page
      .evaluate(() => ({
        x: (window as any).__sentinelMouseX ?? 0,
        y: (window as any).__sentinelMouseY ?? 0,
      }))
      .catch(() => ({ x: 0, y: 0 }));
    await moveMouse(this.page, cur.x, cur.y, point.x, point.y);
    await this.page
      .evaluate(
        ({ x, y }) => {
          (window as any).__sentinelMouseX = x;
          (window as any).__sentinelMouseY = y;
        },
        { x: point.x, y: point.y }
      )
      .catch(ignoreRejection);
    await this.page.waitForTimeout(80 + Math.round(Math.random() * 120));
  }

  /** Routes a verified action + point to the handler that knows how to do it. */
  private async dispatchAction(
    action: ActionType,
    target: UIElement,
    value: string | undefined,
    point: ViewportPoint
  ): Promise<void> {
    switch (action) {
      case 'click':
        await this.performClick(target, point);
        return;

      case 'double-click':
        await withTimeout(
          this.page.mouse.dblclick(point.x, point.y),
          10_000,
          `double-click "${target.name}"`
        );
        return;

      case 'right-click':
        await withTimeout(
          this.page.mouse.click(point.x, point.y, { button: 'right' }),
          10_000,
          `right-click "${target.name}"`
        );
        return;

      case 'fill':
        await this.performFill(target, value, point);
        return;

      case 'append':
        await appendText(this.page, target, value, point, this.humanLike);
        return;

      case 'hover':
        await withTimeout(this.page.mouse.move(point.x, point.y), 10_000, `hover "${target.name}"`);
        return;

      case 'press':
        await withTimeout(
          this.page.mouse.click(point.x, point.y),
          10_000,
          `focus "${target.name}"`
        );
        await this.page.keyboard.press(value || 'Enter');
        return;

      case 'select':
        await performSelect(this.page, target, value, point);
        return;

      case 'scroll-down':
        await this.scrollElementAt(point, 300);
        return;

      case 'scroll-up':
        await this.scrollElementAt(point, -300);
        return;

      case 'scroll-to':
        await this.page.evaluate(({ x, y }: ViewportPoint) => {
          document.elementFromPoint(x, y)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, point);
        return;
    }
  }

  /**
   * Clicks at `point`.
   *
   * Radios and checkboxes are clicked from inside the page rather than with the
   * mouse: the visible control is routinely a styled `<span>` with the real
   * `<input>` hidden beneath it, and a synthetic mouse click on the decoration
   * does not toggle anything. Preference order — the hidden input, then the
   * wrapping `<label>` (which forwards the click), then the element itself.
   */
  private async performClick(target: UIElement, point: ViewportPoint): Promise<void> {
    if (target.role !== 'radio' && target.role !== 'checkbox') {
      await withTimeout(this.page.mouse.click(point.x, point.y), 10_000, `click "${target.name}"`);
      return;
    }
    await this.page.evaluate(({ x, y }: ViewportPoint) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return;
      const hiddenInput = el.querySelector(
        'input[type="radio"], input[type="checkbox"]'
      ) as HTMLInputElement | null;
      if (hiddenInput) {
        hiddenInput.click();
        return;
      }
      const label = el.closest('label') as HTMLLabelElement | null;
      if (label) {
        label.click();
        return;
      }
      el.click();
    }, point);
  }

  /**
   * Fills a control, choosing by role.
   *
   * Sliders and date controls own their interaction completely; a date control
   * whose value could not be parsed falls through to a plain text fill, since a
   * free-format date field is just a text field.
   */
  private async performFill(
    target: UIElement,
    value: string | undefined,
    point: ViewportPoint
  ): Promise<void> {
    if (target.role === 'slider' && value) {
      await fillSlider(this.page, target, value, point);
      return;
    }
    if ((target.role === 'datepicker' || target.role === 'timepicker') && value) {
      const handled = await fillDateLike(this.page, target, value, point, this.humanLike);
      if (handled) return;
    }
    await fillText(this.page, target, value, point, this.humanLike);
  }

  /** Scrolls whichever element sits at `point` by `dy` pixels. */
  private async scrollElementAt(point: ViewportPoint, dy: number): Promise<void> {
    await this.page.evaluate(
      ({ x, y, delta }: { x: number; y: number; delta: number }) => {
        document.elementFromPoint(x, y)?.scrollBy(0, delta);
      },
      { x: point.x, y: point.y, delta: dy }
    );
  }

  /**
   * Tries multiple Playwright locator strategies in order of specificity.
   * Returns the first locator that resolves to a visible element, or falls
   * back to the most specific strategy if none is currently visible (e.g.
   * the element exists but is off-screen and needs scrolling).
   */
  private async findBestLocator(target: UIElement) {
    const strategies = [
      // 1. Exact ARIA role + exact accessible name (most specific)
      target.name
        ? this.page.getByRole(target.role as any, { name: target.name, exact: true })
        : null,
      // 2. ARIA role + partial/case-insensitive name match
      target.name ? this.page.getByRole(target.role as any, { name: target.name }) : null,
      // 3. CSS role attribute + hasText (original strategy)
      target.name
        ? this.page.locator(`[role="${target.role}"]`, { hasText: target.name }).first()
        : this.page.locator(`[role="${target.role}"]`).first(),
      // 4. Plain text match as last resort
      target.name ? this.page.getByText(target.name, { exact: false }).first() : null,
      // 5. If name contains ':' context prefix, try without it (e.g. "Info: Weiter" → "Weiter")
      target.name?.includes(':')
        ? this.page.getByRole(target.role as any, { name: target.name.split(':').pop()!.trim() })
        : null,
    ].filter((l): l is NonNullable<typeof l> => l !== null);

    for (const locator of strategies) {
      try {
        const isVisible = await locator.isVisible({ timeout: 1500 });
        if (isVisible) return locator;
      } catch {
        continue;
      }
    }

    // None visible right now — return the most specific strategy anyway.
    // The caller's scrollIntoViewIfNeeded / click will handle it.
    return strategies[0]!;
  }

  /**
   * Validates that the element at the target's coordinates is actually
   * interactive (not disabled, not hidden behind an overlay).
   * Returns null if valid, or an error message if blocked.
   */
  private async validateTarget(target: UIElement): Promise<string | null> {
    const cx = target.boundingClientRect.x + target.boundingClientRect.width / 2;
    const cy = target.boundingClientRect.y + target.boundingClientRect.height / 2;

    return this.page
      .evaluate(
        ({ x, y }: { x: number; y: number }) => {
          // AOM coordinates are in document (layout) space.
          // If the element is below the fold, scroll it into view first
          // so elementFromPoint can actually find it.
          const vpX = x - window.scrollX;
          const vpY = y - window.scrollY;
          const inViewport =
            vpX >= 0 && vpY >= 0 && vpX < window.innerWidth && vpY < window.innerHeight;

          if (!inViewport) {
            // Scroll the point into view before checking
            window.scrollTo({
              left: Math.max(0, x - window.innerWidth / 2),
              top: Math.max(0, y - window.innerHeight / 2),
              behavior: 'instant',
            });
          }

          // Re-calculate viewport coords after possible scroll
          const finalVpX = x - window.scrollX;
          const finalVpY = y - window.scrollY;
          const el = document.elementFromPoint(finalVpX, finalVpY);
          if (!el) return null; // can't determine — let the action try

          // Check disabled state
          if (
            (el as HTMLElement).hasAttribute('disabled') ||
            el.getAttribute('aria-disabled') === 'true'
          ) {
            return 'element is disabled';
          }

          // Check if hidden
          if (
            (el as HTMLElement).offsetParent === null &&
            getComputedStyle(el).position !== 'fixed'
          ) {
            return 'element is hidden (display:none)';
          }

          // Check if an overlay/modal is covering the target
          const role = el.getAttribute('role');
          const tag = el.tagName.toLowerCase();
          if (role === 'dialog' || role === 'alertdialog' || tag === 'dialog') {
            const ariaLabel = el.getAttribute('aria-label') || '';
            if (
              /cookie|consent|privacy|datenschutz/i.test(ariaLabel) ||
              /cookie|consent|privacy|datenschutz/i.test(el.textContent?.slice(0, 200) || '')
            ) {
              return 'blocked by cookie/consent overlay';
            }
            return 'blocked by dialog/modal overlay';
          }

          return null; // valid
        },
        { x: cx, y: cy }
      )
      .catch(() => null); // on error, assume valid
  }
}
