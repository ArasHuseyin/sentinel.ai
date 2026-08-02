/**
 * URL glob matching for `sentinel.intercept()`.
 *
 * The previous implementation built its regex by substituting `**` and `*` for
 * sentinel placeholder strings, escaping the result, then substituting back —
 * and it did all of that once **per intercepted response**. Beyond the wasted
 * work, the round-trip was fragile: any pattern containing the placeholder text
 * would be corrupted, and the escape pass ran over already-substituted output.
 *
 * This is a single-pass converter with explicit semantics, compiled once.
 */

/** Characters that carry meaning in a RegExp and must be escaped when literal. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** True when the pattern uses any glob syntax at all. */
function hasGlobSyntax(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Converts a glob to RegExp source.
 *
 * - `**` matches any characters, including `/`
 * - `*`  matches any characters except `/`
 * - `?`  matches exactly one character except `/`
 * - everything else is literal
 */
export function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(REGEX_SPECIAL, '\\$&');
    }
  }
  return out;
}

/**
 * Compiles a URL pattern into a reusable predicate.
 *
 * Matching is unanchored — `'api/search'` matches
 * `https://x.test/v2/api/search?q=1`, which is the ergonomics the public API
 * documents. A pattern with no glob characters skips the regex entirely and
 * uses a plain substring test, so query strings and regex metacharacters in a
 * literal URL fragment can never be misread as syntax.
 */
export function compileUrlPattern(pattern: string): (url: string) => boolean {
  if (!hasGlobSyntax(pattern)) {
    return (url: string) => url.includes(pattern);
  }
  const regex = new RegExp(globToRegExpSource(pattern));
  return (url: string) => regex.test(url);
}
