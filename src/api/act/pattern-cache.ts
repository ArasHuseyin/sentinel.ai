import type { Page } from 'playwright';
import type { StateParser, UIElement } from '../../core/state-parser.js';
import type { IPatternCache, PatternSequence } from '../../core/pattern-cache.js';
import type { PatternFingerprint } from '../../core/pattern-signature.js';
import type { ActionResult, ActionType } from './types.js';
import { waitForPageSettle } from './page-settle.js';

type Logger = (level: 1 | 2 | 3, message: string) => void;

/** Callback into ActionEngine's `performAction` for cache-hit execution. */
export type PerformActionCallback = (
  action: ActionType,
  target: UIElement,
  value?: string,
) => Promise<void>;

/**
 * How many relevance-ranked candidates get fingerprinted and probed.
 * Wider pools increase the chance of hitting the user's intended target
 * when many same-shape widgets exist on one page (MUI docs can easily
 * render 15+ textbox variants). Upper bound is a cost-vs-coverage
 * trade-off: each extra candidate is ~2ms of `elementFromPoint` +
 * fingerprint work, all in a single page.evaluate round-trip.
 */
const PATTERN_PROBE_TOP_N = 20;

/** Roles whose textual value is sensitive and must NOT be persisted to the pattern cache. */
const SENSITIVE_VALUE_ROLES: ReadonlySet<string> = new Set<string>([
  // Password fields are classified as 'textbox' by the parser — we can't
  // distinguish them by role alone. Attribute-level filtering happens when
  // the pattern is recorded (type=password / type=tel on the element).
]);

/**
 * Loose name-compatibility check used at pattern lookup time. Two names
 * are compatible if either is a non-trivial substring of the other —
 * after lowercase-trim normalisation. This preserves cross-site reuse
 * ("Email" on site A matches "Email address" on site B) while rejecting
 * false same-shape hits within a single page ("Outlined" vs "With a
 * start adornment").
 */
function namesCompatible(candidate: string, cached: string): boolean {
  const a = candidate.toLowerCase().trim();
  const b = cached.toLowerCase().trim();
  if (!a || !b) return a === b;
  if (a === b) return true;
  // Substring either direction — but require at least 3 chars of overlap
  // to avoid accidental matches on short words like "ok" or "id".
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  return false;
}

/**
 * Sanitises a candidate PatternSequence before recording — strips the
 * user-entered value when the target looks like a sensitive input so
 * we never persist credentials / phone numbers / card data into the
 * shared pattern cache.
 */
function sanitiseForCache(sequence: PatternSequence, sensitive: boolean): PatternSequence {
  if (!sensitive) return sequence;
  const { value, ...rest } = sequence;
  void value;
  return rest;
}

/** Heuristic: is filling this element's value a privacy concern worth redacting? */
async function isSensitiveTarget(page: Page, target: UIElement): Promise<boolean> {
  if (!target) return false;
  // Role-based fast check
  if (SENSITIVE_VALUE_ROLES.has(target.role)) return true;
  // DOM-level check: look for type=password / type=tel at the target coords
  try {
    const { x, y, width, height } = target.boundingClientRect;
    return await page.evaluate(
      ({ cx, cy }: { cx: number; cy: number }) => {
        const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
        if (!el) return false;
        let cursor: HTMLElement | null = el;
        for (let d = 0; d < 4 && cursor; d++) {
          if (cursor.tagName === 'INPUT') {
            const t = (cursor as HTMLInputElement).type?.toLowerCase();
            if (t === 'password' || t === 'tel') return true;
          }
          const input = cursor.querySelector?.('input[type="password"], input[type="tel"]');
          if (input) return true;
          cursor = cursor.parentElement;
        }
        return false;
      },
      { cx: x + width / 2, cy: y + height / 2 }
    );
  } catch {
    return false;
  }
}

/**
 * Coordinates every pattern-cache interaction for a single `act()` call:
 * pre-action fingerprinting, hit probing, JIT fingerprints for off-pool
 * targets, and post-success recording (with sensitive-value filtering).
 *
 * When the underlying `patternCache` is null this class is a no-op —
 * all methods return early so callers can invoke it unconditionally.
 */
export class PatternCacheCoordinator {
  constructor(
    private readonly page: Page,
    private readonly stateParser: StateParser,
    private readonly patternCache: IPatternCache | null,
    private readonly log: Logger,
    private readonly warn: Logger,
    private readonly domSettleTimeoutMs: number,
  ) {}

  get enabled(): boolean {
    return this.patternCache !== null;
  }

  /**
   * Fingerprints the top-N candidates in a single round-trip. Computed
   * ONCE per `act()` call BEFORE the action fires so both the cache
   * lookup and any post-success recording reference the pre-action DOM
   * state — critical for stability since many libraries mutate widget
   * classes after focus/fill/select (e.g. `Mui-focused` prepended to a
   * container's classList would otherwise flip the library signature
   * between lookup and record, causing permanent cache misses).
   */
  async fingerprintTop(candidates: UIElement[]): Promise<Map<number, PatternFingerprint>> {
    if (!this.patternCache || candidates.length === 0) return new Map();
    const top = candidates
      .slice(0, PATTERN_PROBE_TOP_N)
      .filter(c => c.boundingClientRect.width > 0);
    if (top.length === 0) return new Map();
    return await this.stateParser.computeTargetFingerprints(
      top.map(e => ({
        id: e.id,
        x: e.boundingClientRect.x + e.boundingClientRect.width / 2,
        y: e.boundingClientRect.y + e.boundingClientRect.height / 2,
      })),
    );
  }

  /**
   * Probes the pattern cache for any of the pre-fingerprinted candidates.
   * Returns a successful ActionResult on a confirmed hit, `null` on miss
   * (the caller then continues down to the LLM path).
   *
   * Failure semantics: if a cache-hit action throws, we record a failure
   * against that pattern (confidence decay) and return `null` so the
   * normal LLM flow takes over. Self-healing by design.
   */
  async tryHit(
    candidates: UIElement[],
    fingerprints: Map<number, PatternFingerprint>,
    instruction: string,
    performAction: PerformActionCallback,
  ): Promise<ActionResult | null> {
    if (!this.patternCache || fingerprints.size === 0) return null;
    // Iterate candidates in relevance order — first cache hit wins.
    const top = candidates.slice(0, PATTERN_PROBE_TOP_N);
    this.log(2, `[Pattern] probing ${top.length} candidate(s) against cache (${fingerprints.size} fingerprints computed)`);
    for (const candidate of top) {
      const fp = fingerprints.get(candidate.id);
      if (!fp || (!fp.aria && !fp.library && !fp.topology)) {
        this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — no fingerprint (elementFromPoint returned nothing)`);
        continue;
      }
      const entry = this.patternCache.get(fp, instruction);
      if (!entry) {
        this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — MISS fp=${JSON.stringify(fp)}`);
        continue;
      }
      // Name-compat check: several widgets on the same page often share a
      // fingerprint (e.g. every MUI TextField has the same ARIA shape).
      // The stored sequence points at a specific element by name, so hit
      // only when the candidate's accessible name is compatible with the
      // cached one — exact or substring either direction. Prevents cache
      // hits from routing the action to the wrong same-shape widget.
      if (!namesCompatible(candidate.name, entry.sequence.name)) {
        this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — FP match but name differs from cached "${entry.sequence.name}" — skipping`);
        continue;
      }
      this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — HIT fp=${JSON.stringify(fp)}`);

      const actionLabel = `${entry.sequence.action} on "${candidate.name}" (${candidate.role}) [pattern]`;
      this.log(1, `[Act] 🎯 ${actionLabel}`);
      this.stateParser.invalidateCache();
      try {
        await performAction(entry.sequence.action, candidate, entry.sequence.value);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        // Successful hit — bump confidence
        this.patternCache.recordSuccess(fp, instruction, entry.sequence);
        return {
          success: true,
          message: `Successfully performed ${entry.sequence.action} on "${candidate.name}" (pattern)`,
          action: actionLabel,
        };
      } catch (err: any) {
        // Pattern matched but execution failed — decay confidence, fall through to LLM
        this.patternCache.recordFailure(fp, instruction);
        this.warn(2, `[Act] Pattern hit failed (${err?.message ?? 'unknown'}) — falling back to LLM`);
        return null;
      }
    }
    return null;
  }

  /**
   * JIT pre-action fingerprint: when the LLM picks a target that wasn't
   * in the initial top-N pool, capture its fingerprint now (still
   * pre-action) so a later `recordSuccess` writes a key consistent with
   * what a future `tryHit` lookup will probe — no drift from framework
   * state classes added by the action.
   */
  async ensureFingerprintFor(
    target: UIElement,
    fingerprints: Map<number, PatternFingerprint>,
  ): Promise<void> {
    if (!this.patternCache || fingerprints.has(target.id)) return;
    const { x, y, width, height } = target.boundingClientRect;
    if (width <= 0 || height <= 0) return;
    const extra = await this.stateParser.computeTargetFingerprints([
      { id: target.id, x: x + width / 2, y: y + height / 2 },
    ]);
    const fp = extra.get(target.id);
    if (fp) fingerprints.set(target.id, fp);
  }

  /**
   * Records a successful LLM-directed action into the pattern cache.
   * Uses the pre-action fingerprint map populated by `act()` (either via
   * the initial top-N batch or the JIT single-target compute triggered
   * when the LLM picked outside the top-N). Both paths guarantee the
   * stored key was computed on the same pre-action DOM state a future
   * lookup will probe — no drift from framework state classes.
   * Sensitive-field filter kicks in for password / tel / card inputs.
   */
  async recordSuccess(
    target: UIElement,
    sequence: PatternSequence,
    instruction: string,
    preActionFingerprints: Map<number, PatternFingerprint>,
  ): Promise<void> {
    if (!this.patternCache) return;
    try {
      const fp = preActionFingerprints.get(target.id);
      if (!fp || (!fp.aria && !fp.library && !fp.topology)) {
        this.log(2, `[Pattern] record skipped for ${target.id} "${target.name}" — no usable fingerprint`);
        return;
      }
      const sensitive = await isSensitiveTarget(this.page, target);
      this.patternCache.recordSuccess(fp, instruction, sanitiseForCache(sequence, sensitive));
      this.log(2, `[Pattern] recorded ${target.role} "${target.name}" fp=${JSON.stringify(fp)}`);
    } catch {
      // Pattern recording must never abort the caller's action path.
    }
  }
}
