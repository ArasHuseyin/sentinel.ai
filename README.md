# Sentinel 🛡️

**Sentinel** is a high-performance, AI-driven browser automation framework built on **Playwright** and powered by **Google Gemini** (or any LLM of your choice). Automate complex web tasks with natural language, extract structured data with Zod, run autonomous multi-step agents, and record & replay workflows — all with self-healing reliability.

> Think of it as a **fast, lightweight, and cost-effective alternative to BrowserUse, Stagehand, and AutoGPT** — with vision grounding, multi-LLM support, and a full agent loop built in.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🗣️ **Natural Language Actions** | `act('Click the login button')` — no CSS selectors needed |
| 📊 **Structured Extraction** | Zod-typed `extract()` with full TypeScript inference |
| 🤖 **Autonomous Agent Loop** | `run(goal)` — Plan → Execute → Verify → Reflect cycle |
| 👁️ **Vision Grounding** | Gemini Vision fallback when AOM can't find an element |
| 🗂️ **Multi-Tab & Multi-Browser** | Chromium, Firefox, WebKit + tab management |
| 🔄 **Record & Replay** | Record workflows, export as TypeScript or JSON, replay anytime |
| 🔌 **Multi-LLM Support** | Gemini, OpenAI, Claude, Ollama (local) — plug in any provider |
| 💾 **Session Persistence** | Save & load cookies/localStorage for authenticated workflows |
| 🕵️ **Stealth & Proxy** | Human-like delays, User-Agent rotation, proxy support |
| 📡 **Event System** | `sentinel.on('action', ...)` — full observability |
| 💰 **Token Tracking** | Monitor LLM usage and estimated cost per session |
| ⚡ **High Performance** | Parallel CDP requests, smart AOM state caching (TTL 500ms) |
| 🛡️ **Self-Healing** | Semantic verification loop with automatic retry & fallback |

---

## 🚀 Quickstart

### 1. Installation

```bash
npm install @isoldex/sentinel playwright
```

> **Note:** Playwright is a peer dependency. Install it alongside Sentinel.

### 2. Configuration

Sentinel uses environment variables for the default Gemini provider. Create a `.env` file in your project root:

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_VERSION=gemini-3-flash-preview   # or: gemini-2.5-pro-preview-05-06
```

> **Note:** The `.env` file is only required when using the default Gemini provider. If you pass a custom `provider` (OpenAI, Claude, Ollama), no `.env` is needed.

Sentinel loads `.env` automatically via `dotenv` — no extra setup required.

### 3. Basic Usage

```typescript
import { Sentinel, z } from '@isoldex/sentinel';

const sentinel = new Sentinel({
  apiKey: process.env.GEMINI_API_KEY!,
  headless: false,
  verbose: 1,
});

await sentinel.init();
await sentinel.goto('https://news.ycombinator.com');

// Extract structured data with Zod
const data = await sentinel.extract('Get the top 3 stories', z.object({
  stories: z.array(z.object({
    title: z.string(),
    points: z.number(),
  }))
}));
console.log(data.stories);

// Natural language action
await sentinel.act('Click on the "new" link in the header');

await sentinel.close();
```

---

## 🤖 Autonomous Agent

Run a high-level goal autonomously — Sentinel plans, executes, verifies, and reflects until the goal is reached:

```typescript
const result = await sentinel.run(
  'Go to Amazon, search for "mechanical keyboard under 100 euros", and extract the top 5 results',
  {
    maxSteps: 20,
    onStep: (event) => console.log(`Step ${event.step}: ${event.action}`),
  }
);

console.log(result.success, result.message);
console.log(result.extractedData);
```

---

## 🔄 Record & Replay

Record any workflow and replay it later — or export it as TypeScript code:

```typescript
// Record
sentinel.startRecording('my-workflow');
await sentinel.goto('https://example.com');
await sentinel.act('Click the sign in button');
await sentinel.act('Fill "user@example.com" into the email field');
const workflow = sentinel.stopRecording();

// Export as TypeScript
const code = sentinel.exportWorkflowAsCode(workflow);
console.log(code);

// Export as JSON
const json = sentinel.exportWorkflowAsJSON(workflow);

// Replay
await sentinel.replay(workflow);
```

---

## 🗂️ Multi-Tab & Multi-Browser

```typescript
// Use Firefox instead of Chromium
const sentinel = new Sentinel({ apiKey: '...', browser: 'firefox' });

// Open a second tab
const tabIndex = await sentinel.newTab('https://google.com');

// Switch between tabs
await sentinel.switchTab(0);
await sentinel.switchTab(tabIndex);

// Close a tab
await sentinel.closeTab(tabIndex);

console.log(sentinel.tabCount); // number of open tabs
```

---

## 💾 Session Persistence

Save and restore authenticated sessions — no need to log in every time:

```typescript
// First run: log in and save session
await sentinel.goto('https://github.com/login');
await sentinel.act('Fill "myuser" into the username field');
await sentinel.act('Fill "mypassword" into the password field');
await sentinel.act('Click the sign in button');
await sentinel.saveSession('./sessions/github.json');

// Subsequent runs: load session and skip login
const sentinel = new Sentinel({
  apiKey: '...',
  sessionPath: './sessions/github.json', // auto-loaded on init()
});
await sentinel.init();
await sentinel.goto('https://github.com'); // already logged in!
```

---

## 🔌 Multi-LLM Providers

Swap out Gemini for OpenAI, Claude, or a local Ollama model.

### Supported Models

| Provider | Model | Notes |
|---|---|---|
| **Gemini** | `gemini-3-flash-preview` | Recommended – fast & cheap |
| **Gemini** | `gemini-2.5-pro-preview-05-06` | Most capable Gemini model |
| **OpenAI** | `gpt-4o` | Best OpenAI model for agents |
| **OpenAI** | `gpt-4o-mini` | Faster, cheaper GPT-4o |
| **Claude** | `claude-opus-4-6` | Most capable Claude model |
| **Claude** | `claude-sonnet-4-6` | Balanced speed & quality |
| **Claude** | `claude-haiku-4-6` | Fastest Claude model |
| **Ollama** | `llama3.2`, `mistral`, … | Local, no API key needed |

```typescript
import { Sentinel, OpenAIProvider, ClaudeProvider, OllamaProvider } from '@isoldex/sentinel';

// OpenAI GPT-4o
const sentinel = new Sentinel({
  apiKey: 'gemini-key', // still required for fallback
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' }),
});

// Anthropic Claude
const sentinel = new Sentinel({
  apiKey: 'gemini-key',
  provider: new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-4-6' }), // or: claude-sonnet-4-6, claude-haiku-4-6
});

// Local Ollama (no API key needed)
const sentinel = new Sentinel({
  apiKey: 'gemini-key',
  provider: new OllamaProvider({ model: 'llama3.2', baseUrl: 'http://localhost:11434' }),
});
```

---

## 👁️ Vision Grounding

Enable Gemini Vision as a fallback when the Accessibility Tree can't locate an element (e.g. canvas, shadow DOM, custom components):

```typescript
const sentinel = new Sentinel({
  apiKey: process.env.GEMINI_API_KEY!,
  visionFallback: true, // enables screenshot-based fallback
});

// Take a screenshot
const png = await sentinel.screenshot();

// Describe the current screen visually
const description = await sentinel.describeScreen();
console.log(description);
```

---

## 🕵️ Stealth & Proxy

```typescript
const sentinel = new Sentinel({
  apiKey: '...',
  humanLike: true, // random delays between actions
  proxy: {
    server: 'http://proxy.example.com:8080',
    username: 'user',
    password: 'pass',
  },
});
```

---

## 📡 Events & Observability

```typescript
sentinel.on('action', (event) => {
  console.log('Action performed:', event.instruction, event.result);
});

sentinel.on('navigate', (event) => {
  console.log('Navigated to:', event.url);
});

sentinel.on('close', () => {
  console.log('Browser closed');
});
```

---

## 💰 Token Usage & Cost Tracking

```typescript
const usage = sentinel.getTokenUsage();
console.log(usage);
// {
//   totalTokens: 12400,
//   inputTokens: 9800,
//   outputTokens: 2600,
//   estimatedCostUsd: 0.003,
//   calls: 14
// }

// Export full log as JSON
sentinel.exportLogs('./logs/session.json');
```

---

## 🛠️ Full API Reference

### `new Sentinel(options: SentinelOptions)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | Google Gemini API key |
| `headless` | `boolean` | `false` | Run browser headlessly |
| `browser` | `'chromium' \| 'firefox' \| 'webkit'` | `'chromium'` | Browser engine |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `verbose` | `0 \| 1 \| 2` | `1` | Log level (0=silent, 2=debug) |
| `enableCaching` | `boolean` | `true` | Cache AOM state between calls |
| `visionFallback` | `boolean` | `false` | Enable Gemini Vision fallback |
| `provider` | `LLMProvider` | Gemini | Custom LLM provider |
| `sessionPath` | `string` | — | Path to session file (auto-loaded) |
| `proxy` | `ProxyOptions` | — | Proxy server configuration |
| `humanLike` | `boolean` | `false` | Random delays between actions |
| `domSettleTimeoutMs` | `number` | `3000` | DOM settle wait time (ms) |

---

### Core Methods

#### `sentinel.init(): Promise<void>`
Initialize the browser and all internal engines. Must be called before any other method.

#### `sentinel.goto(url: string): Promise<void>`
Navigate to a URL and wait for the DOM to settle.

#### `sentinel.close(): Promise<void>`
Close the browser and release all resources.

---

### `sentinel.act(instruction, options?): Promise<ActionResult>`
Perform a natural language action on the page.

```typescript
await sentinel.act('Click the "Add to Cart" button');
await sentinel.act('Fill %email% into the email field', { variables: { email: 'user@example.com' } });
await sentinel.act('Press Enter');
await sentinel.act('Scroll down');
await sentinel.act('Select "Germany" from the country dropdown');
await sentinel.act('Double-click the image');
```

**Supported action types:** `click`, `fill`, `hover`, `press`, `select`, `double-click`, `right-click`, `scroll-down`, `scroll-up`, `scroll-to`

---

### `sentinel.extract<T>(instruction, schema): Promise<T>`
Extract structured data from the current page using a Zod schema or JSON Schema.

```typescript
const result = await sentinel.extract('Get all product names and prices', z.object({
  products: z.array(z.object({ name: z.string(), price: z.number() }))
}));
```

---

### `sentinel.observe(instruction?): Promise<ObserveResult[]>`
Return a list of interactive elements and their purposes.

```typescript
const elements = await sentinel.observe('Find all navigation links');
```

---

### `sentinel.run(goal, options?): Promise<AgentResult>`
Run an autonomous multi-step agent to achieve a high-level goal.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxSteps` | `number` | `15` | Maximum number of steps |
| `onStep` | `(event: AgentStepEvent) => void` | — | Step callback |

---

### Tab Management

```typescript
const idx = await sentinel.newTab(url?)   // open new tab, returns index
await sentinel.switchTab(index)           // switch active tab
await sentinel.closeTab(index)            // close tab by index
sentinel.tabCount                         // number of open tabs
```

---

### Session Management

```typescript
await sentinel.saveSession(filePath)      // save cookies & storage to JSON
// auto-load via sessionPath option in constructor
await sentinel.hasLoginForm()             // detect if page has a login form
```

---

### Recording & Replay

```typescript
sentinel.startRecording(name?)            // start recording actions
const workflow = sentinel.stopRecording() // stop and get RecordedWorkflow
sentinel.exportWorkflowAsCode(workflow)   // export as TypeScript string
sentinel.exportWorkflowAsJSON(workflow)   // export as JSON string
await sentinel.replay(workflow)           // replay a recorded workflow
```

---

### Vision

```typescript
const png = await sentinel.screenshot()  // take a screenshot (Buffer)
const desc = await sentinel.describeScreen() // visual description via Gemini Vision
```

---

### Observability

```typescript
sentinel.on('action', handler)            // emitted after every act()
sentinel.on('navigate', handler)          // emitted after every goto()
sentinel.on('close', handler)             // emitted on close()
sentinel.getTokenUsage()                  // token usage + estimated cost
sentinel.exportLogs(filePath)             // export usage log as JSON
```

---

## 📁 Examples

See the [`examples/`](./examples) folder for ready-to-run scripts:

- **`hacker-news.ts`** — Extract top stories from Hacker News
- **`google-search.ts`** — Search Google, extract results, and demo Record & Replay
- **`agent-amazon.ts`** — Autonomous shopping agent on Amazon

---

## 🏗️ Development

```bash
git clone https://github.com/ArasHuseyin/sentinel.ai.git
cd sentinel.ai
npm install
npx tsc --noEmit   # type-check
npm run build      # compile to dist/
```

---

## 🧠 Why Sentinel?

Unlike standard automation tools that rely on brittle XPaths or CSS selectors, Sentinel "sees" the page through the **Accessibility Object Model (AOM)** and falls back to **Gemini Vision** when needed. It understands context, verifies its own actions, and can autonomously plan and execute multi-step goals — making it a true AI agent framework, not just a scripting library.

---

Licensed under [ISC](LICENSE).
