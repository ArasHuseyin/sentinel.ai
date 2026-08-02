import { describe, it, expect } from '@jest/globals';
import { interpolateVariables, redactVariables, containsSecret } from '../../api/act/secrets.js';

const vars = { username: 'alice@example.com', password: 'hunter2-correct-horse' };

describe('interpolateVariables', () => {
  it('replaces placeholders with their values', () => {
    expect(interpolateVariables('type %password% into the field', vars)).toBe(
      'type hunter2-correct-horse into the field'
    );
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolateVariables('fill %missing%', vars)).toBe('fill %missing%');
  });

  it('returns the input unchanged when no variables are supplied', () => {
    expect(interpolateVariables('fill %password%')).toBe('fill %password%');
  });
});

describe('redactVariables', () => {
  it('turns an exact value back into its placeholder', () => {
    expect(redactVariables('hunter2-correct-horse', vars)).toBe('%password%');
  });

  it('redacts a value embedded in a larger string', () => {
    expect(redactVariables('user alice@example.com logged in', vars)).toBe(
      'user %username% logged in'
    );
  });

  it('round-trips with interpolateVariables', () => {
    const template = 'fill %username% and %password%';
    const resolved = interpolateVariables(template, vars);
    expect(redactVariables(resolved, vars)).toBe(template);
  });

  it('does not mangle text when a variable value is very short', () => {
    // Substring-redacting a one-character value would rewrite ordinary prose.
    // The exact-match pass still covers the case where the whole field is it.
    const shortVars = { pin: 'a' };
    expect(redactVariables('click the cart', shortVars)).toBe('click the cart');
    expect(redactVariables('a', shortVars)).toBe('%pin%');
  });

  it('redacts the longer value first when one contains the other', () => {
    const nested = { part: 'secret', whole: 'secret-token-9' };
    expect(redactVariables('secret-token-9', nested)).toBe('%whole%');
  });

  it('returns the input unchanged when no variables are supplied', () => {
    expect(redactVariables('hunter2-correct-horse')).toBe('hunter2-correct-horse');
  });
});

describe('containsSecret', () => {
  it('detects a raw value that survived redaction', () => {
    expect(containsSecret('hunter2-correct-horse', vars)).toBe(true);
  });

  it('is false for fully redacted text', () => {
    expect(containsSecret('%password%', vars)).toBe(false);
  });

  it('ignores empty variable values', () => {
    // Every string contains '', so an empty value must not flag everything.
    expect(containsSecret('anything at all', { blank: '' })).toBe(false);
  });
});
