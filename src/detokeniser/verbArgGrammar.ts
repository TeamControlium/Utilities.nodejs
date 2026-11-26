/**
 * Shared argument-parsing primitives for built-in (and custom `addCallback`) verb handlers —
 * not part of this package's public API, not barrel-exported, only imported by sibling
 * ("principle 2") for why this exists: a verb whose own argument text can contain a
 * `name(...)`-shaped sub-call — `random|from(...)`/`float(...)`/`date(...)`, `date`'s own
 * `addDays(...)`/`random(...)`/`followingDay(...)` — must find that call's real, quote-aware
 * closing `)` before splitting on the delimiter at all, or a delimiter character sitting
 * inside a quoted argument the call's own grammar allows (most realistically a test author's
 * own chosen string in `from('...')`) gets mistaken for the verb's own separator. Written once
 * here so every verb with this shape inherits the fix, rather than each re-deriving it — the
 * exact bug this file closes off was found, fixed, and initially left verb-specific in
 * `randomBuiltins.ts` before being promoted here; see that design doc for the full history.
 */

/**
 * Finds the index of the `)` that closes the `(` at `openParenIndex` in `text`, skipping past
 * anything that isn't actually closing the call: an escaped close (e.g. `` `) `` under the
 * engine's default escape char, passed in as `escapeChar` — never hardcoded, so this stays in
 * sync with {@link Detokeniser.EscapeChar} rather than silently diverging from it), and any
 * character — including a literal `)` or a delimiter character — sitting inside a
 * `'...'`/`"..."` quoted span. Quote awareness matters because a call's own quoted-argument
 * content (e.g. `from('a)','b)')`'s items) can legitimately contain `)`, the delimiter, or
 * anything else inside an item.
 * @returns The index of the matching `)`, or `-1` if `text` runs out first — an unclosed `(`,
 *   or an unclosed quote inside it.
 */
export function findMatchingParenClose(text: string, openParenIndex: number, escapeChar: string): number {
  let openQuoteChar: string | undefined;
  let index = openParenIndex + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === escapeChar && index + 1 < text.length) {
      // Escaped character — skip both; never structurally significant, inside or outside a
      // quoted span.
      index += 2;
      continue;
    }
    if (openQuoteChar) {
      // Inside a quoted span — only that same quote character, unescaped, closes it;
      // nothing else here (a ')', the delimiter, anything) has any structural meaning.
      if (char === openQuoteChar) openQuoteChar = undefined;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      // Opens a quoted span.
      openQuoteChar = char;
      index++;
      continue;
    }
    if (char === ")") return index;
    index++;
  }
  // Ran off the end of text without finding an unescaped, unquoted ')'.
  return -1;
}

/**
 * Finds a leading `name(...)`-shaped call at the very start of `tokenBody` — a run of
 * letters/digits immediately followed by `(`, with its content quote-aware-matched to the
 * real closing `)` via {@link findMatchingParenClose} — generic to *any* call name, not a
 * fixed list, since the shape (not the specific verb) is what makes delimiter-in-content
 * corruption possible. A bare verb with no parens at all (e.g. `today`, `digits`) correctly
 * never matches this at all, falling through to whatever plain split the caller already uses
 * for that case.
 *
 * @returns `undefined` if `tokenBody` doesn't open with that shape (no leading `identifier(`
 *   at all), or if the parens never find a matching close (unterminated — an unclosed `(` or
 *   an unclosed quote inside it) — both cases the caller's own existing fallback split already
 *   handles correctly, so this deliberately doesn't invent a new error for either. Otherwise,
 *   `call` is the matched `name(...)` text in full (including its own closing `)`); `remainder`
 *   is everything after that `)`, unsplit — the caller decides how to split what remains,
 *   since different verbs shape it differently (`random`'s is `[type, length]`; `date`'s own
 *   top-level split has a 3rd, optional zone part on top).
 */
export function findLeadingParenCall(tokenBody: string, escapeChar: string): { call: string; remainder: string } | undefined {
  const leadingCallMatch = /^[A-Za-z][A-Za-z0-9]*\(/.exec(tokenBody);
  if (!leadingCallMatch) return undefined;
  const closeParenIndex = findMatchingParenClose(tokenBody, leadingCallMatch[0].length - 1, escapeChar);
  if (closeParenIndex === -1) return undefined;
  return { call: tokenBody.slice(0, closeParenIndex + 1), remainder: tokenBody.slice(closeParenIndex + 1) };
}
