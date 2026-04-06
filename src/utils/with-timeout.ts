/**
 * Races a promise against a hard timeout.
 * Throws an error if the promise does not resolve within `ms` milliseconds.
 * Used to guard Playwright mouse/keyboard calls that have no native timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = 10_000,
  label = 'operation'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
        ms
      )
    ),
  ]);
}
