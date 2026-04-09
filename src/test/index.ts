import { test as base, expect } from '@playwright/test';
import { Sentinel } from '../index.js';
import type { AgentRunOptions, AgentResult, AgentStepEvent, ActOptions, ActionResult, ObserveResult, SentinelOptions } from '../index.js';
import type { SchemaInput } from '../utils/llm-provider.js';
import type { Page } from 'playwright';

export type { AgentRunOptions, AgentResult, AgentStepEvent, ActOptions, ActionResult, ObserveResult, SentinelOptions };

// ─── AI fixture type ──────────────────────────────────────────────────────────

export interface AIFixture {
  /** Navigate to a URL */
  goto(url: string): Promise<void>;
  /** Perform a natural language action */
  act(instruction: string, options?: ActOptions): Promise<ActionResult>;
  /** Extract structured data from the current page */
  extract<T>(instruction: string, schema: SchemaInput<T>): Promise<T>;
  /** Observe interactive elements on the current page */
  observe(instruction?: string): Promise<ObserveResult[]>;
  /** Run an autonomous multi-step agent */
  run(goal: string, options?: AgentRunOptions): Promise<AgentResult>;
  /** Stream agent steps in real time */
  runStream(goal: string, options?: AgentRunOptions): AsyncGenerator<AgentStepEvent | AgentResult>;
  /** Take a screenshot */
  screenshot(): Promise<Buffer>;
  /** Describe the current page visually (requires visionFallback: true in sentinelOptions) */
  describeScreen(): Promise<string>;
  /** The underlying Playwright page managed by Sentinel */
  page: Page;
  /** Accumulated token usage for this test */
  getTokenUsage(): ReturnType<Sentinel['getTokenUsage']>;
}

// ─── Extended test ─────────────────────────────────────────────────────────────
//
// Usage:
//
//   import { test, expect } from '@isoldex/sentinel/test';
//
//   test('searches on Google', async ({ ai }) => {
//     await ai.goto('https://google.com');
//     await ai.act('Type "Sentinel browser automation" into the search field');
//     await ai.act('Click the search button');
//     const results = await ai.extract<{ titles: string[] }>(
//       'Get the first 3 result titles',
//       { type: 'object', properties: { titles: { type: 'array', items: { type: 'string' } } } }
//     );
//     expect(results.titles.length).toBeGreaterThan(0);
//   });
//
// To customise Sentinel options use test.use():
//
//   test.use({ sentinelOptions: { headless: false, verbose: 1 } });

// ─── Fixture implementation (exported for unit testing) ─────────────────────

export type SentinelConstructor = new (opts: SentinelOptions) => Sentinel;

export async function runAiFixture(
  sentinelOptions: Partial<SentinelOptions>,
  use: (ai: AIFixture) => Promise<void>,
  SentinelClass: SentinelConstructor = Sentinel
): Promise<void> {
  const apiKey = (sentinelOptions as any).apiKey ?? process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    throw new Error(
      '[Sentinel] apiKey is required. Set GEMINI_API_KEY or pass sentinelOptions.apiKey via test.use().'
    );
  }

  const sentinel = new SentinelClass({
    headless: true,
    verbose: 0,
    ...sentinelOptions,
    apiKey,
  } as SentinelOptions);

  await sentinel.init();

  const ai: AIFixture = {
    goto: (url) => sentinel.goto(url),
    act: (instruction, options) => sentinel.act(instruction, options),
    extract: <T>(instruction: string, schema: unknown) => sentinel.extract<T>(instruction, schema as any),
    observe: (instruction) => sentinel.observe(instruction),
    run: (goal, options) => sentinel.run(goal, options),
    runStream: (goal, options) => sentinel.runStream(goal, options),
    screenshot: () => sentinel.screenshot(),
    describeScreen: () => sentinel.describeScreen(),
    get page() { return sentinel.page; },
    getTokenUsage: () => sentinel.getTokenUsage(),
  };

  try {
    await use(ai);
  } finally {
    await sentinel.close();
  }
}

// ─── Extended test ─────────────────────────────────────────────────────────────

export const test = base.extend<{
  ai: AIFixture;
  sentinelOptions: Partial<SentinelOptions>;
}>({
  sentinelOptions: [
    {},
    { option: true },
  ] as any,

  ai: async ({ sentinelOptions }: { sentinelOptions: Partial<SentinelOptions> }, use: (ai: AIFixture) => Promise<void>) => {
    await runAiFixture(sentinelOptions, use);
  },
});

export { expect };
