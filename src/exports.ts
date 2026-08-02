// Public re-export barrel. Keeping these out of `index.ts` so the entry file
// stays focused on the `Sentinel` class.

export type { BrowserType, ProxyOptions } from './core/driver.js';
export type { LLMProvider } from './utils/llm-provider.js';
export type { ILocatorCache, CachedLocator } from './core/locator-cache.js';
export type { IPromptCache } from './core/prompt-cache.js';
export { RoundRobinProxyProvider, WebshareProxyProvider } from './utils/proxy-provider.js';
export type { IProxyProvider, WebshareProxyOptions } from './utils/proxy-provider.js';
export { slugifyInstruction } from './core/selector-generator.js';
export {
  SentinelError,
  ActionError,
  ExtractionError,
  NavigationError,
  AgentError,
  NotInitializedError,
  BudgetExceededError,
  RateLimitError,
  CaptchaDetectedError,
} from './types/errors.js';
export type { CaptchaType } from './types/errors.js';
export type { Logger, LogEvent, LogLevel, JsonSink } from './utils/logger.js';
export { ConsoleLogger, JsonLogger, createLogger, createFileSink } from './utils/logger.js';
export type {
  IPatternCache,
  PatternSequence,
  StoredPattern,
  PatternCacheStats,
  FingerprintLayer,
} from './core/pattern-cache.js';
export {
  InMemoryPatternCache,
  FilePatternCache,
  createPatternCache,
} from './core/pattern-cache.js';
export type { PatternFingerprint } from './core/pattern-signature.js';
export type { RecordedWorkflow } from './recorder/workflow-recorder.js';
export { GeminiProvider } from './utils/providers/gemini-provider.js';
export { OpenAIProvider } from './utils/providers/openai-provider.js';
export { ClaudeProvider } from './utils/providers/claude-provider.js';
export { OllamaProvider } from './utils/providers/ollama-provider.js';
export { generateTOTP } from './utils/totp.js';
// Re-export z and types so users can do: import { Sentinel, z } from './index.js'
export { z } from 'zod';
export type { ActOptions, ActionResult, ActionAttempt } from './api/act.js';
export type { ObserveResult } from './api/observe.js';
export type { AgentRunOptions, AgentResult, AgentStepEvent } from './agent/agent-loop.js';
export type { BoundingBox } from './core/vision-grounding.js';
export type { AIFixture } from './test/index.js';
