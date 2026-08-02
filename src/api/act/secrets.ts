/**
 * Variable interpolation and its inverse.
 *
 * `act('fill the password field with %password%', { variables: { password } })`
 * resolves placeholders before the action runs, because the LLM and the DOM both
 * need the real value.
 *
 * The *caches* must not see it. Both the locator cache and the pattern cache
 * persist to JSON on disk when configured with a path, and they used to key on
 * the resolved instruction and store the resolved fill value — so a single login
 * run left the password in a plaintext file that outlived the process. Keying on
 * the template instead costs nothing (the template is what identifies the
 * element; the secret is incidental) and makes the entry reusable across
 * different credentials for the same flow.
 *
 * The rule this module enforces: interpolate on the way *in* to the browser,
 * redact on the way *in* to a cache, interpolate again on the way *out* of one.
 */

/** Placeholder syntax shared by both directions: `%name%`. */
const PLACEHOLDER = /%(\w+)%/g;

/**
 * Shortest variable value that may be substring-matched during redaction.
 *
 * Redacting a one- or two-character value everywhere it appears would mangle
 * ordinary text ("a" → "%x%"). Values that short are not credentials in
 * practice, and the exact-match pass below still catches them when the whole
 * field consists of one.
 */
const MIN_SUBSTRING_REDACT_LENGTH = 4;

/** Replaces `%name%` placeholders with their values. Unknown names stay as-is. */
export function interpolateVariables(text: string, variables?: Record<string, string>): string {
  if (!variables) return text;
  return text.replace(PLACEHOLDER, (_, key: string) => variables[key] ?? `%${key}%`);
}

/**
 * Inverse of `interpolateVariables`: replaces variable *values* with their
 * `%name%` placeholders so the result is safe to persist.
 *
 * Exact matches are handled first (the overwhelmingly common case — the field
 * value simply is the variable), then longer values are replaced wherever they
 * occur inside a larger string.
 *
 * Returns the input unchanged when there are no variables, so callers can apply
 * it unconditionally.
 */
export function redactVariables(text: string, variables?: Record<string, string>): string {
  if (!variables) return text;

  for (const [name, value] of Object.entries(variables)) {
    if (value === text) return `%${name}%`;
  }

  let out = text;
  // Longest values first: if one variable's value contains another's, redacting
  // the longer one first prevents a partial replacement from hiding the rest.
  const entries = Object.entries(variables)
    .filter(([, value]) => value.length >= MIN_SUBSTRING_REDACT_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [name, value] of entries) {
    out = out.split(value).join(`%${name}%`);
  }
  return out;
}

/**
 * True when the text still contains a raw variable value.
 *
 * Used as a last-resort assertion before a cache write: if redaction somehow
 * missed something, the caller drops the field rather than persisting it.
 */
export function containsSecret(text: string, variables?: Record<string, string>): boolean {
  if (!variables) return false;
  return Object.values(variables).some(value => value.length > 0 && text.includes(value));
}
