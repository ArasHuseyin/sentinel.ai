import { createLogger, type Logger } from './logger.js';

const BASE_DELAY_MS = 1000;
/** Upper bound so a Retry-After of "3600" cannot park the agent for an hour. */
const MAX_DELAY_MS = 30_000;

/**
 * Reads a server-supplied `Retry-After` and returns it in milliseconds.
 *
 * The header comes in two shapes (RFC 9110): delta-seconds, or an HTTP-date.
 * Provider SDKs surface it in several places depending on how they wrap the
 * response, so all the common ones are probed. Returns null when absent or
 * unparseable — the caller then falls back to exponential backoff.
 */
export function parseRetryAfter(err: unknown, now = Date.now()): number | null {
  const e = err as {
    headers?: Record<string, unknown> | { get?: (k: string) => string | null };
    response?: { headers?: Record<string, unknown> | { get?: (k: string) => string | null } };
    retryAfter?: unknown;
  };

  const readHeader = (h: unknown): string | null => {
    if (!h) return null;
    // fetch/undici Headers expose get(); plain objects are indexed directly.
    const getter = (h as { get?: (k: string) => string | null }).get;
    if (typeof getter === 'function') return getter.call(h, 'retry-after');
    const rec = h as Record<string, unknown>;
    const raw = rec['retry-after'] ?? rec['Retry-After'];
    return typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
  };

  const raw =
    readHeader(e?.headers) ??
    readHeader(e?.response?.headers) ??
    (typeof e?.retryAfter === 'number' || typeof e?.retryAfter === 'string'
      ? String(e.retryAfter)
      : null);
  if (raw === null) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    // A non-positive value means "retry now"; treat it as no hint rather than
    // as a zero delay, so we still space out the attempt.
    return seconds > 0 ? Math.min(seconds * 1000, MAX_DELAY_MS) : null;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta > 0 ? Math.min(delta, MAX_DELAY_MS) : null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 3,
  /** Optional sink for retry diagnostics. Falls back to a console logger. */
  logger?: Logger
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRetryable =
        err?.status === 429 ||
        err?.status === 503 ||
        (err?.status >= 500 && err?.status < 600) ||
        err?.message?.includes('fetch failed') ||
        err?.message?.includes('ECONNRESET') ||
        err?.message?.includes('ECONNREFUSED') ||
        err?.message?.includes('rate limit') ||
        err?.message?.includes('overloaded') ||
        err?.message?.includes('timeout');
      if (!isRetryable || attempt === retries - 1) throw err;

      // Honour the server's own pacing hint when it sends one; otherwise back
      // off exponentially. Either way add full jitter (AWS "Exponential Backoff
      // and Jitter"): without it, every worker started by Sentinel.parallel()
      // hits the same 429 at the same moment and then retries in lockstep,
      // reproducing the burst that caused the rate limit in the first place.
      const hinted = parseRetryAfter(err);
      const ceiling = hinted ?? Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
      const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));

      // Surface the actual failure cause so rate-limit vs network vs server
      // overload are distinguishable from the log alone. Strip noise: the full
      // Gemini/OpenAI error messages can span multiple lines; keep the first
      // line + status code.
      const status = err?.status ? ` [${err.status}]` : '';
      const reason =
        String(err?.message ?? err)
          .split('\n')[0]
          ?.slice(0, 160) ?? 'unknown';
      (logger ?? createLogger(false, 1))
        .child(label)
        .warn(
          `Retryable error${status} (attempt ${attempt + 1}/${retries}): ${reason}. ` +
            `Retrying in ${delay}ms${hinted !== null ? ' (Retry-After)' : ''}...`
        );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Logically unreachable (the loop always throws on the last attempt),
  // but TypeScript needs this line for return-type analysis.
  throw lastError;
}
