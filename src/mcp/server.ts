import * as dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Sentinel } from '../index.js';
import { SENTINEL_VERSION } from '../version.js';
import type { SentinelOptions } from '../index.js';
import { ignoreRejection } from '../utils/ignore-rejection.js';
import { createSessionManager, type RunExclusive } from './session.js';
import {
  readSecurityConfig,
  checkRebinding,
  checkAuth,
  readBodyLimited,
  BodyTooLargeError,
  isPubliclyBound,
} from './http-security.js';

// ─── Sentinel session ─────────────────────────────────────────────────────
//
// The MCP server keeps a single browser session alive for the duration of the
// process. Tools that don't specify a URL operate on the currently open page.
// Initialisation and tool execution are serialised — see ./session.ts.

const sessionManager = createSessionManager((): SentinelOptions => {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  return {
    apiKey,
    headless: process.env.SENTINEL_HEADLESS !== 'false',
    verbose: 0,
  };
});

// Wrapped rather than aliased: passing the members directly as values detaches
// them from the manager, which is exactly what `unbound-method` warns about.
const getOrInit = (): Promise<Sentinel> => sessionManager.getOrInit();
const cleanup = (): Promise<void> => sessionManager.cleanup();

// `process.on` discards the returned promise, so an async listener that rejects
// becomes an unhandled rejection and the process never reaches process.exit().
// `.finally` guarantees the exit either way — same shape as the HTTP transport's
// shutdown handler further down.
const exitAfterCleanup = () => {
  void cleanup().finally(() => process.exit(0));
};
process.on('SIGINT', exitAfterCleanup);
process.on('SIGTERM', exitAfterCleanup);

// ─── Tool registration (exported for testing) ─────────────────────────────

export type SessionFactory = () => Promise<Sentinel>;
export type CleanupFn = () => Promise<void>;

/** Shape the MCP SDK expects back from a tool handler. */
type ToolResult = {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

export function registerTools(
  server: McpServer,
  sessionFactory: SessionFactory,
  cleanupFn: CleanupFn = async () => {},
  /**
   * Serialises tool execution against the shared browser. Defaults to running
   * inline so tests (and the stdio transport, which is single-client by
   * construction) need not care.
   */
  runExclusive: RunExclusive = fn => fn()
): void {
  /**
   * Every tool body is "get the session, do one thing, report errors as tool
   * errors rather than transport errors". Factoring it out removes seven
   * identical try/catch blocks and — more importantly — guarantees no handler
   * can forget the exclusivity wrapper.
   */
  const tool = (fn: (s: Sentinel) => Promise<ToolResult>) => (): Promise<ToolResult> =>
    runExclusive(async () => {
      try {
        return await fn(await sessionFactory());
      } catch (err) {
        return {
          content: [{ type: 'text', text: `❌ Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    });
  // ── goto ──────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_goto',
    'Navigate the browser to a URL',
    { url: z.string().describe('The URL to navigate to') },
    ({ url }) =>
      tool(async s => {
        await s.goto(url);
        return text(`Navigated to ${url}`);
      })()
  );

  // ── act ───────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_act',
    'Perform a natural language action on the current page (click, fill, scroll, press, etc.)',
    {
      instruction: z.string().describe('What to do, e.g. "Click the login button"'),
      variables: z
        .record(z.string(), z.string())
        .optional()
        .describe('Variable substitutions for %varName% placeholders'),
    },
    ({ instruction, variables }) =>
      tool(async s => {
        const result = await s.act(instruction, variables ? { variables } : undefined);
        return text(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      })()
  );

  // ── extract ───────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_extract',
    'Extract structured data from the current page using a natural language instruction',
    {
      instruction: z.string().describe('What to extract, e.g. "Get all product names and prices"'),
      schema: z
        .record(z.string(), z.any())
        .optional()
        .describe('JSON Schema describing the expected output structure'),
    },
    ({ instruction, schema }) =>
      tool(async s => json(await s.extract(instruction, (schema ?? { type: 'object' }) as any)))()
  );

  // ── observe ───────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_observe',
    'List interactive elements visible on the current page',
    {
      instruction: z
        .string()
        .optional()
        .describe('Optional focus hint, e.g. "Find login-related elements"'),
    },
    ({ instruction }) => tool(async s => json(await s.observe(instruction ?? undefined)))()
  );

  // ── run ───────────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_run',
    'Run an autonomous multi-step agent to achieve a high-level goal',
    {
      goal: z
        .string()
        .describe('The goal to achieve, e.g. "Search for laptops and extract the top 3 results"'),
      maxSteps: z.number().optional().describe('Maximum number of steps (default: 15)'),
    },
    ({ goal, maxSteps }) =>
      tool(async s => {
        const result = await s.run(goal, { maxSteps: maxSteps ?? 15 });
        return json({
          goalAchieved: result.goalAchieved,
          totalSteps: result.totalSteps,
          message: result.message,
          data: result.data ?? null,
          tokens: s.getTokenUsage(),
        });
      })()
  );

  // ── screenshot ────────────────────────────────────────────────────────────

  server.tool(
    'sentinel_screenshot',
    'Take a screenshot of the current page and return it as base64',
    {},
    tool(async s => {
      const buf = await s.screenshot();
      return {
        content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }],
      };
    })
  );

  // ── close ─────────────────────────────────────────────────────────────────

  // Closing must queue behind in-flight tool calls, otherwise it can tear the
  // browser down while another request is mid-action.
  server.tool('sentinel_close', 'Close the browser session', {}, () =>
    runExclusive(async () => {
      await cleanupFn();
      return text('Browser session closed.');
    })
  );

  // ── token_usage ───────────────────────────────────────────────────────────

  server.tool(
    'sentinel_token_usage',
    'Get accumulated token usage and estimated cost for this session',
    {},
    tool(async s => json(s.getTokenUsage()))
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
 *
 * HTTP-mode security knobs (all optional, safe defaults):
 *
 *   SENTINEL_MCP_TOKEN            Shared secret; clients send
 *                                 `Authorization: Bearer <token>`. **Required**
 *                                 when SENTINEL_MCP_HOST is not loopback —
 *                                 startup fails otherwise.
 *   SENTINEL_MCP_ALLOWED_HOSTS    Comma-separated extra `Host` values to accept
 *                                 (loopback is always accepted).
 *   SENTINEL_MCP_ALLOWED_ORIGINS  Comma-separated extra `Origin` values.
 *   SENTINEL_MCP_MAX_BODY_BYTES   Request body cap (default 4 MiB).
 *
 * Note that every request drives the *same* browser session, and tool calls are
 * therefore serialised. HTTP mode is for decoupling the client, not for serving
 * concurrent users.
 */
export async function startServer() {
  if (process.env.SENTINEL_MCP_HTTP === '1') {
    // HTTP transport creates a fresh McpServer per request (see
    // startHttpTransport) — no shared server needed here.
    await startHttpTransport();
  } else {
    const server = new McpServer({ name: 'sentinel', version: SENTINEL_VERSION });
    // JSON-RPC permits pipelined requests even over stdio, so serialise here too.
    registerTools(server, getOrInit, cleanup, sessionManager.runExclusive);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

/**
 * Interval at which we write SSE heartbeat comments (`: hb\n\n`) on long-running
 * tool calls. Browser/proxy/runtime idle timers typically fire between 30 and
 * 60 seconds; 25 s leaves comfortable headroom on both sides.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;

async function startHttpTransport(): Promise<void> {
  const port = Number(process.env.SENTINEL_MCP_PORT ?? 3333);
  const host = process.env.SENTINEL_MCP_HOST ?? '127.0.0.1';
  const security = readSecurityConfig(host, port);

  // Fail closed. Binding to 0.0.0.0 is the documented move for the Docker and
  // Kubernetes setups, and without a token it publishes unauthenticated remote
  // control of a real browser — including whatever sessions it has logged into.
  // Refusing to start is the only safe default; an operator who genuinely wants
  // an open endpoint can set SENTINEL_MCP_TOKEN to a known value.
  if (isPubliclyBound(host) && !security.token) {
    throw new Error(
      `Refusing to start: SENTINEL_MCP_HOST=${host} exposes the MCP server beyond this machine ` +
        `but SENTINEL_MCP_TOKEN is not set. Set a token (clients send it as ` +
        `"Authorization: Bearer <token>"), or bind to 127.0.0.1.`
    );
  }

  // Stateless mode pattern (per MCP SDK docs): create a fresh McpServer and
  // transport per HTTP request. Sharing a single transport across requests
  // breaks after the first initialize because the transport's internal
  // request/response wiring is single-use. Tool execution reaches the shared
  // Sentinel browser singleton via `getOrInit()` inside the registered tool
  // handlers, so a new McpServer per request is cheap — it's just the wiring,
  // not the browser.
  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp') {
      res.statusCode = 404;
      res.end('Not Found — MCP endpoint is /mcp');
      return;
    }

    // DNS-rebinding guard before anything else: any web page can POST to
    // 127.0.0.1, so a loopback bind is not by itself an access control.
    const rebinding = checkRebinding(req, security);
    if (rebinding) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: rebinding }));
      return;
    }

    const unauthorised = checkAuth(req, security);
    if (unauthorised) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.end(JSON.stringify({ error: unauthorised }));
      return;
    }

    // Long-running agent runs (`sentinel_run`) regularly take 3-5+ minutes
    // because each step is bounded by browser+LLM latency, not CPU. The MCP
    // Streamable HTTP SDK opens an SSE response and only writes bytes when the
    // tool completes — no heartbeats. If no bytes flow for the duration of
    // Node's `server.requestTimeout` (300 s default in Node 18+) the socket
    // is killed and the client sees `transport dropped mid-call`. We hijack
    // `res.writeHead` to detect when an SSE response starts, then write a
    // `:hb\n\n` comment every 25 s until the response closes — the comment is
    // valid SSE syntax (clients ignore it) but resets idle timers along the
    // entire path (Node, proxies, fetch keepalive, etc.). The server-level
    // `requestTimeout = 0` covers the Node side independently in case the
    // detection misses an edge case.
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const startHeartbeatIfSse = (headers: unknown) => {
      if (heartbeatTimer || !headers || typeof headers !== 'object') return;
      const h = headers as Record<string, unknown>;
      const ct = (h['content-type'] ?? h['Content-Type']) as string | undefined;
      if (typeof ct !== 'string' || !ct.toLowerCase().includes('text/event-stream')) return;
      heartbeatTimer = setInterval(() => {
        try {
          if (res.writableEnded) {
            stopHeartbeat();
            return;
          }
          res.write(': hb\n\n');
        } catch {
          stopHeartbeat();
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);
    };
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (...args: unknown[]) => {
      // Headers may appear as the 2nd or 3rd positional argument; scan both.
      for (const arg of args) startHeartbeatIfSse(arg);
      return (origWriteHead as (...a: unknown[]) => ServerResponse)(...args);
    };

    let perReqServer: McpServer | null = null;
    let perReqTransport: StreamableHTTPServerTransport | null = null;
    try {
      perReqServer = new McpServer({ name: 'sentinel', version: SENTINEL_VERSION });
      // All requests drive the same browser, so tool execution is serialised
      // through the session manager's queue.
      registerTools(perReqServer, getOrInit, cleanup, sessionManager.runExclusive);
      perReqTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      await perReqServer.connect(
        perReqTransport as unknown as Parameters<typeof perReqServer.connect>[0]
      );

      // Parse JSON body (pre-parsing lets the transport skip its own body reader).
      // Size-capped: an unterminated body used to be buffered without limit.
      const bodyStr = await readBodyLimited(req, security.maxBodyBytes);
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;

      // On response close, tear down the per-request plumbing (but NOT the
      // shared Sentinel browser session — that lives across requests).
      res.on('close', () => {
        stopHeartbeat();
        perReqTransport?.close().catch(ignoreRejection);
        perReqServer?.close().catch(ignoreRejection);
      });
      res.on('finish', stopHeartbeat);

      await perReqTransport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[Sentinel MCP] HTTP request error:', (err as Error).message);
      stopHeartbeat();
      if (!res.writableEnded) {
        // An oversized body is the client's error, not the server's — say so,
        // otherwise it looks like a crash and clients retry it.
        res.statusCode = err instanceof BodyTooLargeError ? 413 : 500;
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      perReqTransport?.close().catch(ignoreRejection);
      perReqServer?.close().catch(ignoreRejection);
    }
  };

  // createHttpServer discards the handler's promise, so a rejection escaping
  // handleMcpRequest would surface as an unhandled rejection rather than a
  // response. The handler catches its own body; this is the last-resort net for
  // anything thrown while handling that error.
  const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handleMcpRequest(req, res).catch(err => {
      console.error('[Sentinel MCP] unhandled HTTP handler error:', (err as Error).message);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  // Disable Node's *request* timeout. SSE responses for long agent runs sit
  // open with no incoming/outgoing bytes for minutes at a time, which Node 18+
  // would otherwise kill after `requestTimeout` (default 300 s). The
  // per-request heartbeat injector above keeps genuine activity flowing, and
  // `res.on('close')` collects hung connections.
  http.requestTimeout = 0;
  http.timeout = 0;
  // Headers, unlike bodies, are never slow for a legitimate client. Keeping
  // this bound is what stops a Slowloris-style hold from accumulating sockets —
  // the body cap alone does not help if the request never reaches the body.
  http.headersTimeout = 30_000;

  http.listen(port, host, () => {
    const auth = security.token ? 'bearer token required' : 'no auth (loopback only)';
    console.error(
      `[Sentinel MCP] HTTP transport listening on http://${host}:${port}/mcp — ${auth}`
    );
  });

  // Graceful shutdown — close HTTP server + browser session on SIGINT/SIGTERM.
  const shutdown = () => {
    http.close();
    void cleanup().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
