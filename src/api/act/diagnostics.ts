import type { UIElement } from '../../core/state-parser.js';
import type { ActionAttempt } from './types.js';

export function buildFailureMessage(instruction: string, target: UIElement | null, attempts: ActionAttempt[]): string {
  const elementName = target ? `"${target.name}"` : 'the target element';
  const errors = attempts.map(a => `  • ${a.path}: ${a.error}`).join('\n');

  // Detect root cause and suggest a fix
  const allErrors = attempts.map(a => a.error.toLowerCase()).join(' ');

  let tip = '';
  if (allErrors.includes('outside viewport') || allErrors.includes('scroll')) {
    tip = `Tip: element may be outside the visible area. Try first:\n  sentinel.act('scroll to ${elementName}')`;
  } else if (allErrors.includes('timeout') || allErrors.includes('detached') || allErrors.includes('hidden')) {
    tip = `Tip: element may be covered by a modal, overlay, or popover. Dismiss overlapping elements first.`;
  } else if (
    allErrors.includes('no target') ||
    allErrors.includes('not found') ||
    allErrors.includes('could not find')
  ) {
    tip = `Tip: element "${instruction}" was not found in the DOM. It may live in a shadow DOM, iframe, or not be rendered yet.`;
  } else if (attempts.length >= 2) {
    tip = `Tip: all fallback paths exhausted. Reformulate the instruction more precisely or enable vision grounding: { visionFallback: true }.`;
  }

  const attemptSummary = attempts.length === 1 ? `Path tried: ${attempts[0]!.path}` : `${attempts.length} paths tried`;

  return [`Action failed: "${instruction}" on ${elementName}`, `${attemptSummary}:\n${errors}`, tip]
    .filter(Boolean)
    .join('\n');
}
