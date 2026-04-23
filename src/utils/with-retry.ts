const BASE_DELAY_MS = 1000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 3
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
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      // Surface the actual failure cause so rate-limit vs network vs server
      // overload are distinguishable from the log alone. Strip noise: the full
      // Gemini/OpenAI error messages can span multiple lines; keep the first
      // line + status code.
      const status = err?.status ? ` [${err.status}]` : '';
      const reason = String(err?.message ?? err).split('\n')[0]?.slice(0, 160) ?? 'unknown';
      console.warn(`[${label}] Retryable error${status} (attempt ${attempt + 1}/${retries}): ${reason}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Logically unreachable (the loop always throws on the last attempt),
  // but TypeScript needs this line for return-type analysis.
  throw lastError;
}
