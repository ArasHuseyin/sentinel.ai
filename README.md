# @isoldex/sentinel

**Sentinel** is an AI-powered browser automation framework built on [Playwright](https://playwright.dev/) and designed around the principle that web automation should be expressed in plain language, not CSS selectors or XPaths.

Describe what you want to do. Sentinel figures out how.

> A fast, lightweight alternative to BrowserUse, Stagehand, and AutoGPT — with multi-LLM support, vision grounding, a full autonomous agent loop, and robust self-healing built in.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Reference](#api-reference)
  - [Core Actions](#core-actions)
  - [Data Extraction](#data-extraction)
  - [Observation](#observation)
  - [Autonomous Agent](#autonomous-agent)
  - [Tab Management](#tab-management)
  - [Session Persistence](#session-persistence)
  - [Record and Replay](#record-and-replay)
  - [Vision](#vision)
  - [Observability](#observability)
- [LLM Providers](#llm-providers)
- [Architecture](#architecture)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Features

| Feature | Description |
|---|---|
| Natural Language Actions | `act('Click the login button')` — no selectors needed |
| Structured Extraction | Zod-typed `extract()` with full TypeScript inference |
| Autonomous Agent Loop | `run(goal)` — Plan, Execute, Verify, Reflect cycle |
| Vision Grounding | Vision-model fallback for canvas, shadow DOM, and custom components |
| Multi-LLM Support | OpenAI, Claude, Gemini, Ollama — swap providers with one line |
| Multi-Tab and Multi-Browser | Chromium, Firefox, WebKit + full tab management |
| Record and Replay | Capture workflows, export as TypeScript or JSON, replay on demand |
| Session Persistence | Save and restore cookies and localStorage for authenticated flows |
| Stealth and Proxy | Human-like delays, User-Agent rotation, proxy configuration |
| Event System | `sentinel.on('action', ...)` for full observability |
| Token Tracking | Monitor LLM usage and estimated cost per session |
| Self-Healing | Semantic verification with automatic retry and multi-layer fallback |

---

## Installation

```bash
npm install @isoldex/sentinel playwright
npx playwright install chromium
```

Playwright is a peer dependency. Install it alongside Sentinel. The `playwright install chromium` step downloads the browser binary.

**Requirements:** Node.js 18+

---

## Quick Start

```typescript
import { Sentinel, z } from '@isoldex/sentinel';

// With Gemini (built-in, no extra package needed):
const sentinel = new Sentinel({ apiKey: process.env.GEMINI_API_KEY! });

// Or with any other provider — see LLM Providers section:
// const sentinel = new Sentinel({ apiKey: '', provider: new OpenAIProvider({ apiKey: '...' }) });

await sentinel.init();
await sentinel.goto('https://news.ycombinator.com');

// Extract structured data
const data = await sentinel.extract('Get the top 3 stories', z.object({
  stories: z.array(z.object({
    title: z.string(),
    points: z.number(),
  }))
}));
console.log(data.stories);

// Natural language actions
await sentinel.act('Click on the "new" link in the header');
await sentinel.act('Fill "hello@example.com" into the email field');

await sentinel.close();
```

Sentinel works with any supported LLM provider. The built-in provider uses Gemini and requires a `GEMINI_API_KEY`. For other providers (OpenAI, Claude, Ollama), pass a `provider` option and set `apiKey` to an empty string — no `.env` required.

```env
# Only needed when using the built-in Gemini provider:
GEMINI_API_KEY=your_api_key_here
GEMINI_VERSION=gemini-2.0-flash   # optional, defaults to gemini-2.0-flash
```

---

## Configuration

### `new Sentinel(options: SentinelOptions)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | API key for the built-in Gemini provider. Pass `''` when using a custom `provider`. |
| `headless` | `boolean` | `false` | Run browser in headless mode |
| `browser` | `'chromium' \| 'firefox' \| 'webkit'` | `'chromium'` | Browser engine. Note: CDP/AOM is Chromium-only; Firefox and WebKit fall back to DOM parsing. |
| `viewport` | `{ width: number; height: number }` | `1280x720` | Viewport dimensions |
| `verbose` | `0 \| 1 \| 2` | `1` | Log verbosity: 0 = silent, 1 = key actions, 2 = full debug |
| `enableCaching` | `boolean` | `true` | Cache AOM state between calls (500ms TTL). Set to `false` for always-fresh state. |
| `visionFallback` | `boolean` | `false` | Enable Vision fallback when AOM cannot locate an element (uses Gemini Vision; requires `apiKey`) |
| `provider` | `LLMProvider` | GeminiService | Custom LLM provider (see [LLM Providers](#llm-providers)) |
| `sessionPath` | `string` | — | Path to a session file. If the file exists, it is loaded on `init()`. |
| `proxy` | `ProxyOptions` | — | Proxy server configuration |
| `humanLike` | `boolean` | `false` | Add random human-like delays between actions |
| `domSettleTimeoutMs` | `number` | `3000` | Maximum time (ms) to wait for the DOM to settle after an action |

#### `ProxyOptions`

| Field | Type | Description |
|---|---|---|
| `server` | `string` | Proxy server URL, e.g. `http://proxy.example.com:8080` |
| `username` | `string` | Optional proxy username |
| `password` | `string` | Optional proxy password |

---

## API Reference

### Core Actions

#### `sentinel.init(): Promise<void>`

Initialize the browser and all internal engines. Must be called before any other method.

```typescript
await sentinel.init();
```

#### `sentinel.goto(url: string): Promise<void>`

Navigate to a URL and wait for the DOM to settle.

```typescript
await sentinel.goto('https://example.com');
```

#### `sentinel.close(): Promise<void>`

Close the browser and release all resources.

```typescript
await sentinel.close();
```

#### `sentinel.act(instruction, options?): Promise<ActionResult>`

Perform a natural language action on the current page. After every action, Sentinel runs semantic verification and retries automatically on weak confidence.

```typescript
await sentinel.act('Click the "Add to Cart" button');
await sentinel.act('Fill "user@example.com" into the email field');
await sentinel.act('Select "Germany" from the country dropdown');
await sentinel.act('Press Enter');
await sentinel.act('Scroll down');
await sentinel.act('Double-click the product image');
```

Variable interpolation is supported:

```typescript
await sentinel.act('Fill %email% into the email field', {
  variables: { email: 'user@example.com' }
});
```

**Supported action types:** `click`, `fill`, `hover`, `press`, `select`, `double-click`, `right-click`, `scroll-down`, `scroll-up`, `scroll-to`

**`ActOptions`**

| Field | Type | Description |
|---|---|---|
| `variables` | `Record<string, string>` | Values to interpolate into the instruction string |
| `retries` | `number` | Override the default retry count (default: 2) |

**`ActionResult`**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the action was successfully verified |
| `message` | `string` | Human-readable outcome description |
| `action` | `string` (optional) | The resolved action that was executed |

---

### Data Extraction

#### `sentinel.extract<T>(instruction, schema): Promise<T>`

Extract structured data from the current page. The schema can be a Zod schema or a raw JSON Schema object. TypeScript generics are inferred automatically from the schema.

```typescript
import { Sentinel, z } from '@isoldex/sentinel';

const result = await sentinel.extract(
  'Get all product names and prices',
  z.object({
    products: z.array(z.object({
      name: z.string(),
      price: z.number(),
    }))
  })
);
// result.products is typed as { name: string; price: number }[]
```

---

### Observation

#### `sentinel.observe(instruction?): Promise<ObserveResult[]>`

Return a list of interactive elements visible on the current page, optionally filtered by a natural language hint.

```typescript
const elements = await sentinel.observe();
const loginElements = await sentinel.observe('Find login-related elements');
```

---

### Autonomous Agent

#### `sentinel.run(goal, options?): Promise<AgentResult>`

Run a fully autonomous multi-step agent to achieve a high-level goal. The agent operates in a Plan → Execute → Verify → Reflect loop until the goal is met, the step limit is reached, or an abort condition triggers.

```typescript
const result = await sentinel.run(
  'Go to Amazon, search for "mechanical keyboard under 100 euros", and extract the top 5 results',
  {
    maxSteps: 20,
    onStep: (event) => {
      console.log(`Step ${event.stepNumber}: ${event.instruction}`);
      console.log(`  Reasoning: ${event.reasoning}`);
    },
  }
);

console.log(result.success);       // boolean
console.log(result.goalAchieved);  // boolean
console.log(result.totalSteps);    // number
console.log(result.message);       // human-readable summary
console.log(result.history);       // AgentStepEvent[]
```

**`AgentRunOptions`**

| Field | Type | Default | Description |
|---|---|---|---|
| `maxSteps` | `number` | `15` | Maximum number of steps before aborting |
| `onStep` | `(event: AgentStepEvent) => void` | — | Callback invoked after each step |

**`AgentResult`**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the agent considers the goal achieved |
| `goalAchieved` | `boolean` | Result of the final LLM reflection check |
| `totalSteps` | `number` | Number of steps executed |
| `message` | `string` | Human-readable outcome |
| `history` | `AgentStepEvent[]` | Full step-by-step history |

The agent automatically aborts if the same instruction repeats three times without progress (loop detection) or if three consecutive steps fail.

---

### Tab Management

```typescript
// Open a new tab and optionally navigate to a URL
const tabIndex = await sentinel.newTab('https://google.com');

// Switch the active tab
await sentinel.switchTab(0);
await sentinel.switchTab(tabIndex);

// Close a tab by index
await sentinel.closeTab(tabIndex);

// Number of currently open tabs
console.log(sentinel.tabCount);
```

Note: When using Firefox or WebKit, CDP is not available. AOM-based state parsing falls back to DOM on those browsers.

---

### Session Persistence

Save and restore authenticated sessions across runs — cookies and localStorage included.

```typescript
// First run: log in manually and save the session
await sentinel.goto('https://github.com/login');
await sentinel.act('Fill "myuser" into the username field');
await sentinel.act('Fill "mypassword" into the password field');
await sentinel.act('Click the sign in button');
await sentinel.saveSession('./sessions/github.json');

// Subsequent runs: load the saved session and skip the login page
const sentinel = new Sentinel({
  apiKey: process.env.GEMINI_API_KEY!,
  sessionPath: './sessions/github.json',  // loaded automatically on init()
});
await sentinel.init();
await sentinel.goto('https://github.com');  // already authenticated
```

#### `sentinel.saveSession(filePath: string): Promise<void>`

Writes Playwright `storageState` (cookies + localStorage) to a JSON file.

#### `sentinel.hasLoginForm(): Promise<boolean>`

Returns `true` if the current page contains a password input field.

---

### Record and Replay

Capture any automation session as a replayable workflow.

```typescript
// Start recording
sentinel.startRecording('checkout-flow');

await sentinel.goto('https://shop.example.com');
await sentinel.act('Click the login button');
await sentinel.act('Fill "user@example.com" into the email field');
await sentinel.act('Click Add to Cart');

// Stop and get the workflow object
const workflow = sentinel.stopRecording();

// Export as TypeScript source code
const code = sentinel.exportWorkflowAsCode(workflow);
console.log(code);

// Export as JSON
const json = sentinel.exportWorkflowAsJSON(workflow);

// Replay the workflow
await sentinel.replay(workflow);
```

---

### Vision

#### `sentinel.screenshot(): Promise<Buffer>`

Take a PNG screenshot of the current viewport. Returns a `Buffer`.

```typescript
const png = await sentinel.screenshot();
```

#### `sentinel.describeScreen(): Promise<string>`

Use Gemini Vision to produce a natural language description of the current page. Requires `visionFallback: true` in `SentinelOptions`.

```typescript
const sentinel = new Sentinel({
  apiKey: process.env.GEMINI_API_KEY!,
  visionFallback: true,
});

const description = await sentinel.describeScreen();
console.log(description);
```

Vision Grounding also activates automatically inside `act()` when the AOM state parser cannot locate the target element — no additional code is needed.

---

### Observability

#### Events

`Sentinel` extends Node.js `EventEmitter`. The following events are emitted:

```typescript
sentinel.on('action', (event) => {
  console.log('Action:', event.instruction, event.result);
});

sentinel.on('navigate', (event) => {
  console.log('Navigated to:', event.url);
});

sentinel.on('close', () => {
  console.log('Browser closed');
});
```

#### Direct Page Access

```typescript
// Raw Playwright Page and BrowserContext objects
const page = sentinel.page;
const context = sentinel.context;
```

#### Token Tracking

```typescript
const usage = sentinel.getTokenUsage();
console.log(usage);
// {
//   totalInputTokens: 9800,
//   totalOutputTokens: 2600,
//   totalTokens: 12400,
//   estimatedCostUsd: 0.00093,
//   entries: [...]
// }

// Export full log as JSON to a file
sentinel.exportLogs('./logs/session.json');
```

---

## LLM Providers

Sentinel supports four LLM providers out of the box. Pass the provider via the `provider` option. The built-in shortcut (`apiKey` without an explicit provider) uses Gemini.

### OpenAI

Requires: `npm install openai`

```typescript
import { Sentinel, OpenAIProvider } from '@isoldex/sentinel';

const sentinel = new Sentinel({
  apiKey: '',
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
});
```

### Claude

Requires: `npm install @anthropic-ai/sdk`

```typescript
import { Sentinel, ClaudeProvider } from '@isoldex/sentinel';

const sentinel = new Sentinel({
  apiKey: '',
  provider: new ClaudeProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
});
```

### Gemini

Built-in — no extra package needed.

```typescript
import { Sentinel, GeminiProvider } from '@isoldex/sentinel';

const sentinel = new Sentinel({
  apiKey: '',
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: 'gemini-2.0-flash',  // or set GEMINI_VERSION in .env
  }),
});
```

Shorthand (uses Gemini implicitly):
```typescript
const sentinel = new Sentinel({ apiKey: process.env.GEMINI_API_KEY! });
```

### Ollama (local)

Requires a running [Ollama](https://ollama.com) instance. No additional npm package needed.

```typescript
import { Sentinel, OllamaProvider } from '@isoldex/sentinel';

const sentinel = new Sentinel({
  apiKey: '',
  provider: new OllamaProvider({
    model: 'llama3.2',
    baseURL: 'http://localhost:11434',  // default
  }),
});
```

### Provider Comparison

| Provider | Class | Default Model | Peer Dependency | Notes |
|---|---|---|---|---|
| OpenAI | `OpenAIProvider` | `gpt-4o` | `npm install openai` | Supports any OpenAI-compatible API via `baseURL` |
| Claude | `ClaudeProvider` | `claude-sonnet-4-6` | `npm install @anthropic-ai/sdk` | — |
| Gemini | `GeminiProvider` | `gemini-2.0-flash` | none (bundled) | Set `GEMINI_VERSION` env var to override model |
| Ollama | `OllamaProvider` | — (required) | none | Runs locally; no API key needed |

All providers implement automatic retry with exponential backoff on rate limit errors (HTTP 429/503), connection resets, and timeouts (up to 3 attempts).

### Custom Provider

Implement the `LLMProvider` interface to integrate any LLM:

```typescript
import type { LLMProvider, SchemaInput } from '@isoldex/sentinel';

class MyProvider implements LLMProvider {
  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
    // call your API and return parsed, typed data
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    // call your API and return plain text
  }
}

const sentinel = new Sentinel({ apiKey: '', provider: new MyProvider() });
```

---

## Architecture

Sentinel is composed of five cooperating subsystems:

### StateParser

Produces a normalized list of interactive UI elements from the current page state.

1. **AOM (primary)** — reads the full accessibility tree via `CDP Accessibility.getFullAXTree`. Enriches generic button names with card/container context by walking AOM ancestors and scraping nearby DOM headings, paragraphs, and badge spans. This allows the LLM to distinguish identical-named buttons across card UIs (e.g. multiple "Select plan" buttons each resolve to a unique, context-rich label).
2. **DOM fallback** — used on Firefox and WebKit where CDP is unavailable.
3. **Form input fallback** — handles inputs not exposed through the accessibility tree.

### ActionEngine

Translates a natural language instruction into a Playwright action using a three-layer fallback:

1. **Coordinate click** — computes element coordinates from the AOM bounding box and uses `page.mouse.wheel` / `page.mouse.click`.
2. **Vision Grounding** — if coordinate click fails or the element is off-screen, captures a screenshot and uses a vision-capable model to locate the element visually (requires `visionFallback: true` and Gemini `apiKey`).
3. **Playwright locators** — four-strategy chain: exact role+name, inexact role+name, CSS `:has-text`, plain text locator.

Before clicking, a viewport bounds check confirms the element is visible. If not, `scrollIntoViewIfNeeded` is called before retrying. Radio and checkbox inputs styled to hide the native control are handled via `querySelector` + `closest('label')` traversal.

### Verifier

Confirms that an action produced the expected change without defaulting to LLM calls for common cases:

- **URL/title change** — navigation detected by comparing URLs before and after.
- **Checked-state fast path** — radio/checkbox selection detected directly (confidence 0.92).
- **DOM delta** — detects significant DOM mutations.
- **LLM semantic verification** — full before/after state comparison sent to the LLM when fast paths are inconclusive.

On LLM errors, the Verifier returns `{ success: true, confidence: 0.5 }` rather than throwing, so automation continues rather than aborting.

### AgentLoop

Implements the autonomous agent cycle:

```
Plan  →  Execute  →  Verify  →  Reflect  →  (repeat)
```

- **Plan:** The `Planner` uses the current page state and a rolling memory window to decide the next action.
- **Execute:** The planned instruction is passed to the `ActionEngine`.
- **Verify:** The `Verifier` confirms success.
- **Reflect:** After the loop exits, a final LLM reflection checks whether the goal was actually achieved.

Abort conditions: three consecutive failures, instruction loop detected (same instruction repeated three times without progress), or `maxSteps` reached.

### DOM Settle

After every navigation or action, Sentinel waits for the DOM to stabilize using a `MutationObserver` that resolves after 300ms of silence (hard cap: 3 seconds). This replaces the previous `networkidle` wait and correctly handles SPA route transitions that do not produce network activity.

---

## Error Handling

All Sentinel errors extend `SentinelError`, which carries a `code` string and an optional `context` object.

```typescript
import {
  SentinelError,
  ActionError,
  ExtractionError,
  NavigationError,
  AgentError,
  NotInitializedError,
} from '@isoldex/sentinel';

try {
  await sentinel.act('Click the submit button');
} catch (err) {
  if (err instanceof ActionError) {
    console.error('Action failed:', err.message, err.code, err.context);
  }
}
```

| Class | Code | When thrown |
|---|---|---|
| `SentinelError` | — | Base class; never thrown directly |
| `ActionError` | `ACTION_FAILED` | Action fails after all retries |
| `ExtractionError` | `EXTRACTION_FAILED` | Structured extraction fails |
| `NavigationError` | `NAVIGATION_FAILED` | Navigation to a URL fails |
| `AgentError` | `AGENT_ERROR` | Agent loop exceeds max steps or gets stuck |
| `NotInitializedError` | `NOT_INITIALIZED` | Any method called before `init()` |

---

## Examples

See the [`examples/`](./examples) directory for ready-to-run scripts:

- **`hacker-news.ts`** — Extract top stories from Hacker News
- **`google-search.ts`** — Search Google, extract results, and demo Record and Replay
- **`agent-amazon.ts`** — Autonomous shopping agent on Amazon

---

Licensed under [ISC](LICENSE). Author: Huseyin Aras — [hueseyin.aras1@gmail.com](mailto:hueseyin.aras1@gmail.com)
