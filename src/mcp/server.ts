import * as dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

/**
 * Starts the MCP server. Transport is selected via environment:
 *
 *   SENTINEL_MCP_HTTP=1  → Streamable HTTP transport on
 *                          http://<SENTINEL_MCP_HOST|127.0.0.1>:<SENTINEL_MCP_PORT|3333>/mcp
 *
 *   (default)            → stdio transport (Cursor, Windsurf, Claude Desktop
 *                          spawn the server as a subprocess)
 *
 * HTTP mode is meant for scenarios where the MCP client and the Sentinel
 * process are decoupled — shared team instance, Docker/Kubernetes deployments,
 * and local dev workflows where you want to rebuild Sentinel without
 * restarting the MCP client (client auto-reconnects with exponential backoff).
 */
export async function startServer() {
  if (process.env.SENTINEL_MCP_HTTP === '1') {
    // HTTP transport creates a fresh McpServer per request (see
    // startHttpTransport) — no shared server needed here.
    await startHttpTransport();
  } else {
    const server = new McpServer({ name: 'sentinel', version: '4.1.5' });
    registerTools(server, getOrInit, cleanup);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

async function startHttpTransport(): Promise<void> {
  const port = Number(process.env.SENTINEL_MCP_PORT ?? 3333);
  const host = process.env.SENTINEL_MCP_HOST ?? '127.0.0.1';

  // Stateless mode pattern (per MCP SDK docs): create a fresh McpServer and
  // transport per HTTP request. Sharing a single transport across requests
  // breaks after the first initialize because the transport's internal
  // request/response wiring is single-use. Tool execution reaches the shared
  // Sentinel browser singleton via `getOrInit()` inside the registered tool
  // handlers, so a new McpServer per request is cheap — it's just the wiring,
  // not the browser.
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp') {
      res.statusCode = 404;
      res.end('Not Found — MCP endpoint is /mcp');
      return;
    }
    let perReqServer: McpServer | null = null;
    let perReqTransport: StreamableHTTPServerTransport | null = null;
    try {
      perReqServer = new McpServer({ name: 'sentinel', version: '4.1.5' });
      registerTools(perReqServer, getOrInit, cleanup);
      perReqTransport = new StreamableHTTPServerTransport(
        { sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]
      );
      await perReqServer.connect(perReqTransport as unknown as Parameters<typeof perReqServer.connect>[0]);

      // Parse JSON body (pre-parsing lets the transport skip its own body reader).
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyStr = Buffer.concat(chunks).toString('utf-8');
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;

      // On response close, tear down the per-request plumbing (but NOT the
      // shared Sentinel browser session — that lives across requests).
      res.on('close', () => {
        perReqTransport?.close().catch(() => {});
        perReqServer?.close().catch(() => {});
      });

      await perReqTransport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[Sentinel MCP] HTTP request error:', (err as Error).message);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      perReqTransport?.close().catch(() => {});
      perReqServer?.close().catch(() => {});
    }
  });

  http.listen(port, host, () => {
    console.error(`[Sentinel MCP] HTTP transport listening on http://${host}:${port}/mcp`);
  });

  // Graceful shutdown — close HTTP server + browser session on SIGINT/SIGTERM.
  const shutdown = () => {
    http.close();
    void cleanup().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
