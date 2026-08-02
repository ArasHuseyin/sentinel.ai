import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import type {
  ParallelOptions,
  ParallelResult,
  ParallelTask,
  SentinelOptions,
} from '../types/sentinel-options.js';

/**
 * Minimal contract the runner needs from a session. Declared structurally so
 * this module does not import `Sentinel` — that would be a cycle, since
 * `Sentinel.parallel` calls into here.
 */
export interface ParallelSession {
  goto(url: string): Promise<void>;
  run(
    goal: string,
    options?: { maxSteps?: number }
  ): Promise<{
    goalAchieved: boolean;
    success: boolean;
    totalSteps: number;
    message: string;
    data?: unknown;
  }>;
  close(): Promise<void>;
}

export type SessionFactory<S extends ParallelSession> = (opts: SentinelOptions) => Promise<S>;

/** Default concurrency — enough to be worth parallelising, low enough not to trip rate limits. */
const DEFAULT_CONCURRENCY = 3;

/**
 * Derives per-task options from the shared set.
 *
 * Only `costAuditPath` is rewritten, into `costs.json` → `costs.0.json`,
 * `costs.1.json`, … Every session builds its own `TokenTracker`, and
 * `TokenTracker.flush()` rewrites the *entire* file after each LLM call — so N
 * workers pointed at one path simply overwrite each other and the surviving
 * file holds whatever the last writer happened to have, under-reporting spend by
 * roughly a factor of `concurrency`.
 *
 * The caches (`locatorCache`, `promptCache`, `patternCache`) deliberately keep
 * sharing their path: their writes are atomic, and a lost entry costs one LLM
 * call rather than corrupting a record the caller relies on.
 */
export function perTaskOptions(
  options: SentinelOptions & ParallelOptions,
  index: number
): SentinelOptions {
  if (!options.costAuditPath) return options;
  const ext = path.extname(options.costAuditPath);
  const stem = ext ? options.costAuditPath.slice(0, -ext.length) : options.costAuditPath;
  return { ...options, costAuditPath: `${stem}.${index}${ext}` };
}

/**
 * Worker-pool runner behind `Sentinel.parallel()`.
 *
 * At most `concurrency` sessions exist at once; each worker drains a shared
 * queue, so a slow task delays only itself rather than a whole batch. Results
 * are written by index, so the returned array matches the input order no matter
 * what order things finished in.
 *
 * A task never throws: a failure is recorded as a failed `ParallelResult` and
 * the remaining tasks continue. A caller running twenty scrapes wants nineteen
 * results and one error, not one error.
 */
export async function runParallelTasks<S extends ParallelSession>(
  tasks: ParallelTask[],
  options: SentinelOptions & ParallelOptions,
  factory: SessionFactory<S>
): Promise<ParallelResult[]> {
  if (tasks.length === 0) return [];

  // ── Monetisation hook ──────────────────────────────────────────────────────
  // Clamp concurrency to the tier limit here. Example:
  //   const tierLimit = getTierLimit(options.apiKey);  // Free=1, Pro=5, Enterprise=∞
  //   const concurrency = Math.min(options.concurrency ?? 3, tierLimit);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const results: ParallelResult[] = new Array(tasks.length);
  let completed = 0;

  // Shared mutable queue — each worker pops tasks until empty.
  const queue = tasks.map((task, index) => ({ task, index }));

  const runOne = async (task: ParallelTask, index: number): Promise<void> => {
    let session: S | null = null;
    try {
      session = await factory(perTaskOptions(options, index));
      await session.goto(task.url);
      const result = await session.run(task.goal, { maxSteps: task.maxSteps ?? 15 });
      results[index] = {
        index,
        url: task.url,
        goal: task.goal,
        goalAchieved: result.goalAchieved,
        success: result.success,
        totalSteps: result.totalSteps,
        message: result.message,
        ...(result.data !== undefined ? { data: result.data } : {}),
      };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      results[index] = {
        index,
        url: task.url,
        goal: task.goal,
        goalAchieved: false,
        success: false,
        totalSteps: 0,
        message: msg,
        error: msg,
      };
    } finally {
      if (session) {
        try {
          await session.close();
        } catch (closeErr: any) {
          // Don't let a close failure propagate — the other tasks should finish
          // and the caller should still see this task's result. But surface it,
          // so zombie browsers don't accumulate unnoticed.
          createLogger(options.logFormat ?? false, options.verbose ?? 1, options.logger)
            .child('Sentinel.parallel')
            .warn(
              `close() failed for task ${index} (${task.url}): ${closeErr?.message ?? closeErr}`
            );
        }
      }
      completed++;
      options.onProgress?.(completed, tasks.length, results[index]!);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) break;
      await runOne(item.task, item.index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  return results;
}
