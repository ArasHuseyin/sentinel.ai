import type { IncomingMessage } from 'node:http';

/**
 * Request-level guards for the MCP Streamable HTTP transport.
 *
 * The transport hands whoever can reach it full control of a real browser:
 * navigate anywhere, read any page, replay any cookie the session holds. The
 * defaults below assume a loopback bind and a non-browser client; anything
 * beyond that has to be opted into explicitly.
 */

/** 4 MiB. A JSON-RPC tool call is kilobytes; this is generous and still bounded. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpSecurityConfig {
  /** Interface the server binds to, used to decide whether auth is mandatory. */
  host: string;
  /** Port, used to build the default allow-list of `Host` values. */
  port: number;
  /** Shared secret required as `Authorization: Bearer <token>`. */
  token: string | undefined;
  /** Extra `Host` header values to accept, beyond the loopback defaults. */
  allowedHosts: string[];
  /** Extra `Origin` header values to accept, beyond the loopback defaults. */
  allowedOrigins: string[];
  /** Hard cap on request body size. */
  maxBodyBytes: number;
}

/** Hostnames that mean "this machine" and therefore cannot be rebound remotely. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function splitEnvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** True when the bind address is reachable from outside this machine. */
export function isPubliclyBound(host: string): boolean {
  return !LOOPBACK_HOSTNAMES.has(host.toLowerCase());
}

export function readSecurityConfig(host: string, port: number): HttpSecurityConfig {
  const maxBody = Number(process.env.SENTINEL_MCP_MAX_BODY_BYTES);
  return {
    host,
    port,
    token: process.env.SENTINEL_MCP_TOKEN || undefined,
    allowedHosts: splitEnvList(process.env.SENTINEL_MCP_ALLOWED_HOSTS),
    allowedOrigins: splitEnvList(process.env.SENTINEL_MCP_ALLOWED_ORIGINS),
    maxBodyBytes: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY_BYTES,
  };
}

function hostnameOf(hostHeader: string): string {
  // Strip the port. IPv6 literals are bracketed (`[::1]:3333`), so split on the
  // last colon only when it comes after the closing bracket.
  const idx = hostHeader.lastIndexOf(':');
  const closing = hostHeader.lastIndexOf(']');
  if (idx > closing) return hostHeader.slice(0, idx);
  return hostHeader;
}

/**
 * Validates `Host` and `Origin` against DNS rebinding.
 *
 * A page on any website can POST to `http://127.0.0.1:3333/mcp`. Without an
 * `Origin` check, a visited page could drive this browser. Without a `Host`
 * check, an attacker-controlled domain whose DNS resolves to 127.0.0.1 achieves
 * the same thing while looking same-origin to the browser.
 *
 * A missing `Origin` is allowed: non-browser MCP clients (Claude Desktop,
 * Cursor, curl) do not send one, and they are the intended callers. Browsers
 * always send it on cross-origin requests, which is exactly the case being
 * blocked.
 *
 * @returns null when the request is acceptable, otherwise a reason to reject with.
 */
export function checkRebinding(req: IncomingMessage, cfg: HttpSecurityConfig): string | null {
  const hostHeader = req.headers.host;
  if (hostHeader) {
    const hostname = hostnameOf(hostHeader).toLowerCase();
    const allowed =
      LOOPBACK_HOSTNAMES.has(hostname) ||
      hostname === cfg.host.toLowerCase() ||
      cfg.allowedHosts.includes(hostHeader) ||
      cfg.allowedHosts.includes(hostname);
    if (!allowed) return `Host header "${hostHeader}" is not allowed`;
  }

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return `Origin header "${origin}" is not a valid URL`;
    }
    const allowed = LOOPBACK_HOSTNAMES.has(originHost) || cfg.allowedOrigins.includes(origin);
    if (!allowed) return `Origin "${origin}" is not allowed`;
  }

  return null;
}

/**
 * Constant-time-ish bearer token check.
 *
 * @returns null when authorised, otherwise a reason to reject with.
 */
export function checkAuth(req: IncomingMessage, cfg: HttpSecurityConfig): string | null {
  if (!cfg.token) return null;
  const header = req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return 'Missing bearer token';
  const provided = header.slice(prefix.length);
  // Length check first, then a full-width compare that does not bail on the
  // first differing byte.
  if (provided.length !== cfg.token.length) return 'Invalid bearer token';
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ cfg.token.charCodeAt(i);
  }
  return diff === 0 ? null : 'Invalid bearer token';
}

/** Raised when a request body exceeds `maxBodyBytes`. */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads the request body with a hard size cap.
 *
 * The previous implementation accumulated chunks until the stream ended, so a
 * single client could drive the process out of memory by streaming an
 * unterminated body — no authentication required.
 */
export async function readBodyLimited(
  req: AsyncIterable<Buffer | string>,
  limit: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > limit) throw new BodyTooLargeError(limit);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
