import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoundRobinProxyProvider, WebshareProxyProvider, isProxyProvider } from '../utils/proxy-provider.js';
import type { IProxyProvider } from '../utils/proxy-provider.js';

// ─── RoundRobinProxyProvider ──────────────────────────────────────────────────

describe('RoundRobinProxyProvider', () => {
  const proxies = [
    { server: 'http://p1:8080', username: 'u1', password: 'pw1' },
    { server: 'http://p2:8080', username: 'u2', password: 'pw2' },
    { server: 'http://p3:8080', username: 'u3', password: 'pw3' },
  ];

  it('returns proxies in round-robin order', () => {
    const provider = new RoundRobinProxyProvider(proxies);
    expect(provider.getProxy()).toEqual(proxies[0]);
    expect(provider.getProxy()).toEqual(proxies[1]);
    expect(provider.getProxy()).toEqual(proxies[2]);
    expect(provider.getProxy()).toEqual(proxies[0]); // wraps
  });

  it('wraps around after exhausting all proxies', () => {
    const provider = new RoundRobinProxyProvider(proxies);
    for (let i = 0; i < 9; i++) provider.getProxy();
    expect(provider.getProxy()).toEqual(proxies[0]);
  });

  it('throws when constructed with an empty array', () => {
    expect(() => new RoundRobinProxyProvider([])).toThrow();
  });

  it('satisfies IProxyProvider interface', () => {
    const provider = new RoundRobinProxyProvider(proxies);
    expect(isProxyProvider(provider)).toBe(true);
  });
});

// ─── WebshareProxyProvider ────────────────────────────────────────────────────

describe('WebshareProxyProvider', () => {
  const mockProxies = [
    { id: '1', username: 'u1', password: 'pw1', proxy_address: 'p1.example.com', port: 8080 },
    { id: '2', username: 'u2', password: 'pw2', proxy_address: 'p2.example.com', port: 8080 },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: mockProxies, count: mockProxies.length }),
    }));
  });

  it('fetches proxies from Webshare API on first call', async () => {
    const provider = new WebshareProxyProvider({ apiKey: 'test-key' });
    const proxy = await provider.getProxy();
    expect(proxy.server).toBe('http://p1.example.com:8080');
    expect(proxy.username).toBe('u1');
    expect(proxy.password).toBe('pw1');
  });

  it('uses socks5 protocol when specified', async () => {
    const provider = new WebshareProxyProvider({ apiKey: 'test-key', protocol: 'socks5' });
    const proxy = await provider.getProxy();
    expect(proxy.server.startsWith('socks5://')).toBe(true);
  });

  it('rotates proxies in round-robin order', async () => {
    const provider = new WebshareProxyProvider({ apiKey: 'test-key' });
    const p1 = await provider.getProxy();
    const p2 = await provider.getProxy();
    const p3 = await provider.getProxy(); // wraps
    expect(p1.server).toBe('http://p1.example.com:8080');
    expect(p2.server).toBe('http://p2.example.com:8080');
    expect(p3.server).toBe('http://p1.example.com:8080');
  });

  it('only fetches once even with concurrent calls', async () => {
    const provider = new WebshareProxyProvider({ apiKey: 'test-key' });
    await Promise.all([provider.getProxy(), provider.getProxy(), provider.getProxy()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws when API returns an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }));
    const provider = new WebshareProxyProvider({ apiKey: 'bad-key' });
    await expect(provider.getProxy()).rejects.toThrow('401');
  });

  it('throws when API returns empty proxy list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], count: 0 }),
    }));
    const provider = new WebshareProxyProvider({ apiKey: 'test-key' });
    await expect(provider.getProxy()).rejects.toThrow('no proxies');
  });

  it('includes country filter in API request', async () => {
    const provider = new WebshareProxyProvider({ apiKey: 'test-key', country: 'DE' });
    await provider.getProxy();
    const calledUrl = (fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('country_code__icontains=DE');
  });
});

// ─── isProxyProvider ──────────────────────────────────────────────────────────

describe('isProxyProvider', () => {
  it('returns true for objects with a getProxy function', () => {
    const provider: IProxyProvider = { getProxy: () => ({ server: 'http://x' }) };
    expect(isProxyProvider(provider)).toBe(true);
  });

  it('returns false for plain ProxyOptions', () => {
    expect(isProxyProvider({ server: 'http://x' })).toBe(false);
  });

  it('returns false for null / primitives', () => {
    expect(isProxyProvider(null)).toBe(false);
    expect(isProxyProvider(undefined)).toBe(false);
    expect(isProxyProvider('http://x')).toBe(false);
  });
});
