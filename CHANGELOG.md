# Changelog

All notable changes to `@isoldex/sentinel` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.1.5] - 2026-04-25

### Added

- **Output-token cap with adaptive retry across all LLM providers** — every `generateStructuredData` call is now bounded by a default `maxOutputTokens=16000` budget (overridable per call via `GenerateOptions.maxOutputTokens`). When the provider signals truncation (`finishReason='MAX_TOKENS'` on Gemini, `finish_reason='length'` on OpenAI, `stop_reason='max_tokens'` on Claude, `done_reason='length'` on Ollama), the call is automatically retried once at 32000 tokens. Bounds the worst-case cost spike from runaway generations (a single Amazon-search call at 64k tokens cost ~$0.40 before; the same scenario now caps at ~$0.05 worst-case) without affecting the 99 % of calls that finish well under 16k. Validated end-to-end on `amazon.de` via the MCP server: largest observed output was 12,248 tokens, no truncation retry triggered, total session cost $0.0068.

### Fixed

- **Extract hallucination on redirected / empty / off-topic pages** — two-layer grounding guard:
  1. **Prompt-level STRICT GROUNDING RULES** in `EXTRACT_SYSTEM_INSTRUCTION` — every value must be traceable to AOM elements or visible page text; if the page lacks the requested data, return the schema shape with empty / null values instead of fabricating from prior knowledge.
  2. **Deterministic post-extract grounding filter** — collects every string leaf from the LLM response, checks each (≥5 chars, first-40-char probe) as a case-insensitive substring against `pageText` + AOM names/values; if fewer than 30 % of ≥3 scoreable strings match the page corpus, replaces the result with an empty-shape equivalent (arrays→[], strings→'', numbers→0). Catches the cooperative-failure case where Gemini ignores the prompt rules under strong schema pressure (e.g. asking for "5 pens" on `example.com` no longer returns 5 imagined pens — returns `{pens: []}`).
- **HTTP MCP transport returned 500 on every request after the first** — the original single-shared-transport design broke after `initialize` because `StreamableHTTPServerTransport`'s request/response wiring is single-use. `startHttpTransport()` now creates a fresh `McpServer` + transport per incoming HTTP request and tears them down on `res.on('close')`. The shared `Sentinel` browser singleton (via `getOrInit()`) lives across requests, so the per-request overhead is just the wiring, not the browser.

### Changed

- **`GenerateOptions.maxOutputTokens?: number`** — new optional per-call budget. All four providers (Gemini, OpenAI, Claude, Ollama) honour it via their respective output-cap fields (`generationConfig.maxOutputTokens`, `max_tokens`, `max_tokens`, `options.num_predict`). The Claude provider's previous hardcoded `max_tokens: 4096` for structured calls is removed in favour of the shared default.

---

## [4.1.4] - 2026-04-24

### Added

- **HTTP MCP transport** — run the Sentinel MCP server over Streamable HTTP instead of stdio. Set `SENTINEL_MCP_HTTP=1` (optional `SENTINEL_MCP_PORT`, `SENTINEL_MCP_HOST`) and point the client at `http://127.0.0.1:3333/mcp`. Enables shared team instances, Docker/Kubernetes deployments, and a local dev loop where the MCP client reconnects transparently via exponential backoff after the server restarts. Stdio remains the default — no change for existing `sentinel-mcp` users.
- **npm scripts**: `mcp:stdio`, `mcp:http`, `mcp:dev` (HTTP + `node --watch` for hot reload), `build:watch`.
- **`previousFailures` planner feedback loop** — when the verifier rejects an action, the next retry's planner prompt now includes the rejection reason and the previously executed action, instructing the LLM to escalate strategy rather than repeat the same move. Fixes the "fill typed text but never pressed Enter" loop on Amazon / Wikipedia search.
- **Goal-aware LLM verification** — `Verifier.verifyAction()` accepts an optional 4th parameter `userInstruction`. The slow-path prompt now distinguishes the user's goal ("search AND submit") from the planner's atomic action ("fill search box"), so success is rated against the goal, not the side-effect.

### Fixed

- **Verifier false-positive on typed-but-not-submitted actions** — a centralized submit-intent guard now skips fast paths 4a/4b/5/6 (toggle / checked-state / element-delta / focus) when the instruction implies submission (search, submit, press Enter, go, navigate) but URL+title are unchanged. Previously Amazon and Wikipedia search returned "✅ DOM changed significantly" because the autocomplete dropdown opening fooled the element-delta path, leaving the caller to believe the submission fired.
- **Cookie/consent banners not dismissed proactively** — `goto()` now calls `tryRecoverFromBlocker` once after navigation, so the first `act()`/`extract()` call sees a clean viewport. On MUI, Amazon, and Reddit this eliminates the overlay-blocks-first-interaction failure mode.
- **Cookie banners without keywords in interactive elements** — MUI's "Allow analytics" + "Essential only" pair is now detected via the characteristic accept+reject button-pair pattern, even when no interactive element carries the word "cookie"/"consent" (the heading is outside the AOM we parse). Accept-button regex widened to include `allow (all|analytics|cookies|tracking|selected)`, `accept and (continue|close)`, and `einverstanden`.
- **Pattern and locator caches overrode planner re-plan after verification failure** — both caches are now skipped when `previousFailures` is non-empty, so the re-plan actually reaches the LLM with the failure feedback instead of deterministically replaying the failed strategy.
- **Extract system prompt moved to `systemInstruction`** — the static role/format guidance no longer ships in each user-prompt, letting provider-level caches (Gemini implicit, Claude `cache_control`, OpenAI automatic) deduplicate it.

### Changed

- **`ActOptions.previousFailures?: string[]`** — new optional field carrying verifier rejections across retries. No existing callers pass it; the outer retry loop inside `Sentinel.act()` populates it automatically.

---

## [4.1.3] - 2026-04-23

### Added

- **`systemInstruction` across all LLM providers** — static prompt prefixes (act decision rules, planner rules, reflect rules, extract format) are now passed separately from dynamic per-call content. Gemini caches the `GenerativeModel` instance per `systemInstruction` text so identical prefixes hit the implicit prompt cache; Claude marks the system block with `cache_control: { type: 'ephemeral' }`; OpenAI sends a dedicated `system` message; Ollama prepends. Reduces input-token cost on repeated calls and measurably cuts latency on the Gemini path.
- **`run({ timeoutMs })` budget** — the agent loop now supports a wall-clock timeout. When the budget is exhausted the current step completes, the reflect call is skipped, and the run returns with `timedOut: true` instead of an open-ended retry storm.
- **`stuckOnTarget` loop detection** — when the planner picks the same action+target three times and at least one attempt has already failed, the agent breaks out with a structured failure instead of grinding against the same element.
- **`extractLoop` detection** — extract calls are fingerprinted by their returned data; identical fingerprints in back-to-back steps short-circuit instead of redoing the LLM call.
- **Step memory carries extraction payloads** — `StepRecord` now has a `data` field and `getSummary()` appends a truncated JSON snippet (300-char cap). The planner sees what was already extracted and can decide to finish instead of re-extracting.

### Fixed

- **Cookie-banner recovery no longer dismisses product links** — the accept-button matcher picked up substrings like `"Accepted"` inside `"Eczema Association Accepted"` and `"alle "` inside `"Alle 3 in den Einkaufswagen"`, occasionally clicking an Amazon product card while trying to close a consent banner. Fix stacks three guards: a page-level consent-context check (`/\b(cookies?|consent|gdpr|dsgvo|datenschutz|privacy|privatsph[aä]re)\b/i`), a 50-character cap on candidate button labels, and an anchored pattern (`/^\s*(akzeptieren|accept( all| cookies)?|zustimmen|i ?agree|got it|verstanden|alle[s]? (akzeptieren|cookies?|annehmen)|allow all)\s*$/i`).
- **Select/listbox popovers stayed closed on second pick** — when a custom `<select>` widget used a hidden native element plus a separately-rendered popover (Amazon sort, MUI Select, headless UI comboboxes), subsequent `select` calls kept re-clicking the trigger instead of picking from the already-open popover. `act()` now checks a visible `role="listbox" + role="option"` popover first via `clickBestMatchingOption`, then tries `trySetNativeSelectValue`, and only opens the trigger as a last resort. The coordinate-mismatch check is bypassed while a popover is open (`skipCoordCheckForOpenSelect`).
- **Locator cache corruption on crash / concurrent processes** — `FileLocatorCache` writes are now debounced (150 ms) and go through a temp-file-plus-atomic-rename path. `flush()` is called from `Sentinel.close()` and a `beforeExit` handler, so pending writes always drain before the process exits. Prior code wrote the JSON synchronously inline, blocking the event loop on every hit and risking half-written files on forced shutdown.
- **Agent step verification was click-only** — `fill` and `select` now use the same structural verification signals as `click` (URL change, title change, element-count delta, state fingerprint, interaction-flip). Silent no-op fills stop reporting success.
- **`hasBlocker` tripped on open listbox/menu popovers** — the blocker check now ignores regions whose only interactive descendants are `role="option"` / `role="menuitem"` and requires an actual interactive role inside the modal region before treating it as a blocker. Prevents the recovery pathway from firing Escape against a just-opened select.
- **Post-recovery ScrollTo closed Amazon's open popover** — the fallback `scrollTo(target)` after recovery now skips when a `[role="option"]` / `[role="listbox"]` / `[role="menu"]` is visible.
- **Empty LLM candidate lists silently became "no target"** — when the provider returned `{ candidates: [] }` without setting `notFound: true`, `act()` treated it as "element exists but unreachable" and looped. The engine now synthesises `notFound = true` on empty candidates so the scroll-and-retry path engages.
- **z-index popup removal compared strings** — `parseInt(s.zIndex, 10) > 999` replaces `s.zIndex > "999"`, which evaluated `"1000" > "999"` as `false` and left tall overlays on the page.
- **`with-retry` log lost the failure cause** — the warning line now includes the HTTP status (when present) and the first line of the error message (capped at 160 chars), so rate-limit vs. network vs. server-overload is distinguishable from the log alone.

### Changed

- **Planner prompts split into system + user parts** — `PLANNER_SYSTEM_INSTRUCTION` and `REFLECT_SYSTEM_INSTRUCTION` are now module-level constants passed via `GenerateOptions.systemInstruction`. No behavior change beyond the cache-hit improvement described above.
- **Removed redundant `invalidateCache()` at step start** — the AOM cache's 2 s TTL already covers the step boundary; the forced invalidation added a full re-parse per step with no correctness benefit.

---

## [4.1.2] - 2026-04-19

### Fixed

- **Vision Grounding — HiDPI coordinate mismatch** — `VisionGrounding.findElement()` now reads the screenshot's native pixel dimensions from the PNG header and rescales the model's response to CSS pixels before handing them to `page.mouse.click`. On displays with `deviceScaleFactor > 1` the screenshot is larger than the CSS viewport; previously the LLM received viewport dimensions but returned coordinates in the screenshot's pixel space, causing clicks to land in the wrong quadrant.
- **Vision Grounding — silent (0, 0) click on incomplete responses** — when the LLM returned `found: true` without coordinate fields, the old code silently defaulted to `{ x: 0, y: 0, width: 50, height: 30 }` and clicked the top-left corner. `findElement()` now returns `null` when any of `x`, `y`, `width`, `height` is missing or non-finite, or when width/height are zero or negative.
- **Vision Grounding — out-of-bounds bboxes** — the computed click center is validated against the viewport; if the model returns coordinates whose center falls outside the viewport, `findElement()` returns `null` instead of issuing an off-screen click.
- **Vision Grounding — low-confidence responses** — the prompt now asks for a `confidence` field (0.0 to 1.0); responses below 0.5 are rejected. Reduces false clicks on ambiguous pages.
- **Vision Grounding — prompt ambiguity** — the prompt explicitly specifies top-left origin, positive-Y-down, and "absolute image pixels (NOT normalized, NOT percentages, NOT thousandths)" to prevent providers that default to normalized coordinate systems (notably Claude's computer-use convention) from silently returning wrong units.
- **Vision Grounding — ignored verbose level** — per-call info and warning logs now respect the `verbose` level passed from `SentinelOptions`. `verbose: 0` fully silences vision fallback; `verbose >= 2` surfaces find-element diagnostics.

### Changed

- **Removed keyword-based pre-scroll discovery** — previously `act()` pre-scrolled up to 3600px (2 batches × 3 × 600px) whenever no element's `role + name` contained an instruction token. This caused phantom scrolling on pages where target labels differ from the instruction vocabulary (e.g. Amazon German filter labels vs. English brand names like "Sony", sort options, localized value text). Over a multi-step `run()` the page could drift 10k–30k pixels downward before any meaningful action was taken.
- **LLM-driven `notFound` retry** — the action-decision schema now includes a `notFound: boolean` field. When no listed element is plausibly the target, the LLM sets `notFound: true` and the engine performs a single ~80%-viewport scroll, re-parses, and re-asks. Capped at one retry per `act()` call. Replaces the old heuristic pre-scroll with an explicit semantic signal.

---

## [4.1.1] - 2026-04-19

### Added

- **Pattern cache** — selector patterns discovered during `act()` are cached per-site and reused on subsequent runs, skipping LLM calls entirely when the cache hits.
- **CAPTCHA detection + solving hooks** — detects common CAPTCHA widgets (reCAPTCHA, hCaptcha) and exposes a pluggable solver interface.
- **MUI benchmark test suite** — 12 E2E tests against Material UI documentation components (slider, datepicker, autocomplete, etc.) to validate widget coverage.
- **Pattern-signature utilities** — browser-side signature generation for deterministic element fingerprinting.
- **CAPTCHA solver stub** — `src/reliability/captcha-solver.ts` for integration with external CAPTCHA services.

### Fixed

- **Slider handle type annotation** — `page.evaluate()` callback now correctly types `ElementHandle` as `Node | null` (was `HTMLElement | null`), fixing a TypeScript overload resolution error.
- **Error messages translated to English** — internal error/tip messages in `buildFailureMessage()` now use English instead of German for consistency with public-facing API.

### Changed

- **Slimmed README** — moved detailed API documentation to [isoldex.ai/docs](https://isoldex.ai/docs). README now focuses on hero demo, quick start, and feature overview.
- **Demo GIFs added to README** — GitHub trending extraction and Amazon.de multi-step automation shown visually.
- **Removed internal tooling files** from the npm package (`CLAUDE.md`, `task.md`) to keep the published tarball lean.

### Documentation

- Added `demo.mjs` — runnable demo script showing GitHub trending extraction.
- Session notes moved out of the published package.

---

## [4.1.0] - 2026-04-11

### Added

- **`sentinel.fillForm(json)`** — declarative form filling with a single JSON object. Sentinel maps keys to form fields via LLM and fills them automatically, top-to-bottom, validating field population after each fill.
- **`sentinel.intercept(urlPattern, trigger)`** — network interception: capture raw API responses (JSON) during browser actions instead of scraping the DOM. Returns parsed response bodies that match the URL pattern.
- **TOTP/MFA automation** — `mfa: { type: 'totp', secret: '...' }` option on `Sentinel`. The agent auto-generates RFC 6238 TOTP codes during login flows. Zero-dependency implementation via Node's `crypto` module. `generateTOTP()` also exported for standalone use.
- **`plannerModel` / `plannerProvider`** — use a stronger model for planning decisions (e.g. Gemini 3.1 Pro) while keeping a cheap model (Flash) for action execution. Reduces cost while preserving decision quality.
- **`mode: 'aom' | 'hybrid' | 'vision'`** — configurable element detection strategy. `aom` uses the accessibility tree only (fast, cheap), `hybrid` adds vision fallback on coordinate mismatch, `vision` uses vision grounding primarily (slowest, most robust).
- **Click-target verification** — before every click/fill, the engine verifies via `elementFromPoint()` that the element at the target coordinates actually matches the intended target. Falls back to Playwright's `getByRole` locator on mismatch.
- **Playwright locator fallback** — on coordinate mismatch (common with dynamic dropdowns), the engine automatically switches to `page.getByRole(role, { name })` to locate and click the correct element. Tries multiple name variants (e.g. "Info: Weiter" tries "Weiter" after the colon).
- **Impossible coordinates detection** — elements with clearly invalid AOM coordinates (y < -500) skip scroll attempts and go directly to the locator fallback.
- **Widget pattern detection** — 9 structural DOM patterns for detecting custom widgets: button+combobox, `aria-haspopup`, label+hidden-input, `<input>`+datalist, tablist, date/time pickers, CSS-library dropdowns (React Select, Ant Design, MUI, ng-select, Select2, Chosen), hidden `<select>`+custom trigger, and compound datepickers.
- **Universal slider-fill** — 3-strategy cascade for `role="slider"` elements: (1) native `<input type="range">` value assignment, (2) sibling text-input fallback for container-paired numeric inputs (Amazon/idealo/Zalando price filters), (3) keyboard simulation via `aria-valuemin/max/now` with Arrow keys.
- **Validation error detection** — reads form error messages via `aria-invalid`, `role="alert"`, `class*="error"` and passes them to the planner as an `error` field on the form element.
- **Form field/button separation** — planner prompt structurally separates form fields from buttons. Fields shown first with filled/unfilled status indicators (●/○). Prevents premature form submission.
- **Proactive blocker dismissal** — `tryRecoverFromBlocker()` runs at the start of each agent step (first 3 steps), not only after failures. Cookie banners and modals are dismissed before the planner analyzes the page.
- **Cookie recovery improvements** — prioritizes accept buttons over settings buttons. Filters out cookie policy links that would navigate away. Ignores technical container IDs in mismatch checks (e.g., `auto.fahrzeug.erstbesitzv-radiogroup`).
- **State fingerprint verification** — after each action, computes a compact fingerprint (role + name + region + value + error + state) to detect actual state changes. Catches false-success reports and prevents infinite retry loops.
- **Semantic loop detection** — compares action+target across steps instead of raw instruction text. `fill:Marke` and `fill:Modell` are correctly identified as different actions even if the planner rephrases.
- **Action-level retry** — 2 retries with 200ms/500ms backoff for transient failures (timeout, detached, disposed). Non-transient errors go directly to fallback.
- **Typing delay tuning** — 150ms settle before first keystroke, 90ms between characters (humanLike: 90–130ms random). Prevents dropped characters on reactive inputs.
- **Unicode tokenizer** — text normalization uses `\p{L}\p{N}` (Unicode categories) instead of `[a-z0-9]`. Supports all Latin-script languages (German umlauts, Turkish dotted-i, Czech diacritics).
- **Scroll discovery guardrails** — only triggers when page has fewer than 10 elements AND no keyword matches. Prevents unnecessary scrolling on content-rich pages.
- **Extract on goalComplete** — when the planner marks goal complete and plans an extraction simultaneously, the extraction now executes before stopping. Prevents lost data in single-turn workflows.
- **Extract deduplication** — if extraction already ran in a previous step, the goalComplete extraction reuses the existing data instead of making a duplicate LLM call.
- **Coordinate system fixes** — all `getBoundingClientRect()` calls in state parser add `scrollX/scrollY` for consistent document-space coordinates (prevents click mismatches on scrolled pages).
- **Zero-size element filter** — elements with width or height < 2px are excluded from the element set.
- **Locator name variants** — semantic fallback tries multiple name variants including short names after `:` prefix (e.g. "Info: Weiter" tries "Weiter").
- **Always-keep form fields** — form role elements (textbox, combobox, listbox, slider, etc.) are always kept in `filterRelevantElements()` regardless of keyword score.
- **Nearby buttons preservation** — buttons positionally near form fields (submit/proceed) are always kept regardless of keyword score.
- **Y-position sorting** — elements presented to the planner sorted top-to-bottom by visual position for deterministic output.

### Performance

- **Impossible coordinates → direct locator** saves ~700ms per element by skipping futile scroll attempts.
- **Network interception** uses `waitForLoadState('networkidle')` instead of fixed timeout for reliable response capture.
- **Extract dedup** saves one LLM call per agent run when goal-complete and extract coincide.

### Fixed

- Click-target verification on pages with dynamic dropdowns (durchblicker, Booking) — coordinates frequently pointed to wrong element after dropdown animation.
- Typing delay too short for reactive inputs (React Select, Ant Design) causing dropped characters.
- Wikipedia cookie recovery infinite loop — cookie-policy links were clicked repeatedly instead of accept buttons.

## [4.0.0] - 2026-04-11

### Breaking Changes

- **Default viewport changed from 1280×720 to 1920×1080** — larger viewport improves element detection on modern websites. Override with `viewport: { width, height }` if needed.
- **LLM action schema uses `candidates[]` instead of single `elementId`** — the LLM now returns up to 3 ranked candidates per action. Custom LLM providers must support the new response format; old single-`elementId` responses are auto-normalized for backward compatibility.
- **Prompt format changed from JSON to pipe-delimited** — element lists sent to the LLM use `id | role | name | region` format instead of pretty-printed JSON. Reduces token usage by ~40%.

### Added

- **Complex page robustness**
  - `contenteditable` detection — rich-text editors (WhatsApp, Slack, Gmail, Notion) are now discovered via dedicated `parseContentEditableElements()` with Shadow DOM piercing.
  - `[tabindex]` and `[contenteditable]` in DOM snapshot selector — custom interactive elements are no longer missed.
  - `data-placeholder` and `aria-placeholder` name fallbacks for form fields.
  - `fill` uses `Ctrl+A` instead of triple-click — works on both standard inputs and contenteditable divs.
  - `append` sends `Ctrl+End` after `End` to reach the absolute end of content.

- **Spatial region tags** — every element gets a `region` field (`header` | `nav` | `sidebar` | `main` | `footer` | `modal` | `popup`) based on DOM landmarks and positional heuristics. Sent to the LLM for spatial disambiguation.

- **Vision-augmented planning** — when a page has >100 elements and `visionFallback: true`, the planner receives a visual page description alongside the element list for better decision-making.

- **Scroll discovery** — when no elements match the instruction keywords, Sentinel batch-scrolls (2 batches × 3 scrolls) and re-parses to find elements in virtual-scrolling containers.

- **Top-3 candidate ranking** — the LLM returns up to 3 element candidates with confidence scores. On failure, the next candidate is tried immediately without a new LLM call (~50ms vs ~800ms retry).

- **Pre-action validation** — before each click, `validateTarget()` checks via `elementFromPoint()` whether the element is disabled, hidden, or blocked by an overlay. Blocked candidates are skipped instantly.

- **Smart error recovery** — `tryRecoverFromBlocker()` automatically dismisses cookie/consent banners and closes modals (via Escape) before retrying the action. No competitor has this.

- **Adaptive planner filtering** — the planner uses `filterRelevantElements(elements, goal, 50)` with goal-keyword scoring instead of a hard `slice(0, 40)`.

- **Form-aware planner rules** — the planner prompt now prioritizes filling visible form fields before clicking navigation buttons, recognizes dropdown selectors, and avoids repeating failed actions.

- **Agent-loop state verification** — after each `act()` step, the agent compares page state before/after. Actions that report success but leave the page unchanged are re-classified as failures, preventing infinite loops.

- **Semantic loop detection** — instruction-loop detection now normalizes instructions and checks element targets, catching loops where the planner rephrases the same action differently.

- **DOM fallback for off-screen AOM** — when all AOM elements are outside the visible viewport (common in React SPAs), `parseDOMSnapshot` is triggered regardless of element count.

### Performance

- **Parallel evaluate calls** — `parseFormElements`, `parseContentEditableElements`, and `parseFrameElements` now run concurrently via `Promise.all()` (~60-70% faster parse).
- **Merged enrichment + region detection** — `enrichAndDetectRegions()` replaces two separate `page.evaluate()` calls with one (~150ms saved per parse).
- **Verification fast-paths** — 2 new fast-paths (element count delta ≥5, focus change) skip the LLM verification call. Scroll actions skip verification entirely.
- **Compact prompt format** — `id | role | name | region` pipe format replaces pretty-printed JSON in all LLM prompts (~40% token reduction).
- **Batch scroll discovery** — 2 batches × 3 quick scrolls + 500ms settle instead of 5 × (scroll + 3s settle).
- **State cache TTL 500ms → 2000ms** — reduces redundant AOM parses in multi-action workflows.
- **MutationObserver tuning** — only observes `childList` + `subtree` (ignores attribute/characterData noise from SPAs).
- **Stop-word filtering** — tokenizer filters common words ("on", "the", "to") to prevent false-positive relevance matches.

### Fixed

- **Viewport coordinate handling** — `performAction()` now auto-scrolls elements into view and converts document-space AOM coordinates to viewport-space before clicking. Previously, all elements below the fold failed silently.
- **User-Agent strings updated** — Chrome 123/124 → Chrome 136/137, Firefox 125 → Firefox 138. Prevents "unsupported browser" blocks on modern websites.
- **Semantic fallback false-success** — the semantic fallback now verifies that the page state actually changed after the action. If unchanged, the action is marked as failed instead of returning a misleading `success: true`.
- **Agent fill/append/press verification** — `fill`, `append`, `press`, `type`, and `select` actions are excluded from the agent-loop's state-change check, since they modify field values without altering the DOM structure.

---

## [3.10.1] - 2026-04-08

### Fixed

- **Scroll verification false-negative** — `Verifier` now short-circuits scroll actions with `success: true` (confidence 0.95) instead of comparing AOM snapshots, which are identical before/after a scroll and always produced a failed verification.
- **`AIFixture.extract` type inference** — signature changed from `schema: unknown` to `schema: SchemaInput<T>`, so Zod schemas passed to `ai.extract()` now correctly infer the return type without requiring an explicit type parameter.
- **`SentinelOptions` re-exported from `@isoldex/sentinel/test`** — the type was imported internally but not exported, causing a TypeScript error when consumers imported it from the test subpath.
- **`@playwright/test` import path** — corrected from `playwright/test` to `@playwright/test` in the test fixture module.

---

## [3.10.0] - 2026-04-08

### Added

- **`IProxyProvider` interface + `WebshareProxyProvider` + `RoundRobinProxyProvider`** — dynamic proxy rotation without managing your own network.

  ```typescript
  // Round-robin through a static list
  const proxy = new RoundRobinProxyProvider([
    { server: 'http://p1:8080', username: 'u', password: 'pw' },
    { server: 'http://p2:8080', username: 'u', password: 'pw' },
  ]);

  // Fetch & rotate via Webshare API (lazy, cached on first call)
  const proxy = new WebshareProxyProvider({ apiKey: process.env.WEBSHARE_KEY! });

  const sentinel = new Sentinel({ apiKey, proxy }); // accepts ProxyOptions OR IProxyProvider
  ```

  - `IProxyProvider.releaseProxy()` lifecycle hook — called automatically on `sentinel.close()` so providers can track usage or return proxies to a pool.
  - Thread-safe deduplication: concurrent `getProxy()` calls during initial fetch wait on the same `Promise` instead of issuing parallel API requests.
  - `isProxyProvider(value)` type guard exported for custom integrations.

- **Bézier mouse movement (`humanLike: true`)** — when `humanLike` is enabled, every click, double-click, right-click, hover, fill, and append action now moves the mouse along a randomised cubic Bézier curve instead of jumping directly to the target.

  Implementation details:
  - Control points are randomly displaced perpendicular to the straight-line path, producing a natural arc.
  - Step count scales with distance (8–40 steps); timing is non-uniform — slower at start/end, faster in the middle (sine-shaped).
  - Pre-click pause: 80–200 ms (random).
  - Keystroke delay for `fill`/`append`: 30–80 ms per character.

- **`sentinel.runStream(goal, options?)`** — `AsyncGenerator<AgentStepEvent | AgentResult>` that streams agent steps in real time, followed by the final result.

  Designed for **Server-Sent Events** in Next.js App Router API routes or any `for await` consumer. Zero polling — uses an internal notify queue that wakes the generator exactly when new data arrives.

  ```typescript
  // Next.js API route
  export async function GET() {
    const sentinel = new Sentinel({ apiKey });
    await sentinel.init();
    await sentinel.goto('https://example.com');

    const stream = new ReadableStream({
      async start(controller) {
        for await (const event of sentinel.runStream('Find the checkout button')) {
          controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        }
        controller.close();
        await sentinel.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  ```

---

## [3.9.0] - 2026-04-08

### Added

- **OpenTelemetry / Observability** — Sentinel now emits traces and metrics via the `@opentelemetry/api` standard. Zero-overhead when no OTel SDK is configured (no-op API). Drop-in with any OTel-compatible backend (Datadog, Grafana, Jaeger, etc.).

  **Traces (spans):**
  | Span name | Emitted by | Key attributes |
  |---|---|---|
  | `sentinel.act` | `sentinel.act()` | `sentinel.instruction`, `sentinel.success`, `sentinel.action`, `sentinel.selector` |
  | `sentinel.extract` | `sentinel.extract()` | `sentinel.instruction` |
  | `sentinel.observe` | `sentinel.observe()` | `sentinel.instruction` |
  | `sentinel.agent` | `sentinel.run()` | `sentinel.goal`, `sentinel.max_steps`, `sentinel.goal_achieved`, `sentinel.total_steps` |
  | `sentinel.agent.step` | agent loop (per step) | `sentinel.step`, `sentinel.type`, `sentinel.instruction`, `sentinel.url`, `sentinel.success` |
  | `sentinel.llm` | every LLM API call | `llm.system`, `gen_ai.operation.name`, `llm.tokens.input/output/total`, `llm.cost_usd` |

  Spans are automatically nested: `sentinel.agent` → `sentinel.agent.step` → `sentinel.act` → `sentinel.llm`.

  **Metrics:**
  | Metric | Type | Labels |
  |---|---|---|
  | `sentinel.act.requests` | counter | `success` |
  | `sentinel.act.duration_ms` | histogram | — |
  | `sentinel.llm.requests` | counter | `llm.model`, `success` |
  | `sentinel.llm.tokens` | counter | `llm.model`, `direction` (input\|output) |
  | `sentinel.llm.duration_ms` | histogram | `llm.model` |
  | `sentinel.agent.steps` | histogram | `goal_achieved` |

  **Setup example (Jaeger):**
  ```typescript
  import { NodeSDK } from '@opentelemetry/sdk-node';
  import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

  const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
  sdk.start(); // must be called before new Sentinel(...)

  const sentinel = new Sentinel({ apiKey: '...' });
  // All sentinel.act() / sentinel.run() calls now emit spans automatically
  ```

- **`selector` now propagated from `ActionEngine` through `Sentinel.act()`** — previously the outer `Sentinel.act()` (which includes verification + retries) discarded the selector returned by the engine. It is now correctly forwarded in `ActionResult.selector`.

---

## [3.8.0] - 2026-04-08

### Added

- **Stable Playwright selector export** — `AgentResult.selectors` is now populated after every `run()` call. Each successful `act` step contributes one entry: a camelCase slug of the instruction maps to the most stable CSS selector for that element.
  ```typescript
  const result = await sentinel.run('Login with test@example.com');
  console.log(result.selectors);
  // { clickLoginButton: '[data-testid="login-btn"]', fillEmailField: '#email' }
  ```
  Copy the selectors directly into Playwright tests — no DevTools digging required.
- **`ActionResult.selector`** — individual `act()` calls now also expose the selector for the element that was acted on, for use cases outside the agent loop.
- **Selector priority** (most → least stable): `data-testid` / `data-cy` / `data-test` / `data-qa` → `#id` (non-generated) → `[name]` on form controls → `input[type][placeholder]` → `[aria-label]` → `[role]:has-text(...)` → `tag:has-text(...)`.
- **`slugifyInstruction()`** exported from `@isoldex/sentinel` — converts a natural-language instruction to a camelCase key. Duplicate slugs within one run get a numeric suffix.

---

## [3.7.0] - 2026-04-08

### Added

- **Prompt Caching** — `promptCache` option (`false` | `true` | `string`) caches LLM responses keyed by a hash of the prompt and schema. A cache hit costs zero tokens and skips the model entirely. Because the prompt includes the current URL, page title, and element list, the cache naturally misses when the DOM changes — no manual invalidation needed. Covers `act()`, `extract()`, `observe()`, and the agent loop.
  - `promptCache: true` — in-memory cache (default max 200 entries, LRU eviction)
  - `promptCache: 'sentinel-cache.json'` — file-persisted cache, survives process restarts
- **`sentinel.clearPromptCache()`** — programmatically flush the prompt cache (e.g. between test runs or after a major page transition).
- **`IPromptCache` interface** exported — implement it to plug in your own cache backend (Redis, SQLite, etc.).
- **Bug fix: `Sentinel.parallel()` factory errors are now isolated per task** — previously, if `factory()` threw (e.g. browser launch failure) the error propagated to `Promise.all` and could abort remaining tasks. Factory is now inside the try/catch so failures are recorded as `{ success: false, error: '...' }` like any other task error.
- **Bug fix: `extend()` CDP session leak** — calling `extend()` on the same page multiple times now detaches the previous CDP session before creating a new one.

### Changed

- `Sentinel.log()` level type widened from `0|1|2` to `0|1|2|3` (was silently truncating `verbose: 3` log messages).

---

## [3.6.0] - 2026-04-08

### Added

- **`Sentinel.parallel(tasks, options)`** — runs multiple independent agent tasks in parallel, each in its own browser session. A worker-pool limits simultaneous sessions to `concurrency` (default: `3`). Results are returned in input order regardless of completion order. Error in one task never affects others.
- **`onProgress` callback** — `parallel({ ..., onProgress: (completed, total, result) => ... })` fires after each task finishes. Enables progress bars, streaming dashboards, and early cancellation patterns.
- **`ParallelTask`**, **`ParallelResult`**, **`ParallelOptions`** types exported from the main package.
- **Monetisation hook** — the concurrency clamp point is explicitly annotated in `Sentinel.parallel()` so per-tier limits can be injected without touching call sites.

---

## [3.5.0] - 2026-04-07

### Added

- **Playwright-Page-Extension** — `sentinel.extend(page)` attaches `act()`, `extract()`, and `observe()` directly to any existing Playwright `Page` object. A dedicated CDP session and engine set are created for that page, sharing the LLM provider and configuration of the Sentinel instance. Drop-in integration for existing Playwright tests and scripts without changing the page fixture.
- **`verbose: 3` debug level** — New level exposes chunk-processing statistics (`X → Y elements sent to LLM`) and the full LLM decision JSON (`elementId`, `action`, `value`, `reasoning`) per `act()` call.

### Changed

- `verbose` option extended from `0 | 1 | 2` to `0 | 1 | 2 | 3`.
- `verbose: 1` now logs action summaries only (no reasoning). Reasoning moved to `verbose: 2` (previously all levels received reasoning unconditionally). This is a minor **breaking change** for anyone who relied on reasoning output at `verbose: 1`.
- `ActionEngine` accepts an optional `verbose` parameter; all internal log/warn calls respect the level — `verbose: 0` fully suppresses output.

---

## [3.4.0] - 2026-04-07

### Added

- **Chunk-Processing** — `filterRelevantElements()` scores page elements by keyword overlap with the instruction (tokenised, lowercase). On pages with more than `maxElements` interactive elements only the top-N are sent to the LLM — significantly reducing token usage and latency on content-heavy pages.
- **`maxElements` option** (default `50`) — configure the element budget per `act()` call via `SentinelOptions`.
- **Shadow DOM support** — `parseDOMSnapshot()` and `parseFormElements()` now pierce all shadow roots recursively via `queryShadowAll()`. Components built with Lit, Polymer, Stencil (Salesforce Lightning, ServiceNow, etc.) are now fully supported.
- **iframe support** — `parseFrameElements()` enumerates all same-origin frames, collects their interactive elements, and offsets coordinates into the main-page coordinate space. Cross-origin frames are skipped silently.

---

## [3.3.0] - 2026-04-07

### Added

#### Intelligent Error Messages (`ActionResult.attempts`)
When all action paths fail, `act()` now returns a structured diagnostic instead of the opaque `"Action failed: ..."` string. The `message` field includes:
- Which element was targeted and what instruction was given
- Every attempted path (`coordinate-click`, `vision-grounding`, `locator-fallback`) with its specific error
- An actionable tip based on the detected root cause (outside viewport → scroll suggestion, timeout → overlay hint, all paths exhausted → rephrase or enable vision fallback)

The new `attempts?: ActionAttempt[]` field on `ActionResult` gives programmatic access to the same data:

```typescript
const result = await sentinel.act('Click the checkout button');
if (!result.success) {
  console.log(result.message);  // full diagnostic with tip
  console.log(result.attempts); // [{ path, error }, ...]
}
```

`ActionAttempt` is exported from the package root.

#### README: Stagehand comparison table and benchmark
Added a "Why Sentinel over Stagehand?" section at the top of the README with a feature comparison table and cost/speed benchmark (~40× cheaper, ~33% faster per run using Gemini Flash vs. GPT-4o).

#### npm keywords updated for discoverability
Added `stagehand-alternative`, `browseruse-alternative`, `playwright-ai`, `selenium-alternative`, `mcp`, `self-healing` to package keywords.

---

## [3.2.0] - 2026-04-07

### Added

#### Self-Healing Locators (`locatorCache` option)
Sentinel can now cache successful locator lookups and skip the LLM entirely on repeated calls with the same URL and instruction. The first successful `act()` stores `{ action, role, name, value }` for the resolved element. Subsequent calls with the same URL + instruction find the element directly in the current DOM state — no LLM call, no token cost.

If the cached element is no longer in the DOM, or the action fails, the entry is automatically invalidated and the normal LLM path takes over.

Three modes:

```typescript
// In-memory: cached for the lifetime of this Sentinel instance
const sentinel = new Sentinel({ apiKey, locatorCache: true });

// File-persisted: survives process restarts, ideal for test suites
const sentinel = new Sentinel({ apiKey, locatorCache: '.sentinel-cache.json' });

// Disabled (default)
const sentinel = new Sentinel({ apiKey }); // or locatorCache: false
```

For test suites that hit the same pages repeatedly, this effectively makes most `act()` calls free after the first run. Stagehand has no equivalent.

The `ILocatorCache` interface is exported for consumers who want to provide a custom cache implementation (e.g. Redis-backed for distributed test runs).

---

## [3.1.1] - 2026-04-07

### Fixed

#### Stale DOM state on `act()` retries
`stateParser.invalidateCache()` was called only once before the retry loop. On the 2nd and 3rd attempt the agent re-read the DOM from a stale cache, causing it to repeat actions based on outdated state. The cache is now invalidated at the start of every attempt.

#### `closeTab()` corrupts active page index
When a tab with an index lower than the currently active tab was closed, `activePageIndex` was not decremented. All subsequent `getPage()` calls pointed to the wrong tab or crashed with `undefined`. Fixed with a pre-splice index comparison.

#### `elementCounter` race condition in `StateParser`
`elementCounter` was an instance variable reset at the start of every `parse()` call. Parallel `parse()` calls (via `Promise.allSettled`) would reset each other's counter mid-run, producing duplicate element IDs. The counter is now a local variable threaded through `parseDOMSnapshot`, `parseFormElements`, and `nodeToUIElement`.

#### Wrong model in `GeminiProvider.generateText()` with `systemInstruction`
When `generateText` was called with a `systemInstruction` argument, it created a new model instance from `process.env.GEMINI_VERSION` directly, ignoring the model passed to the constructor via `options.model`. The model name is now stored as `this.modelName` and used consistently in all code paths.

#### `onTokenUsage` callback not removed on `close()`
The token-usage callback was assigned to the LLM provider on construction but never removed. After `sentinel.close()`, the provider still held a closure reference to the `TokenTracker`, preventing garbage collection. The callback is now nulled out in `close()`.

#### MCP tool handlers crash on `sessionFactory()` failure
All seven MCP tool handlers (`sentinel_goto`, `sentinel_act`, `sentinel_extract`, `sentinel_observe`, `sentinel_run`, `sentinel_screenshot`, `sentinel_token_usage`) lacked error handling. A browser initialization failure would crash the entire MCP server process. Each handler is now wrapped in try-catch and returns a structured `isError: true` response.

#### OpenAI provider: `JSON.parse` throws untyped error
`generateStructuredData` in `OpenAIProvider` called `JSON.parse()` without a try-catch. A malformed or filtered API response would throw a raw `SyntaxError` instead of an `LLMError`, bypassing retry logic and error handlers. Fixed to match the pattern already used in `OllamaProvider`.

#### Claude provider: `response.content` accessed without null guard
All three methods in `ClaudeProvider` (`generateStructuredData`, `analyzeImage`, `generateText`) called `.find()` on `response.content` without optional chaining. With the `any`-typed response, a missing `content` field would throw a `TypeError`. Changed to `(response.content as any[])?.find(...)`.

#### CLI `--headless` dead-code fallback
`opts.headless ?? true` in `resolveSentinel()` could never evaluate to `true` — Commander always initialises the `--headless` flag to `false` when not passed. Changed to `opts.headless ?? false` for correctness.

---

## [3.1.0] - 2026-04-07

### Added

#### CLI Tool (`sentinel` / `npx @isoldex/sentinel`)
Sentinel is now usable without writing any code. A `sentinel` binary is included in the npm package with four subcommands:

```bash
# Run an autonomous agent
npx @isoldex/sentinel run "Search for mechanical keyboards" --url https://amazon.de --output result.json

# Perform a single action
npx @isoldex/sentinel act "Click the login button" --url https://example.com

# Extract structured data
npx @isoldex/sentinel extract "Get all product names and prices" --url https://shop.example.com --schema '{"type":"object"}'

# Take a screenshot
npx @isoldex/sentinel screenshot --url https://example.com --output page.png
```

All commands accept `--api-key`, `--headless`, and `--model` flags. The API key falls back to `GEMINI_API_KEY` in the environment. Exit code is `0` on success, `1` on failure.

#### MCP Server (`sentinel-mcp`)
Sentinel is now available as an MCP (Model Context Protocol) server. This exposes all browser automation capabilities directly to AI assistants like Cursor, Windsurf, and Claude Desktop — no code required.

**Setup:** Add to your MCP client configuration:
```json
{
  "mcpServers": {
    "sentinel": {
      "command": "npx",
      "args": ["@isoldex/sentinel/mcp"],
      "env": { "GEMINI_API_KEY": "your-key-here" }
    }
  }
}
```

**Available tools:**
| Tool | Description |
|---|---|
| `sentinel_goto` | Navigate to a URL |
| `sentinel_act` | Perform a natural language action |
| `sentinel_extract` | Extract structured data from the current page |
| `sentinel_observe` | List interactive elements |
| `sentinel_run` | Run the autonomous agent loop |
| `sentinel_screenshot` | Take a screenshot (returns base64 image) |
| `sentinel_close` | Close the browser session |
| `sentinel_token_usage` | Get accumulated token usage and cost |

The browser session persists across tool calls within the same MCP server process. Set `SENTINEL_HEADLESS=false` to show the browser window during development.

#### Playwright Test Integration (`@isoldex/sentinel/test`)
Drop-in integration for existing Playwright Test suites. Import the extended `test` object and use the `ai` fixture for natural language actions alongside regular Playwright assertions:

```typescript
import { test, expect } from '@isoldex/sentinel/test';

test('completes checkout flow', async ({ ai, page }) => {
  await ai.goto('https://shop.example.com');
  await ai.act('Click the first product');
  await ai.act('Click Add to Cart');
  await ai.act('Proceed to checkout');

  const order = await ai.extract<{ total: string; items: number }>(
    'Get the order total and item count',
    z.object({ total: z.string(), items: z.number() })
  );

  expect(order.items).toBeGreaterThan(0);
  console.log('Token cost:', ai.getTokenUsage().estimatedCostUsd);
});
```

Override Sentinel options per test or globally:
```typescript
// playwright.config.ts
test.use({ sentinelOptions: { headless: false, verbose: 1 } });
```

The `ai` fixture auto-initializes before each test and auto-closes after, regardless of test outcome. The underlying Playwright page is accessible via `ai.page`.

---

## [3.0.0] - 2026-04-07

### Breaking Changes

#### AgentLoop constructor signature changed
`AgentLoop` now requires `extractionEngine` as the second parameter:

```typescript
// Before (v2.x)
new AgentLoop(actionEngine, stateParser, llm)

// After (v3.0)
new AgentLoop(actionEngine, extractionEngine, stateParser, llm)
```

Users who construct `AgentLoop` directly must update their call sites. Users who only use `sentinel.run()` are unaffected — the `Sentinel` class handles this automatically.

---

### Added

#### `extract()` step type in AgentLoop (`result.data`)
The AgentLoop planner can now issue `extract` steps in addition to `act` steps. When the planner determines that structured data should be collected mid-goal, it generates a schema and delegates to `ExtractionEngine`. The final `AgentResult` now includes a `data` field containing the extracted payload:

```typescript
const result = await sentinel.run('Go to Amazon, search for "laptop", extract top 5 results');
console.log(result.data); // { products: [{ name: '...', price: ... }, ...] }
```

`AgentStepEvent` now includes `type: 'act' | 'extract'` and an optional `data` field for streaming UIs.

#### `append` action type (ActionEngine)
New `append` action appends text to an input field without clearing its existing content. Uses `End` key + `keyboard.type` for the primary path and `locator.pressSequentially` for the semantic fallback:

```typescript
await sentinel.act('Append " (urgent)" to the subject field');
```

#### Token usage tracking (`onTokenUsage` callback)
All four built-in providers (`GeminiProvider`, `OpenAIProvider`, `ClaudeProvider`, `OllamaProvider`) now fire `provider.onTokenUsage({ inputTokens, outputTokens, totalTokens })` after every LLM call. The `Sentinel` class wires this automatically to `TokenTracker`, so `sentinel.getTokenUsage()` now returns accurate totals instead of zeros.

#### `withRetry` unified utility (`src/utils/with-retry.ts`)
Extracted the retry-with-exponential-backoff logic that was copy-pasted across all four providers into a single shared utility. All providers now call `withRetry(fn, label)` — 3 attempts, doubling delay from 1s, triggered on HTTP 429 / 503 / `ECONNRESET` / timeout.

#### Provider test coverage: 0% → 94% (`providers.test.ts`)
16 new unit tests covering `ClaudeProvider` and `OpenAIProvider` for `generateStructuredData`, `generateText`, and `analyzeImage`. Tests use `Object.create(Provider.prototype)` + direct client injection to bypass optional SDK dependencies entirely — no virtual mocks required in ESM.

#### 10 new integration tests (`integration.test.ts`, `action-engine.test.ts`)
- `ActionEngine`: `append` action, semantic fallback on viewport-out-of-bounds elements, both-paths-fail scenario
- `Integration: AgentLoop`: multi-step goal completion, consecutive-failure abort, instruction loop detection
- `Integration: ExtractionEngine`: AOM + page text combined in prompt, graceful page-text failure

### Fixed

#### `domSettleTimeoutMs` not forwarded to `waitForPageSettle`
The `domSettleTimeoutMs` option was stored in the `Sentinel` constructor but never passed to `ActionEngine`, which always used the hardcoded default of 3000ms. `ActionEngine` now accepts `domSettleTimeoutMs` as a constructor parameter and passes it to all three `waitForPageSettle` call sites (primary path, Vision Grounding path, semantic fallback path).

#### `waitForNavigation` race condition
After an action, Sentinel now uses `Promise.race([domSettle, navigationSettle])` instead of only the MutationObserver. Full-page navigations triggered by clicks (form submissions, link clicks) are now awaited correctly without waiting for the full 3-second DOM-silence cap.

#### Verifier Fast-Path 4 removed (false positives)
Fast Path 4 (element count delta > 3 → auto-success) was triggering false positives on pages with dynamic content unrelated to the user action (ads, tickers, live feeds). Removed entirely. The LLM verification path now handles all non-trivial state changes.

#### `NotInitializedError` in `sentinel.act()`
`sentinel.act()` now throws `NotInitializedError` (structured error class) instead of a generic `Error('Sentinel not initialized')` when called before `init()`. Consistent with all other API methods.

### Changed

#### `SchemaInput<T>` type precision
`SchemaInput<T>` changed from `z.ZodType` (unparameterized) to `z.ZodType<T>`. `extract<T>(instruction, schema)` now infers the return type correctly from the Zod schema without requiring a manual type annotation.

---

## [2.3.3] - 2026-04-06

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
