# Changelog

All notable changes to Sentinel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.1.0] - 2026-04-06

### Fixed

#### 🧠 More Robust AOM Parsing (`src/core/state-parser.ts`)
- Interactive elements without `aria-label` or `aria-labelledby` (e.g. cards with a child `<h4>`) are now correctly recognized
- New method `extractSubtreeText()` — generically extracts visible text from the AOM subtree of a node (recursive up to depth 6, max. 120 characters)
- Covers all cases where the semantic name lives in a child element: headings, paragraphs, spans, icons, etc.
- `nodeToUIElement()` now uses priority `name → description → subtree text` as the effective name

---

## [2.0.0] - 2026-04-05

### 🚀 Major Release — Sentinel becomes a full AI Agent Framework

This release transforms Sentinel from a browser automation library into a complete AI agent framework, competing directly with BrowserUse, Stagehand, and AutoGPT.

---

### Added

#### 🤖 Autonomous Agent Loop (`src/agent/`)
- New `AgentLoop` class with `run(goal, options?)` — fully autonomous Plan → Execute → Verify → Reflect cycle
- New `Planner` class — uses LLM to plan the next step based on current page state and history
- New `Memory` class — sliding context window over step history to maintain goal awareness
- `sentinel.run(goal)` exposed as top-level public API
- `maxSteps` limit (default: 15) and stuck-detection abort conditions
- `onStep` callback hook for real-time step monitoring (`AgentStepEvent`)

#### 👁️ Vision Grounding (`src/core/vision-grounding.ts`)
- New `VisionGrounding` class using Gemini Vision API
- `sentinel.screenshot()` — take a PNG screenshot as a `Buffer`
- `sentinel.describeScreen()` — visual description of the current page via Gemini Vision
- Automatic Vision fallback in `act()` when AOM cannot locate an element
- `visionFallback?: boolean` option in `SentinelOptions`

#### 🔌 Multi-LLM Provider Support (`src/utils/llm-provider.ts`, `src/utils/providers/`)
- New `LLMProvider` interface: `generateStructuredData<T>()`, `generateText()`
- `GeminiProvider` — wraps existing GeminiService
- `OpenAIProvider` — GPT-4o and any OpenAI-compatible model
- `ClaudeProvider` — Anthropic Claude (claude-3-5-sonnet and others)
- `OllamaProvider` — local models via Ollama (llama3.2, mistral, etc.)
- `provider?: LLMProvider` option in `SentinelOptions` to override default Gemini

#### 🗂️ Multi-Tab & Multi-Browser Support (`src/core/driver.ts`)
- `sentinel.newTab(url?)` — open a new browser tab, returns tab index
- `sentinel.switchTab(index)` — switch the active tab
- `sentinel.closeTab(index)` — close a tab by index
- `sentinel.tabCount` getter — number of currently open tabs
- `browser?: 'chromium' | 'firefox' | 'webkit'` option in `SentinelOptions`

#### 💾 Session Persistence & Auth Management
- `sentinel.saveSession(filePath)` — saves Playwright `storageState` (cookies + localStorage) to JSON
- `sessionPath?: string` option — auto-loads session on `init()`
- `sentinel.hasLoginForm()` — detects if the current page has a login form

#### 🔄 Record & Replay (`src/recorder/workflow-recorder.ts`)
- New `WorkflowRecorder` class
- `sentinel.startRecording(name?)` — begin capturing all actions
- `sentinel.stopRecording()` — stop and return a `RecordedWorkflow` object
- `sentinel.exportWorkflowAsCode(workflow)` — export as executable TypeScript string
- `sentinel.exportWorkflowAsJSON(workflow)` — export as JSON string
- `sentinel.replay(workflow)` — re-execute a recorded workflow step by step

#### 🕵️ Proxy & Stealth Mode
- `proxy?: { server, username?, password? }` option — pass proxy to Playwright browser launch
- `humanLike?: boolean` option — adds random delays between actions to mimic human behavior
- User-Agent rotation pool (4 agents) applied automatically on each session

#### 📡 Event System & Observability
- `Sentinel` now extends `EventEmitter`
- `action` event — emitted after every successful `act()` call
- `navigate` event — emitted after every `goto()` call
- `close` event — emitted when the browser is closed

#### 💰 Token Tracking (`src/utils/token-tracker.ts`)
- New `TokenTracker` class — tracks input/output tokens per LLM call
- `sentinel.getTokenUsage()` — returns `{ totalTokens, inputTokens, outputTokens, estimatedCostUsd, calls }`
- `sentinel.exportLogs(filePath)` — exports full usage log as JSON

#### 🎬 Extended Action Types (`src/api/act.ts`)
- `scroll-down` / `scroll-up` — scroll the page
- `scroll-to` — scroll to a specific element
- `press` — keyboard shortcuts (Enter, Escape, Tab, Ctrl+A, etc.)
- `select` — choose an option from a dropdown
- `double-click` — double-click an element
- `right-click` — right-click / context menu

#### 🚨 Structured Error Classes (`src/types/errors.ts`)
- `SentinelError` — base error class with `code` and `context`
- `ActionError` — thrown when an action fails after all retries
- `ExtractionError` — thrown when structured extraction fails
- `NavigationError` — thrown when navigation fails
- `AgentError` — thrown when the agent loop fails or gets stuck
- `NotInitializedError` — thrown when calling methods before `init()`
- `LLMError` — thrown when the LLM provider returns an error

#### 📁 Examples (`examples/`)
- `examples/hacker-news.ts` — extract top stories from Hacker News
- `examples/google-search.ts` — Google search with structured extraction + Record & Replay demo
- `examples/agent-amazon.ts` — autonomous shopping agent on Amazon

---

### Changed

- `SentinelOptions` extended with 8 new options: `browser`, `proxy`, `humanLike`, `sessionPath`, `provider`, `visionFallback`, `viewport`, `domSettleTimeoutMs`
- `Sentinel` class now extends `EventEmitter`
- Internal LLM calls refactored to use the `LLMProvider` interface throughout all engines
- `act()` schema enum extended with 7 new action types
- README completely rewritten to reflect all new features and APIs

---

## [1.0.0] - 2025-01-01

### Added

- Initial release of Sentinel
- Playwright-based browser automation (Chromium)
- AOM-based state parsing via Chrome DevTools Protocol (CDP)
- `act(instruction)` — natural language actions (`click`, `fill`, `hover`)
- `extract(instruction, schema)` — structured data extraction with Zod
- `observe(instruction?)` — page observation via Accessibility Object Model
- Semantic verification loop — confirms every action and retries on failure
- Parallel CDP requests for high-performance state parsing
- State caching with 500ms TTL
- Variable interpolation in instructions (`%varName%`)
- Gemini Flash / Pro integration via `@google/generative-ai`
- `verbose` logging levels (0 = silent, 1 = actions, 2 = debug)
