import type { ProxyOptions } from '../core/driver.js';

/**
 * Interface for dynamic proxy providers.
 * Implement this to integrate any proxy rotation service.
 *
 * @example
 * const proxy = new RoundRobinProxyProvider([
 *   { server: 'http://proxy1:8080', username: 'u', password: 'p' },
 *   { server: 'http://proxy2:8080', username: 'u', password: 'p' },
 * ]);
 * const sentinel = new Sentinel({ apiKey, proxy });
 */
export interface IProxyProvider {
  /** Return the next proxy to use for a browser session. */
  getProxy(): ProxyOptions | Promise<ProxyOptions>;
  /** Optional: called after a session ends so the provider can track usage or recycle proxies. */
  releaseProxy?(proxy: ProxyOptions): Promise<void>;
}

// ─── RoundRobinProxyProvider ──────────────────────────────────────────────────

/**
 * Rotates through a static list of proxies in round-robin order.
 *
 * @example
 * const provider = new RoundRobinProxyProvider([
 *   { server: 'http://p1.example.com:8080' },
 *   { server: 'http://p2.example.com:8080' },
 * ]);
 */
export class RoundRobinProxyProvider implements IProxyProvider {
  private index = 0;

  constructor(private readonly proxies: ProxyOptions[]) {
    if (proxies.length === 0) throw new Error('RoundRobinProxyProvider: proxies array must not be empty');
  }

  getProxy(): ProxyOptions {
    const proxy = this.proxies[this.index % this.proxies.length]!;
    this.index++;
    return proxy;
  }
}

// ─── WebshareProxyProvider ────────────────────────────────────────────────────

interface WebshareProxy {
  id: string;
  username: string;
  password: string;
  proxy_address: string;
  port: number;
}

interface WebshareResponse {
  results: WebshareProxy[];
  count: number;
}

export interface WebshareProxyOptions {
  /** Webshare API key — get it from https://proxy.webshare.io/userapi/keys */
  apiKey: string;
  /** Maximum number of proxies to fetch and cache (default: 25). */
  limit?: number;
  /** Optional country code filter, e.g. 'US', 'DE' (default: any). */
  country?: string;
  /** Proxy protocol: 'http' | 'socks5' (default: 'http'). */
  protocol?: 'http' | 'socks5';
}

/**
 * Fetches proxies from the Webshare.io API and rotates through them in round-robin order.
 * The proxy list is fetched once on the first `getProxy()` call and cached for the lifetime
 * of the provider instance.
 *
 * @example
 * const provider = new WebshareProxyProvider({ apiKey: process.env.WEBSHARE_API_KEY! });
 * const sentinel = new Sentinel({ apiKey, proxy: provider });
 */
export class WebshareProxyProvider implements IProxyProvider {
  private cache: ProxyOptions[] = [];
  private index = 0;
  private fetchPromise: Promise<void> | null = null;

  constructor(private readonly opts: WebshareProxyOptions) {}

  private async fetchProxies(): Promise<void> {
    const limit  = this.opts.limit    ?? 25;
    const proto  = this.opts.protocol ?? 'http';
    const params = new URLSearchParams({ page_size: String(limit), mode: 'direct' });
    if (this.opts.country) params.set('country_code__icontains', this.opts.country);

    const resp = await fetch(`https://proxy.webshare.io/api/v2/proxy/list/?${params}`, {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
    });

    if (!resp.ok) {
      throw new Error(`WebshareProxyProvider: API error ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as WebshareResponse;

    this.cache = data.results.map(p => ({
      server:   `${proto}://${p.proxy_address}:${p.port}`,
      username: p.username,
      password: p.password,
    }));

    if (this.cache.length === 0) {
      throw new Error('WebshareProxyProvider: no proxies returned from API');
    }
  }

  async getProxy(): Promise<ProxyOptions> {
    // Lazy-fetch on first call; subsequent calls reuse the cache
    if (this.cache.length === 0) {
      if (!this.fetchPromise) {
        this.fetchPromise = this.fetchProxies();
      }
      await this.fetchPromise;
    }

    const proxy = this.cache[this.index % this.cache.length]!;
    this.index++;
    return proxy;
  }
}

// ─── Type guard ───────────────────────────────────────────────────────────────

export function isProxyProvider(value: unknown): value is IProxyProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getProxy' in value &&
    typeof (value as any).getProxy === 'function'
  );
}
