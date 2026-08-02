import { Sentinel } from '../index.js';
import type { SentinelOptions } from '../index.js';
import { ignoreRejection } from '../utils/ignore-rejection.js';

/** Runs `fn` with exclusive access to the shared browser session. */
export type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

export interface SessionManager {
  /** Returns the shared session, initialising it at most once. */
  getOrInit(): Promise<Sentinel>;
  /** Closes the session if one is open. Safe to call repeatedly. */
  cleanup(): Promise<void>;
  /** Serialises access to the shared browser. */
  runExclusive: RunExclusive;
}

/**
 * Owns the single browser session an MCP server drives.
 *
 * Two concurrency bugs live here, both invisible over stdio (one client, one
 * request at a time) and both reachable over HTTP:
 *
 * 1. **Init race.** `if (session) return session` followed by an `await` is not
 *    atomic. Two requests arriving before the first `init()` resolved each saw
 *    `null`, each launched a browser, and the loser was overwritten — leaking a
 *    Chromium process that nothing would ever close.
 *
 * 2. **Interleaved tool calls.** All requests share one browser, so a `goto`
 *    from client B could land between client A's `act` and the `extract` reading
 *    its result. Serialising tool execution makes each call see the page the
 *    previous one left behind.
 *
 * Serialising is the honest fix for a single shared browser: it makes the
 * server slow under concurrent load rather than wrong. A per-client session
 * pool would be faster and is the natural next step, but it changes the tool
 * contract (every call needs a session id), so it is deliberately not smuggled
 * in here.
 */
export function createSessionManager(buildOptions: () => SentinelOptions): SessionManager {
  let session: Sentinel | null = null;
  let initInFlight: Promise<Sentinel> | null = null;
  // Tail of the execution queue. Each new task chains onto it, so tasks run in
  // arrival order and a failing task does not poison the ones behind it.
  let queue: Promise<unknown> = Promise.resolve();

  const getOrInit = async (): Promise<Sentinel> => {
    if (session) return session;
    if (!initInFlight) {
      initInFlight = (async () => {
        const created = new Sentinel(buildOptions());
        await created.init();
        session = created;
        return created;
      })().catch((err: unknown) => {
        // Clear the latch so a later call can retry; otherwise one transient
        // launch failure would make the server permanently unusable.
        initInFlight = null;
        throw err;
      });
    }
    return initInFlight;
  };

  const cleanup = async (): Promise<void> => {
    initInFlight = null;
    if (!session) return;
    const closing = session;
    session = null;
    await closing.close().catch(ignoreRejection);
  };

  const runExclusive: RunExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    // `.then(fn, fn)` runs the task whether the predecessor resolved or
    // rejected — the queue is a lock, not a dependency chain.
    const result = queue.then(fn, fn);
    queue = result.catch(ignoreRejection);
    return result;
  };

  return { getOrInit, cleanup, runExclusive };
}
