/**
 * Races a promise against a hard timeout.
 * Throws an error if the promise does not resolve within `ms` milliseconds.
 * Used to guard Playwright mouse/keyboard calls that have no native timeout.
 *
 * The timer is always cleared once the race settles. Without that, every call
 * left a pending `setTimeout` behind — `Promise.race` abandons the loser but
 * does not cancel it — so each guarded action (i.e. every mouse/keyboard call)
 * kept Node's event loop alive for the full timeout window after the work was
 * already done. Jest surfaced it as "a worker process has failed to exit
 * gracefully"; in a CLI run it shows up as the process lingering at the end.
 */
export function withTimeout<T>(promise: Promise<T>, ms = 10_000, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    // Belt and braces: even if something bypasses the finally below, an unref'd
    // timer cannot by itself hold the process open.
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
