/**
 * Explicit no-op rejection handler for best-effort browser operations.
 *
 * Sentinel does a lot of work that is genuinely optional: scrolling an element
 * into view, pressing Escape to dismiss a popover, disposing a handle, focusing
 * a slider. Any of these can reject because the page navigated or the node
 * detached mid-flow, and none of them should abort the action in progress.
 *
 * Prefer `.catch(ignoreRejection)` over an inline `.catch(() => {})`:
 *  - the name states that swallowing is intended, not an oversight;
 *  - `grep ignoreRejection` enumerates every deliberate swallow in one pass;
 *  - an inline empty arrow around something that *does* matter now stands out
 *    in review instead of blending into a sea of identical no-ops.
 *
 * Use it only where failure carries no information. If the failure is worth
 * knowing about, log it at debug level instead.
 */
export function ignoreRejection(): void {
  /* intentionally empty — see the doc comment above */
}
