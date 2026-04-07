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
      console.warn(`[${label}] Retryable error (attempt ${attempt + 1}/${retries}). Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Logisch unerreichbar (Schleife wirft immer beim letzten Versuch),
  // aber TypeScript benötigt diese Zeile für die Rückgabetyp-Analyse.
  throw lastError;
}
