import { describe, it, expect, afterEach } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import {
  checkAuth,
  checkRebinding,
  readBodyLimited,
  readSecurityConfig,
  isPubliclyBound,
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES,
  type HttpSecurityConfig,
} from '../../mcp/http-security.js';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const base: HttpSecurityConfig = {
  host: '127.0.0.1',
  port: 3333,
  token: undefined,
  allowedHosts: [],
  allowedOrigins: [],
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
};

describe('isPubliclyBound', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('treats %s as loopback', host => {
    expect(isPubliclyBound(host)).toBe(false);
  });

  it.each(['0.0.0.0', '192.168.1.20', 'sentinel.internal'])('treats %s as public', host => {
    expect(isPubliclyBound(host)).toBe(true);
  });
});

describe('checkRebinding', () => {
  it('accepts a loopback Host with no Origin (the normal MCP client)', () => {
    // Claude Desktop, Cursor and curl send no Origin at all — they must not be
    // locked out by a guard aimed at browsers.
    expect(checkRebinding(req({ host: '127.0.0.1:3333' }), base)).toBeNull();
  });

  it('accepts an explicit localhost Origin', () => {
    expect(
      checkRebinding(req({ host: 'localhost:3333', origin: 'http://localhost:5173' }), base)
    ).toBeNull();
  });

  it('rejects a foreign Origin', () => {
    // The DNS-rebinding case: a visited page POSTing to the local server.
    const reason = checkRebinding(
      req({ host: '127.0.0.1:3333', origin: 'https://evil.test' }),
      base
    );
    expect(reason).toMatch(/Origin/);
  });

  it('rejects a Host header pointing at an attacker-controlled name', () => {
    const reason = checkRebinding(req({ host: 'rebind.evil.test:3333' }), base);
    expect(reason).toMatch(/Host/);
  });

  it('accepts a foreign Host when explicitly allow-listed', () => {
    const cfg = { ...base, allowedHosts: ['sentinel.internal:3333'] };
    expect(checkRebinding(req({ host: 'sentinel.internal:3333' }), cfg)).toBeNull();
  });

  it('accepts a foreign Origin when explicitly allow-listed', () => {
    const cfg = { ...base, allowedOrigins: ['https://app.internal'] };
    expect(
      checkRebinding(req({ host: '127.0.0.1:3333', origin: 'https://app.internal' }), cfg)
    ).toBeNull();
  });

  it('handles bracketed IPv6 hosts', () => {
    expect(checkRebinding(req({ host: '[::1]:3333' }), base)).toBeNull();
  });

  it('rejects an unparseable Origin rather than ignoring it', () => {
    expect(checkRebinding(req({ host: '127.0.0.1:3333', origin: 'not a url' }), base)).toMatch(
      /Origin/
    );
  });
});

describe('checkAuth', () => {
  it('is a no-op when no token is configured', () => {
    expect(checkAuth(req({}), base)).toBeNull();
  });

  it('accepts the correct bearer token', () => {
    const cfg = { ...base, token: 's3cret' };
    expect(checkAuth(req({ authorization: 'Bearer s3cret' }), cfg)).toBeNull();
  });

  it('rejects a missing Authorization header', () => {
    const cfg = { ...base, token: 's3cret' };
    expect(checkAuth(req({}), cfg)).toMatch(/Missing/);
  });

  it('rejects a wrong token', () => {
    const cfg = { ...base, token: 's3cret' };
    expect(checkAuth(req({ authorization: 'Bearer nope!!' }), cfg)).toMatch(/Invalid/);
  });

  it('rejects a token of a different length', () => {
    const cfg = { ...base, token: 's3cret' };
    expect(checkAuth(req({ authorization: 'Bearer s3' }), cfg)).toMatch(/Invalid/);
  });

  it('rejects a non-Bearer scheme', () => {
    const cfg = { ...base, token: 's3cret' };
    expect(checkAuth(req({ authorization: 'Basic czNjcmV0' }), cfg)).toMatch(/Missing/);
  });
});

describe('readBodyLimited', () => {
  it('reads a body that fits within the limit', async () => {
    const stream = Readable.from([Buffer.from('{"jsonrpc":'), Buffer.from('"2.0"}')]);
    await expect(readBodyLimited(stream, 1024)).resolves.toBe('{"jsonrpc":"2.0"}');
  });

  it('throws BodyTooLargeError instead of buffering without bound', async () => {
    // The point of the cap: an unterminated body used to accumulate until the
    // process ran out of memory, with no authentication required to do it.
    const stream = Readable.from([Buffer.alloc(64), Buffer.alloc(64)]);
    await expect(readBodyLimited(stream, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('reports the limit in the error message', async () => {
    const stream = Readable.from([Buffer.alloc(200)]);
    await expect(readBodyLimited(stream, 100)).rejects.toThrow('100 bytes');
  });

  it('accepts string chunks as well as buffers', async () => {
    await expect(readBodyLimited(Readable.from(['ab', 'cd']), 10)).resolves.toBe('abcd');
  });
});

describe('readSecurityConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to no token and the default body cap', () => {
    delete process.env.SENTINEL_MCP_TOKEN;
    delete process.env.SENTINEL_MCP_MAX_BODY_BYTES;
    const cfg = readSecurityConfig('127.0.0.1', 3333);
    expect(cfg.token).toBeUndefined();
    expect(cfg.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it('parses comma-separated allow-lists and trims whitespace', () => {
    process.env.SENTINEL_MCP_ALLOWED_HOSTS = 'a.test:1, b.test:2 ,';
    const cfg = readSecurityConfig('127.0.0.1', 3333);
    expect(cfg.allowedHosts).toEqual(['a.test:1', 'b.test:2']);
  });

  it('falls back to the default cap when the env value is not a positive number', () => {
    process.env.SENTINEL_MCP_MAX_BODY_BYTES = 'lots';
    expect(readSecurityConfig('127.0.0.1', 3333).maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
  });
});
