export interface ActOptions {
  variables?: Record<string, string>;
  retries?: number;
  /**
   * Feedback from previous failed verifications in this act() retry chain.
   * When the outer retry loop re-enters after a verification rejection, it
   * passes the rejection messages in here so the planner knows what NOT to
   * repeat — e.g. after "search and submit" failed because only autocomplete
   * opened, the planner can escalate to pressing Enter on the next attempt
   * instead of trying the same fill action.
   */
  previousFailures?: string[];
}

export interface ActionAttempt {
  path: 'coordinate-click' | 'vision-grounding' | 'locator-fallback';
  error: string;
}

export interface ActionResult {
  success: boolean;
  message: string;
  action?: string;
  /**
   * Stable CSS selector for the element that was interacted with.
   * Omitted for scroll actions, failed actions, or when no stable selector
   * could be derived. Useful for exporting selectors into Playwright tests.
   */
  selector?: string;
  /** Present on failure — describes each attempted path and its error. */
  attempts?: ActionAttempt[];
}

export type ActionType =
  | 'click'
  | 'fill'
  | 'append'
  | 'hover'
  | 'press'
  | 'select'
  | 'double-click'
  | 'right-click'
  | 'scroll-down'
  | 'scroll-up'
  | 'scroll-to'
  | 'upload'
  | 'drag';
