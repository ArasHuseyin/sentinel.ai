/**
 * Base class for all Sentinel errors.
 */
export class SentinelError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'SentinelError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an action (click, fill, etc.) fails after all retries.
 */
export class ActionError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'ACTION_FAILED', context);
    this.name = 'ActionError';
  }
}

/**
 * Thrown when structured data extraction fails.
 */
export class ExtractionError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'EXTRACTION_FAILED', context);
    this.name = 'ExtractionError';
  }
}

/**
 * Thrown when the LLM provider returns an unexpected or unparseable response.
 */
export class LLMError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'LLM_ERROR', context);
    this.name = 'LLMError';
  }
}

/**
 * Thrown when navigation to a URL fails.
 */
export class NavigationError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'NAVIGATION_FAILED', context);
    this.name = 'NavigationError';
  }
}

/**
 * Thrown when the agent loop exceeds max steps or gets stuck.
 */
export class AgentError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'AGENT_ERROR', context);
    this.name = 'AgentError';
  }
}

/**
 * Thrown when Sentinel is used before init() is called.
 */
export class NotInitializedError extends SentinelError {
  constructor() {
    super('Sentinel not initialized. Call init() first.', 'NOT_INITIALIZED');
    this.name = 'NotInitializedError';
  }
}

/**
 * Thrown when the configured token or cost budget is exceeded.
 * The error fires on the *next* LLM call after a budget threshold was crossed
 * — the call that tripped the check has already been billed. Catch this to
 * halt long-running agent loops before runaway costs accumulate.
 */
export class BudgetExceededError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'BUDGET_EXCEEDED', context);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Thrown when a per-domain rate limit is breached synchronously (i.e. the
 * caller opted out of auto-delay). Currently the built-in rate limiter
 * *waits* instead of throwing; this error is reserved for future opt-in
 * strict-mode rate limiting.
 */
export class RateLimitError extends SentinelError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'RATE_LIMITED', context);
    this.name = 'RateLimitError';
  }
}

/**
 * CAPTCHA types we detect. Each maps to a distinct DOM signature and has
 * its own solving strategy (or lack thereof). Non-exhaustive — unknown
 * CAPTCHAs fall under `'unknown'`.
 */
export type CaptchaType =
  | 'recaptcha-v2'   // checkbox + (optional) image challenge — clickable
  | 'recaptcha-v3'   // invisible score-based — no UI to interact with
  | 'hcaptcha'       // image challenge — requires external solver
  | 'turnstile'      // Cloudflare proof-of-work — usually auto-resolves
  | 'funcaptcha'     // Arkose Labs interactive puzzle — external solver only
  | 'unknown';       // Unrecognised CAPTCHA widget

/**
 * Thrown when Sentinel detects a CAPTCHA blocking the current interaction
 * and no solver is configured (or the configured solver can't handle this
 * type). The error's `type` field tells the caller what was detected so
 * they can pick a solving strategy (pause for manual, call external API,
 * try a different user agent, etc.).
 *
 * Previously such pages caused silent failure loops — Sentinel would keep
 * clicking invisible elements behind the CAPTCHA modal and eventually
 * exit with "3 consecutive failures". This error short-circuits that.
 */
export class CaptchaDetectedError extends SentinelError {
  constructor(
    public readonly type: CaptchaType,
    message: string,
    context?: Record<string, any>
  ) {
    super(message, 'CAPTCHA_DETECTED', { ...context, captchaType: type });
    this.name = 'CaptchaDetectedError';
  }
}
