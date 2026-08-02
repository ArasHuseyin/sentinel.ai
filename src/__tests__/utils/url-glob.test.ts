import { describe, it, expect } from '@jest/globals';
import { compileUrlPattern, globToRegExpSource } from '../../utils/url-glob.js';

describe('globToRegExpSource', () => {
  it('escapes regex metacharacters so they match literally', () => {
    // '.' and '?' in a URL are extremely common and must not be treated as
    // regex syntax — the old converter escaped after substituting, which made
    // this order-dependent.
    expect(new RegExp(globToRegExpSource('a.b+c')).test('a.b+c')).toBe(true);
    expect(new RegExp(globToRegExpSource('a.b+c')).test('axbxc')).toBe(false);
  });

  it('translates ** to a path-crossing wildcard', () => {
    const re = new RegExp(globToRegExpSource('api/**/items'));
    expect(re.test('api/v2/nested/items')).toBe(true);
    expect(re.test('api/items')).toBe(false);
  });

  it('translates * to a wildcard that does not cross /', () => {
    const re = new RegExp(globToRegExpSource('api/*/items'));
    expect(re.test('api/v2/items')).toBe(true);
    expect(re.test('api/v2/nested/items')).toBe(false);
  });

  it('translates ? to exactly one non-slash character', () => {
    const re = new RegExp(globToRegExpSource('v?/items'));
    expect(re.test('v2/items')).toBe(true);
    expect(re.test('v/items')).toBe(false);
    expect(re.test('v22/items')).toBe(false);
  });
});

describe('compileUrlPattern', () => {
  it('matches a literal fragment anywhere in the URL', () => {
    const matches = compileUrlPattern('api/search');
    expect(matches('https://example.com/v2/api/search?q=x')).toBe(true);
    expect(matches('https://example.com/v2/api/list')).toBe(false);
  });

  it('treats a literal pattern as a substring, not as regex', () => {
    // A pattern with no glob syntax must never be compiled — otherwise a URL
    // fragment like `items(1)` would be read as a capture group.
    const matches = compileUrlPattern('items(1)');
    expect(matches('https://example.com/items(1)')).toBe(true);
    expect(matches('https://example.com/items1')).toBe(false);
  });

  it('does not misread a query string as syntax', () => {
    const matches = compileUrlPattern('graphql?op=Search');
    expect(matches('https://x.test/graphql?op=Search')).toBe(true);
  });

  it('applies glob semantics once any wildcard is present', () => {
    const matches = compileUrlPattern('*/graphql');
    expect(matches('https://x.test/v1/graphql')).toBe(true);
  });

  it('returns the same predicate result across repeated calls', () => {
    // The predicate is built once and reused for every response on the page;
    // a stateful regex (e.g. one carrying the /g flag) would alternate.
    const matches = compileUrlPattern('api/*');
    const url = 'https://x.test/api/one';
    expect([matches(url), matches(url), matches(url)]).toEqual([true, true, true]);
  });
});
