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
