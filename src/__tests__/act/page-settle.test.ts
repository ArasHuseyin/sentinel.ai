import { jest, describe, it, expect } from '@jest/globals';
import { waitForPageSettle } from '../../api/act/page-settle.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// `waitForPageSettle` has two halves: the orchestration in Node (racing the DOM
// probe against navigation, deriving the hard cap) and the callback that runs
// inside the browser. The callback is a plain function, so we can execute it
// against a minimal DOM stub instead of booting a real page — that is where the
// loading-indicator logic actually lives.

interface EvaluateCall {
  fn: (arg: any) => unknown;
  arg: any;
}

function makeMockPage(opts: { runEvaluate?: boolean; navigationResolves?: boolean } = {}) {
  const { runEvaluate = false, navigationResolves = false } = opts;
  const evaluateCalls: EvaluateCall[] = [];

  const page = {
    evaluate: jest.fn(async (fn: any, arg: any) => {
      evaluateCalls.push({ fn, arg });
      if (runEvaluate) return fn(arg);
      // Default: never settles on its own, so the navigation branch wins.
      return new Promise(() => {});
    }),
    waitForNavigation: jest.fn(async (_opts: any) => {
      if (navigationResolves) return null;
      return new Promise(() => {});
    }),
  };
  return { page, evaluateCalls };
}

/**
 * Installs a minimal `document` + `MutationObserver` in the global scope so the
 * browser-side callback can run under Node. Returns a teardown function and
 * handles for driving the simulated page.
 */
function installDomStub(options: { loadingSignal: () => boolean }) {
  const original = {
    document: (globalThis as any).document,
    MutationObserver: (globalThis as any).MutationObserver,
  };

  const observers: Array<{ callback: () => void; disconnected: boolean }> = [];

  (globalThis as any).MutationObserver = class {
    disconnected = false;
    constructor(public callback: () => void) {
      observers.push(this as any);
    }
    observe(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
  };

  (globalThis as any).document = {
    body: {},
    querySelector: (sel: string) => {
      if (!options.loadingSignal()) return null;
      // `[role="progressbar"]` is only treated as a signal when it is laid out,
      // so hand back something with a non-null offsetParent.
      if (sel.includes('progressbar')) return { offsetParent: {} };
      if (sel.includes('aria-busy')) return {};
      return null;
    },
    querySelectorAll: () => (options.loadingSignal() ? [{ offsetParent: {} }] : []),
  };

  return {
    observers,
    restore(): void {
      (globalThis as any).document = original.document;
      (globalThis as any).MutationObserver = original.MutationObserver;
    },
  };
}

/**
 * Drains the microtask queue. A settle travels through several promise hops
 * (evaluate → .catch → Promise.race → the awaited call → .then), so a single
 * `await Promise.resolve()` is not enough to observe the result.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('waitForPageSettle', () => {
  describe('orchestration', () => {
    it('resolves as soon as navigation settles, without waiting for the DOM probe', async () => {
      const { page } = makeMockPage({ navigationResolves: true });
      await expect(waitForPageSettle(page as any, 5000)).resolves.toBeUndefined();
    });

    it('caps the wait at 8 s even when a larger timeout is requested', async () => {
      const { page, evaluateCalls } = makeMockPage({ navigationResolves: true });
      await waitForPageSettle(page as any, 60_000);

      expect(evaluateCalls[0]?.arg).toEqual({ stabilityMs: 300, hardCapMs: 8000 });
      expect(page.waitForNavigation).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 8000 })
      );
    });

    it('uses the caller timeout when it is below the hard cap', async () => {
      const { page, evaluateCalls } = makeMockPage({ navigationResolves: true });
      await waitForPageSettle(page as any, 1200);

      expect(evaluateCalls[0]?.arg).toEqual({ stabilityMs: 300, hardCapMs: 1200 });
    });

    it('does not reject when the DOM probe throws (navigation destroyed the context)', async () => {
      // Evaluating during a navigation routinely rejects with "execution context
      // was destroyed". That must not surface as an action failure.
      const page = {
        evaluate: jest.fn(async () => {
          throw new Error('Execution context was destroyed');
        }),
        waitForNavigation: jest.fn(async () => null),
      };
      await expect(waitForPageSettle(page as any, 3000)).resolves.toBeUndefined();
    });

    it('does not reject when navigation times out', async () => {
      const page = {
        evaluate: jest.fn(async () => undefined),
        waitForNavigation: jest.fn(async () => {
          throw new Error('Timeout 8000ms exceeded');
        }),
      };
      await expect(waitForPageSettle(page as any, 3000)).resolves.toBeUndefined();
    });
  });

  describe('browser-side settle logic', () => {
    it('resolves after the silence window when no loading indicator is present', async () => {
      jest.useFakeTimers();
      const dom = installDomStub({ loadingSignal: () => false });
      try {
        const { page } = makeMockPage({ runEvaluate: true });
        const settled = jest.fn();
        void waitForPageSettle(page as any, 5000).then(settled);

        // Let the evaluate promise be created before advancing time.
        await flushMicrotasks();
        jest.advanceTimersByTime(300);
        await flushMicrotasks();

        expect(settled).toHaveBeenCalled();
      } finally {
        dom.restore();
        jest.useRealTimers();
      }
    });

    it('keeps waiting while a loading indicator is visible, then releases at the hard cap', async () => {
      // This is the behaviour the two-signal strategy exists for: a SPA whose
      // first paint is instant but whose real content arrives seconds later.
      // DOM silence alone must NOT be treated as settled.
      jest.useFakeTimers();
      let loading = true;
      const dom = installDomStub({ loadingSignal: () => loading });
      try {
        const { page } = makeMockPage({ runEvaluate: true });
        const settled = jest.fn();
        void waitForPageSettle(page as any, 5000).then(settled);
        await flushMicrotasks();

        // Silence window elapses, but the spinner is still up → not settled.
        jest.advanceTimersByTime(300);
        await flushMicrotasks();
        expect(settled).not.toHaveBeenCalled();

        // A mutation re-arms the timer; the spinner is gone by the time it fires.
        loading = false;
        dom.observers[0]?.callback();
        jest.advanceTimersByTime(300);
        await flushMicrotasks();

        expect(settled).toHaveBeenCalled();
      } finally {
        dom.restore();
        jest.useRealTimers();
      }
    });

    it('always releases at the hard cap even if the indicator never disappears', async () => {
      // Broken spinners and animated placeholders exist; the safety net must fire.
      jest.useFakeTimers();
      const dom = installDomStub({ loadingSignal: () => true });
      try {
        const { page } = makeMockPage({ runEvaluate: true });
        const settled = jest.fn();
        void waitForPageSettle(page as any, 2000).then(settled);
        await flushMicrotasks();

        jest.advanceTimersByTime(1999);
        await flushMicrotasks();
        expect(settled).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await flushMicrotasks();
        expect(settled).toHaveBeenCalled();
      } finally {
        dom.restore();
        jest.useRealTimers();
      }
    });

    it('disconnects the observer once settled', async () => {
      jest.useFakeTimers();
      const dom = installDomStub({ loadingSignal: () => false });
      try {
        const { page } = makeMockPage({ runEvaluate: true });
        void waitForPageSettle(page as any, 5000);
        await flushMicrotasks();
        jest.advanceTimersByTime(300);
        await flushMicrotasks();

        expect(dom.observers[0]?.disconnected).toBe(true);
      } finally {
        dom.restore();
        jest.useRealTimers();
      }
    });
  });
});
