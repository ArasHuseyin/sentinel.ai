import { describe, it, expect } from '@jest/globals';
import { AgentMemory } from '../../agent/memory.js';
import type { StepRecord } from '../../agent/memory.js';

function makeStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    stepNumber: 1,
    instruction: 'click the button',
    action: 'click on "Button"',
    success: true,
    pageUrl: 'https://example.com',
    pageTitle: 'Example',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('AgentMemory', () => {
  it('returns "No steps taken yet." when empty', () => {
    expect(new AgentMemory().getSummary()).toBe('No steps taken yet.');
  });

  it('summarizes non-extract steps without a data line', () => {
    const m = new AgentMemory();
    m.add(makeStep({ stepNumber: 1, instruction: 'click login' }));
    const summary = m.getSummary();
    expect(summary).not.toContain(':: data=');
    expect(summary).toContain('click login');
  });

  it('includes extracted data in the summary so the planner sees prior results', () => {
    const m = new AgentMemory();
    m.add(makeStep({
      stepNumber: 1,
      instruction: 'extract selected plan',
      action: 'extract: extract selected plan',
      data: { plan: 'Pro', message: 'You selected the Pro plan.' },
    }));
    const summary = m.getSummary();
    expect(summary).toContain(':: data=');
    expect(summary).toContain('Pro');
    expect(summary).toContain('You selected the Pro plan');
  });

  it('truncates long data previews to keep the summary compact', () => {
    const m = new AgentMemory();
    const bigText = 'x'.repeat(5000);
    m.add(makeStep({
      stepNumber: 1,
      instruction: 'extract page',
      action: 'extract: extract page',
      data: { text: bigText },
    }));
    const summary = m.getSummary();
    // Preview is hard-capped at 300 chars per step; whole summary stays small.
    expect(summary.length).toBeLessThan(600);
    expect(summary).toMatch(/…$/);
  });

  it('enforces the sliding-window cap (maxSteps)', () => {
    const m = new AgentMemory(3);
    for (let i = 1; i <= 5; i++) m.add(makeStep({ stepNumber: i }));
    expect(m.getHistory()).toHaveLength(3);
    expect(m.getHistory()[0]!.stepNumber).toBe(3);
    expect(m.getHistory()[2]!.stepNumber).toBe(5);
  });
});
