# Sentinel 🛡️

Sentinel is a high-performance, AI-driven browser automation framework built on top of **Playwright** and powered by **Google Gemini**. It allows you to automate complex web tasks using natural language, extract structured data with ease, and perform robust interactions with self-healing capabilities.

Think of it as a **fast, lightweight, and cost-effective alternative to Stagehand**, specifically optimized for the Gemini ecosystem.

## ✨ Features

- **🗣️ Natural Language Interactions**: Perform actions like `act('Click the "Add to Cart" button')` without writing fragile CSS selectors.
- **📊 Structured Data Extraction**: Use Zod or JSON Schema to extract precisely formatted data from any page.
- **⚡ High Performance**: Optimized with parallel CDP (Chrome DevTools Protocol) requests and smart state caching.
- **🛡️ Robust & Reliable**: Includes a semantic verification loop that confirms every action and automatically retries with fallbacks on failure.
- **🔍 Deep Observation**: Understand page structure through the Accessibility Object Model (AOM) and raw text content.
- **🔧 Playwright Powered**: Direct access to the underlying Playwright `Page` and `BrowserContext`.

---

## 🚀 Quickstart

### 1. Installation

```bash
npm install @sentineljs/sentinel playwright
```
> [!NOTE] 
> Playwright is a peer dependency. Make sure to install it alongside Sentinel.

### 2. Configuration

Set your Gemini API key in your environment or via a `.env` file:

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_VERSION=gemini-2.0-flash # recommended for speed
```

### 3. Usage

```typescript
import { Sentinel, z } from '@sentineljs/sentinel';

async function run() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY!,
    headless: false,
    verbose: 1
  });

  await sentinel.init();

  // Navigate
  await sentinel.goto('https://news.ycombinator.com');

  // Extract structured data with Zod
  const schema = z.object({
    topStory: z.string(),
    points: z.number()
  });
  
  const data = await sentinel.extract('Get the title and points of the #1 story', schema);
  console.log('Top Story:', data);

  // Perform natural language actions
  await sentinel.act('Click on the "new" link in the header');

  await sentinel.close();
}

run();
```

---

## 🛠️ API Reference

### `new Sentinel(options: SentinelOptions)`
- `apiKey`: Your Google AI API key.
- `headless`: Whether to run the browser in the background (default: `false`).
- `verbose`: Logging level (`0` = silent, `1` = actions, `2` = full debug).
- `enableCaching`: Enable state caching between calls (default: `true`).

### `sentinel.act(instruction: string, options?: ActOptions)`
Performs an action on the page.
- `instruction`: Natural language string (e.g., `"Click the login button"`).
- `options.variables`: Key-value pairs for string interpolation (e.g., `"%query%"`).

### `sentinel.extract<T>(instruction: string, schema: SchemaInput<T>)`
Returns structured data. Supports **Zod schemas** for full TypeScript type inference.

### `sentinel.observe(instruction?: string)`
Returns a list of possible interactive elements and their purposes.

### `sentinel.page` / `sentinel.context`
Direct access to the underlying **Playwright** `Page` and `BrowserContext`.

---

## 🏗️ Development & Contributing

To develop Sentinel locally:

```bash
git clone https://github.com/ArasHuseyin/sentinel.ai.git
cd sentinel.ai
npm install
npm run build
```

### Running Tests
A comprehensive WhatsApp Web test is included in the source:
```bash
npx tsc
node dist/whatsapp-test.js
```

---

## 🧠 Why Sentinel?

Unlike standard automation tools that rely on brittle XPaths, Sentinel "sees" the page like a human through accessibility trees and visual text. It understands context, handles dynamic content automatically, and verifies its own success.

Licensed under [ISC](LICENSE).
