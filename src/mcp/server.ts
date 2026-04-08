import * as dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Sentinel } from '../index.js';
import type { SentinelOptions } from '../index.js';

// ─── Sentinel session ─────────────────────────────────────────────────────
//
// The MCP server keeps a single browser session alive for the duration of the
// process. Tools that don't specify a URL operate on the currently open page.

let sentinel: Sentinel | null = null;

async function getOrInit(): Promise<Sentinel> {
  if (sentinel) return sentinel;

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const options: SentinelOptions = {
    apiKey,
    headless: process.env.SENTINEL_HEADLESS !== 'false',
    verbose: 0,
  };

  sentinel = new Sentinel(options);
  await sentinel.init();
  return sentinel;
}

async function cleanup() {
  if (sentinel) {
    await sentinel.close().catch(() => {});
    sentinel = null;
  }
}

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

// ─── Tool registration (exported for testing) ─────────────────────────────

export type SessionFactory = () => Promise<Sentinel>;
export type CleanupFn = () => Promise<void>;

export function registerTools(
  server: McpServer,
  sessionFactory: SessionFactory,
  cleanupFn: CleanupFn = async () => {}
): void {

  // ── goto ──────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_goto',
    'Navigate the browser to a URL',
    { url: z.string().describe('The URL to navigate to') },
    async ({ url }) => {
      try {
        const s = await sessionFactory();
        await s.goto(url);
        return { content: [{ type: 'text' as const, text: `Navigated to ${url}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // ── act ───────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_act',
    'Perform a natural language action on the current page (click, fill, scroll, press, etc.)',
    {
      instruction: z.string().describe('What to do, e.g. "Click the login button"'),
      variables: z.record(z.string(), z.string()).optional().describe('Variable substitutions for %varName% placeholders'),
    },
    async ({ instruction, variables }) => {
      try {
        const s = await sessionFactory();
        const result = await s.act(instruction, variables ? { variables: variables as Record<string, string> } : undefined);
        return {
          content: [{
            type: 'text' as const,
            text: result.success
              ? `✅ ${result.message}`
              : `❌ ${result.message}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // ── extract ───────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_extract',
    'Extract structured data from the current page using a natural language instruction',
    {
      instruction: z.string().describe('What to extract, e.g. "Get all product names and prices"'),
      schema: z.record(z.string(), z.any()).optional().describe('JSON Schema describing the expected output structure'),
    },
    async ({ instruction, schema }) => {
      try {
        const s = await sessionFactory();
        const result = await s.extract(instruction, (schema ?? { type: 'object' }) as any);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // ── observe ───────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_observe',
    'List interactive elements visible on the current page',
    {
      instruction: z.string().optional().describe('Optional focus hint, e.g. "Find login-related elements"'),
    },
    async ({ instruction }) => {
      try {
        const s = await sessionFactory();
        const elements = await s.observe(instruction ?? undefined);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(elements, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // ── run ───────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_run',
    'Run an autonomous multi-step agent to achieve a high-level goal',
    {
      goal: z.string().describe('The goal to achieve, e.g. "Search for laptops and extract the top 3 results"'),
      maxSteps: z.number().optional().describe('Maximum number of steps (default: 15)'),
    },
    async ({ goal, maxSteps }) => {
      try {
        const s = await sessionFactory();
        const result = await s.run(goal, { maxSteps: maxSteps ?? 15 });
        const summary = {
          goalAchieved: result.goalAchieved,
          totalSteps: result.totalSteps,
          message: result.message,
          data: result.data ?? null,
          tokens: s.getTokenUsage(),
        };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(summary, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // ── screenshot ────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_screenshot',
    'Take a screenshot of the current page and return it as base64',
    {},
    async () => {
      try {
        const s = await sessionFactory();
        const buf = await s.screenshot();
        return {
          content: [{
            type: 'image' as const,
            data: buf.toString('base64'),
            mimeType: 'image/png',
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // ── close ─────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_close',
    'Close the browser session',
    {},
    async () => {
      await cleanupFn();
      return { content: [{ type: 'text' as const, text: 'Browser session closed.' }] };
    }
  );

  // ── token_usage ───────────────────────────────────────────────────────────

  server.tool(
    'sentinel_token_usage',
    'Get accumulated token usage and estimated cost for this session',
    {},
    async () => {
      try {
        const s = await sessionFactory();
        const usage = s.getTokenUsage();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(usage, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `❌ Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

}

// ─── MCP Server entry ──────────────────────────────────────────────────────

export async function startServer() {
  const server = new McpServer({ name: 'sentinel', version: '3.8.0' });
  registerTools(server, getOrInit, cleanup);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
