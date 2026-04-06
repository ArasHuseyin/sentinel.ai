# Changelog

All notable changes to `@isoldex/sentinel` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.4.0] - 2026-04-06

### Added

#### Persistent browser profile (`userDataDir`)
New `userDataDir` option in `SentinelOptions` enables a persistent Chromium profile directory. Unlike `sessionPath` (which only saves cookies and localStorage), `userDataDir` persists the entire browser profile including **IndexedDB**, ServiceWorkers, and cached credentials. This is required for services that store authentication data in IndexedDB (e.g. WhatsApp Web, progressive web apps, and other SPA-based messaging platforms).

```typescript
const sentinel = new Sentinel({
  apiKey: process.env.GEMINI_API_KEY!,
  userDataDir: './profiles/whatsapp',  // created automatically if missing
});
```

On first run: complete the login once (e.g. scan WhatsApp QR code). On all subsequent runs the session is restored automatically from the profile directory — no QR code or re-authentication required.

When `userDataDir` is set, `sessionPath` is ignored.

---

## [2.3.2] - 2026-04-06

### Fixed

- Include `README.md` and `CHANGELOG.md` in npm package `files` list so they appear on the npm registry page.
- DOM context enrichment now skips hidden elements (`offsetParent === null`) when collecting headings, paragraphs, and leaf texts — prevents hidden popovers and modals from polluting card button context.
- `img[alt]` enrichment skips hidden images and filters out file-description-style alt texts (e.g. containing `/`, `icon`, `logo`, `check`).

---

## [2.3.1] - 2026-04-06

### Added

#### Native vision support for all LLM providers
Added optional `analyzeImage(prompt, imageBase64, mimeType?)` method to the `LLMProvider` interface. All four built-in providers now implement it:

- **GeminiProvider** — uses the configured Gemini model
- **OpenAIProvider** — uses GPT-4o (or the configured model)
- **ClaudeProvider** — uses Claude 3 multimodal API
- **OllamaProvider** — uses the configured model with the Ollama `images` field (llava, bakllava, etc.)

`VisionGrounding` now accepts any `LLMProvider` instead of a raw Gemini API key. Setting `visionFallback: true` works with any vision-capable provider — no `GEMINI_VERSION` or Gemini API key required for non-Gemini setups. Providers that do not implement `analyzeImage` log a warning and skip vision grounding gracefully.

### Changed

#### Default Gemini model updated to `gemini-3-flash-preview`
The built-in fallback model name in `GeminiProvider`, `index.ts`, and `onix-test.ts` has been updated from `gemini-2.0-flash` to `gemini-3-flash-preview`.

---

## [2.3.0] - 2026-04-06

### Added

#### Contextual button naming (StateParser)
Generic button labels such as "Tarif auswählen" are now automatically enriched with surrounding card and container context. The StateParser walks AOM ancestors and performs a DOM traversal of nearby headings, paragraphs, and short span/div texts (badges, labels, tags under 35 characters) to construct a fully qualified label of the form `"Kelag | Fixtarif | 17,40 cent/kWh: Tarif auswählen"`. This allows the LLM to distinguish identically-named buttons across card-based UIs without any changes to the calling code.

#### Off-screen element enrichment (StateParser)
An `enrichWithDOMContext` post-processing pass now runs for all generic-named AOM elements, using `elementFromPoint` with scroll-adjusted coordinates. Elements that are off-screen or partially visible receive the same context enrichment as visible elements.

#### Leaf span/div badge detection (StateParser)
Short leaf `span` and `div` texts (under 35 characters) such as "Sale", "Fixtarif", or "Empfohlen" are now included in button context enrichment. These badge-like elements were previously invisible to the LLM.

#### `withTimeout` wrapper on all actions (ActionEngine)
Every Playwright mouse and keyboard operation (`click`, `fill`, `press`, `hover`, `wheel`, etc.) is now wrapped in a 10-second timeout. This prevents individual actions from hanging indefinitely when an element is temporarily unresponsive.

#### Viewport bounds check before click (ActionEngine)
Before attempting a coordinate-based click, the ActionEngine verifies that the element's bounding box intersects the viewport. If the element is out of bounds, the action throws immediately and the semantic fallback layer calls `scrollIntoViewIfNeeded` before retrying.

#### Radio/checkbox JS click fallback (ActionEngine)
Radio and checkbox inputs that are visually hidden via CSS (a common pattern in design systems) are now handled by traversing from the input element to its closest `label` ancestor and clicking that, falling back to a direct JavaScript `.click()` if no label is found.

#### 4-strategy locator chain (ActionEngine)
When coordinate and Vision Grounding approaches are exhausted, the locator strategy now tries four approaches in order: exact `role` + `name` match, inexact `role` + `name` match, CSS `:has-text` selector, plain text locator. This significantly improves success rates on elements without ARIA roles.

#### Verifier: checked-state fast path (Verifier)
The Verifier now detects radio and checkbox selection changes directly by comparing checked state before and after an action, returning `{ success: true, confidence: 0.92 }` without an LLM call. This reduces token usage for form-heavy workflows.

#### LLM retry with exponential backoff — all providers
OpenAI, Claude, and Ollama providers now implement the same retry-with-backoff logic that Gemini already had: up to 3 attempts, doubling delay starting at 1 second, triggered on HTTP 429, 503, `ECONNRESET`, and timeout errors.

#### Instruction loop detection (AgentLoop)
The AgentLoop now aborts with a clear error message if the same instruction appears in three consecutive steps without producing a page state change. This prevents the agent from spinning indefinitely on a stuck planner.

### Changed

#### `mouse.wheel` scroll (ActionEngine)
Scroll actions now use `page.mouse.wheel()` instead of `window.scrollBy()` and `PageDown` key events. `mouse.wheel` routes scroll events to the actual scrollable container under the cursor, which means scroll actions work correctly inside SPA content panes and overflow containers, not only at the window level.

#### MutationObserver DOM settle (Driver / ActionEngine)
The post-action DOM settle mechanism has been replaced. Instead of waiting for `networkidle` (which could take up to 3 seconds on SPAs), Sentinel now attaches a `MutationObserver` that resolves after 300ms of DOM silence, with a hard cap of 3 seconds. Typical settle time is now ~300ms.

### Fixed

#### Verifier: LLM error resilience
When the LLM call inside the Verifier throws an unexpected error, the Verifier now returns `{ success: true, confidence: 0.5 }` instead of propagating the exception. Automation continues rather than aborting on transient provider errors.

### Documentation

- Published [VitePress documentation site](https://arashuseyin.github.io/sentinel-docs/) covering the full API reference, configuration guide, LLM provider setup, architecture overview, and error handling.
- Added support and business contact email (`hueseyin.aras1@gmail.com`) to README and npm package metadata.
- Removed internal Development section from README (repository is private).

---

## [2.2.1] - 2026-04-06

### Fixed

- Added `"default"` entry to the `exports` field in `package.json`, resolving `ERR_PACKAGE_PATH_NOT_EXPORTED` errors when importing Sentinel via `tsx` or CommonJS-based loaders in consumer projects.

---

## [2.2.0] - 2026-04-06

### Changed

- `ClaudeProvider` default model updated to `claude-sonnet-4-6`.
- README: Supported models table updated with current Claude 4.6 model identifiers (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-6`) and latest Gemini model names.
- README: Quickstart section clarifies that `.env` is only required for the default Gemini provider and is loaded automatically via `dotenv`.

### Added

- `llm-providers.test.ts` — test coverage for all four LLM providers (Gemini, OpenAI, Claude, Ollama), including model default checks and README completeness assertions.

---

## [2.1.0] - 2026-04-06

### Fixed

- Interactive elements without an `aria-label` or `aria-labelledby` attribute (e.g. cards with a child `<h4>`) are now correctly recognized by the StateParser.
- New `extractSubtreeText()` method — recursively extracts visible text from the AOM subtree of a node (up to depth 6, max 120 characters). Covers headings, paragraphs, spans, and icon labels.
- `nodeToUIElement()` now resolves element names using the priority chain: `aria-label` → `aria-description` → subtree text.

---

## [2.0.0] - 2026-04-05

### Added

Major release — Sentinel becomes a full AI agent framework.

- **Autonomous Agent Loop** (`AgentLoop`, `Planner`, `Memory`) — `sentinel.run(goal, options?)` with Plan → Execute → Verify → Reflect cycle, `maxSteps` limit, stuck-detection abort, and `onStep` callback.
- **Vision Grounding** (`VisionGrounding`) — Gemini Vision fallback in `act()` when AOM cannot locate an element. `sentinel.screenshot()` and `sentinel.describeScreen()` exposed as public API. Controlled via `visionFallback` option.
- **Multi-LLM Provider System** (`LLMProvider` interface, `GeminiProvider`, `OpenAIProvider`, `ClaudeProvider`, `OllamaProvider`) — swap the underlying LLM with a single `provider` option.
- **Multi-Tab Support** — `sentinel.newTab()`, `sentinel.switchTab()`, `sentinel.closeTab()`, `sentinel.tabCount`.
- **Multi-Browser Support** — `browser` option accepts `'chromium'`, `'firefox'`, or `'webkit'`.
- **Session Persistence** — `sentinel.saveSession(filePath)` saves `storageState`; `sessionPath` option auto-loads on `init()`. `sentinel.hasLoginForm()` detects login pages.
- **Record and Replay** (`WorkflowRecorder`) — `startRecording()`, `stopRecording()`, `exportWorkflowAsCode()`, `exportWorkflowAsJSON()`, `replay()`.
- **Proxy and Stealth Mode** — `proxy` option passes proxy configuration to Playwright. `humanLike` option adds randomized delays. Automatic User-Agent rotation.
- **Event System** — `Sentinel` extends `EventEmitter`. Emits `action`, `navigate`, and `close` events.
- **Token Tracking** (`TokenTracker`) — `sentinel.getTokenUsage()` returns token counts and estimated cost. `sentinel.exportLogs(filePath)` exports a JSON log.
- **Extended Action Types** — `scroll-down`, `scroll-up`, `scroll-to`, `press`, `select`, `double-click`, `right-click`.
- **Structured Error Classes** (`SentinelError`, `ActionError`, `ExtractionError`, `NavigationError`, `AgentError`, `NotInitializedError`, `LLMError`).
- **Examples** — `examples/hacker-news.ts`, `examples/google-search.ts`, `examples/agent-amazon.ts`.

### Changed

- `SentinelOptions` extended with `browser`, `proxy`, `humanLike`, `sessionPath`, `provider`, `visionFallback`, `viewport`, `domSettleTimeoutMs`.
- `Sentinel` class now extends `EventEmitter`.
- All internal LLM calls refactored to use the `LLMProvider` interface.

---

## [1.0.0] - 2025-01-01

### Added

- Initial release.
- Playwright-based browser automation (Chromium).
- AOM-based state parsing via Chrome DevTools Protocol (CDP).
- `sentinel.act(instruction)` — natural language actions (`click`, `fill`, `hover`).
- `sentinel.extract(instruction, schema)` — structured data extraction with Zod.
- `sentinel.observe(instruction?)` — page observation via the Accessibility Object Model.
- Semantic verification loop — confirms every action and retries on failure.
- Parallel CDP requests for high-performance state parsing.
- AOM state caching with 500ms TTL.
- Variable interpolation in instructions (`%varName%`).
- Gemini Flash / Pro integration via `@google/generative-ai`.
- `verbose` logging levels: 0 = silent, 1 = actions, 2 = debug.
