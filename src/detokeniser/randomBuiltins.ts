import { format } from "date-fns";

import { Log, LogLevels, StringUtils, Utils } from "../index.js";
import type { Detokeniser } from "./detokeniser.js";
import { doRandomDate } from "./dateBuiltins.js";
import { findLeadingParenCall } from "./verbArgGrammar.js";

/**
 * The `random` built-in verb — random data generation. Not part of this package's public
 * API — only imported by `detokeniser.ts` to register it as a built-in handler.
 *
 * | Expression | Format | Example | Sample output |
 * |---|---|---|---|
 * | `digits` | count, optional (default: 1) | `<%random\|digits\|6%>` | `482910` |
 * | `letters` | count, optional (default: 1) | `<%random\|letters\|4%>` | `xKpQ` |
 * | `lowercaseletters` | count, optional (default: 1) | `<%random\|lowercaseletters\|4%>` | `xkpq` |
 * | `uppercaseletters` | count, optional (default: 1) | `<%random\|uppercaseletters\|4%>` | `XKPQ` |
 * | `alphanumerics` | count, optional (default: 1) | `<%random\|alphanumerics\|8%>` | `a3Kx92Zp` |
 * | `from(<chars>)` | count (exact), optional (default: 1) | `<%random\|from(aeiou)\|3%>` | `ioa` |
 * | `from('a','b',...)` | max total characters, optional (default: no limit) | `<%random\|from('cat','dog')\|3%>` | `cat` or `dog` |
 * | `float(min,max)` | decimal places | `<%random\|float(1.5,3.7)\|2%>` | `2.83` |
 * | `date(fromEpoch,toEpoch)` | date format | `<%random\|date(0,1700000000000)\|yyyy-MM-dd%>` | `1994-07-12` |
 *
 * `from(...)` has two distinct modes, chosen purely by whether its content opens with a
 * quote character (`'`/`"`) — see {@link parseFromQuotedStringList}'s own doc comment, and
 * `docs/design/random-from-quoted-string-lists.md`, for the full grammar, the fallback
 * behaviour when a quoted list is malformed, and why `<length>` means something different
 * (a cap, not an exact count) in that mode. The `<length>`/count is optional everywhere —
 * character-pool mode (from(<chars>)) and every named set default an omitted `<length>` to
 * `1` (a single random character), the same default every other random verb needing a count
 * now shares. Omitted in quoted-string-list mode, it instead means "pick exactly one whole
 * item, however long it is" — never an uncapped fill loop, which could hang against a pool
 * with no empty-string item.
 */

export function builtinRandom(context: Detokeniser.VerbContext): string {
  // 'random' needs at least a type and (usually) a length/format argument.
  if (StringUtils.isBlank(context.args))
    throw new Error(
      `Random token [${context.rawVerb}] needs at least 2 parts (IE. ${context.tokenStart}random${context.delimiter}type[${context.delimiter}<length>]${context.tokenEnd} etc.)`
    );
  return doRandomToken(context);
}

function doRandomToken(context: Detokeniser.VerbContext): string {
  const { args: tokenBody, delimiter, escapeChar, resolveMarkers, tokenStart, tokenEnd, rawVerb } = context;
  // The full original token, sentinel-wrapped exactly as the engine's own active boundary
  // would render it — used to show a tester the real, failing text in an error, not a bare
  // "Length was: [undefined]" that forces them to go find the token themselves.
  const rawToken = `${tokenStart}${rawVerb}${delimiter}${tokenBody}${tokenEnd}`;

  ////////////////////////////////////////////////////
  //
  // Resolves a `<%random|<verb>|<lengthOrFormat>%>` token. The verb selects one of three
  // distinct shapes: date(fromEpoch,toEpoch) → a random epoch formatted per the second
  // part; float(min,max) → a random float truncated/formatted to N decimal places; or one
  // of the character-set verbs (letters/digits/etc, or from(<chars>)) → a random string of
  // the given length built by repeatedly picking a random character from that set.

  // Deliberately NOT StringUtils.splitRemainingQuoted here: when the verb is date(...), the
  // second part is a date-fns format string, which already uses a leading `'` for its own
  // literal-text escaping (e.g. 'T'HH:mm) — quote-aware splitting would misread that as this
  // method's own quoting syntax and corrupt it. This verb also has its own nested
  // (...)-based sub-grammar (from(...), float(min,max), random(fromEpoch,toEpoch)), out of
  // scope for the same quoting pass that touched jwt/base64/diff.
  //
  // date(...)/float(...)/from(...) all carry their own (...)-bounded content, and that
  // content can legitimately contain the configured delimiter itself — most realistically
  // from('...')'s own quoted items, since a test author's chosen pool can be any string at
  // all. Splitting on the delimiter before knowing where that (...) content actually ends
  // would cut straight through it, so for these three verbs, find the real closing paren
  // first — quote-aware, so a delimiter character sitting inside a quoted item is never
  // mistaken for this verb's own separator — then decide the split from whatever, if
  // anything, comes after it. Every other verb (letters/digits/etc.) never has
  // delimiter-bearing content of its own, so the plain split is still safe for them.
  // splitRandomVerbArgs finds the real type/length boundary on marker-safe text (paren-aware,
  // so a nested token's resolved value sitting inside e.g. from(...) never corrupts where that
  // boundary actually is). Only once each piece is isolated is it safe to resolve markers in
  // it — every further parse below (paren content, quoted-list items) then operates on real
  // text, including real text that happens to have come from a nested token.
  const typeAndLengthOrFormat: string[] = splitRandomVerbArgs(tokenBody, delimiter, escapeChar).map(resolveMarkers);
  let result = "";
  let select = "";
  const verb: string = typeAndLengthOrFormat[0].toLowerCase().trim();

  if (verb.startsWith("date(")) {
    // date(fromEpoch,toEpoch) — generate a random epoch in that range, then format it
    // per the second part (or leave it as a raw epoch string if the format is "epoch").
    const randomDate = doRandomDate(verb.substring(verb.indexOf("(") + 1, verb.indexOf(")")), delimiter, tokenStart, tokenEnd);

    result = typeAndLengthOrFormat[1].toLowerCase() === "epoch" ? "" + randomDate : format(randomDate, typeAndLengthOrFormat[1]);
  } else if (verb.startsWith("float(")) {
    // float(min,max) — the second part is the number of decimal places, not a date format.
    // ToDo: the second part currently only ever means decimal places. A future version could
    // instead accept "<precision>,<decimals>" (e.g. float(4000,8000)|3,4 for 3 significant
    // digits, 4 decimal places), defaulting to today's decimal-places-only behaviour when
    // only one number is given — a non-breaking change if added.
    if (isNaN(parseInt(typeAndLengthOrFormat[1])))
      throw new Error(
        `Decimal-places part invalid in [${rawToken}]. Expect ${tokenStart}random${delimiter}float(min,max)${delimiter}<number of decimals>${tokenEnd}. Was: [${typeAndLengthOrFormat[1]}]`
      );
    const numberOfDecimalPlaces = parseInt(typeAndLengthOrFormat[1]);
    const powerDPs = Math.pow(10, numberOfDecimalPlaces);
    // Truncate (not round) to the requested number of decimal places, then format with
    // exactly that many digits — guarantees a fixed-width decimal part, not a varying one.
    result = (Math.trunc(doRandomFloat(verb.substring(verb.indexOf("(") + 1, verb.indexOf(")")), delimiter, tokenStart, tokenEnd) * powerDPs) / powerDPs).toFixed(numberOfDecimalPlaces);
  } else {
    // Character-set verbs: either a custom from(<chars>)/from('a','b') pool, or one of the
    // fixed named sets below. Exactly one of 'select' (character-pool mode) or
    // 'stringListItems' (quoted-string-list mode, from(...) only) ends up populated — the
    // length/cap logic below draws from whichever one that is.
    let stringListItems: string[] | undefined;
    if (verb.startsWith("from(")) {
      // Content right after from(...)'s own opening '(' — this is both what the
      // leading-quote check below looks at, and (in character-pool mode) what
      // parseParenContent scans.
      const fromContent = typeAndLengthOrFormat[0].slice(typeAndLengthOrFormat[0].indexOf("(") + 1);
      // A leading quote character — incidental whitespace before it is tolerated, same as
      // parseFromQuotedStringList tolerates it everywhere else in this grammar — commits to
      // quoted-string-list mode; anything else (an ordinary character, or from(...) being
      // empty) stays character-pool mode, unchanged from this verb's original behaviour.
      stringListItems = /^\s*['"]/.test(fromContent) ? parseFromQuotedStringList(fromContent, escapeChar) : undefined;
      if (stringListItems) {
        Log.writeLine(LogLevels.TestDebug, `random|from(...): parsed as quoted string list [${stringListItems.join(", ")}]`);
      } else {
        // Either the content didn't open with a quote at all, or it did but the
        // quoted-string-list grammar failed partway through (an unterminated quote, an
        // unexpected character after a closing quote, trailing text after the closing
        // paren, etc.) — either way, fall back to the original character-pool parse over
        // the whole, unmodified from(...) text, exactly as if the leading-quote check had
        // never run. See docs/design/random-from-quoted-string-lists.md for why this is a
        // silent fallback rather than a thrown error.
        select = parseParenContent(typeAndLengthOrFormat[0], escapeChar);
        Log.writeLine(LogLevels.TestDebug, `random|from(...): using character-pool mode (pool [${select}])`);
      }
    } else {
      switch (verb) {
        case "letters":
          select = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
          break;
        case "lowercaseletters":
          select = "abcdefghijklmnopqrstuvwxyz";
          break;
        case "uppercaseletters":
          select = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          break;
        case "digits":
          select = "0123456789";
          break;
        case "alphanumerics":
          select = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890";
          break;
        default:
          // Verb wasn't a recognised named set, and didn't start with "from(" either.
          throw new Error(`Unrecognised random Type [${typeAndLengthOrFormat[0]}] - Expect letters, lowercaseletters, uppercaseletters digits or alphanumerics`);
      }
    }
    // The second (length/count) part is optional everywhere now — quoted-string-list mode
    // treats an omitted length as "pick exactly one whole item"; character-pool mode
    // (from(<chars>)) and every named set (letters/digits/etc.) treat it as "pick exactly one
    // random character", the same single-character default every other random verb needing
    // a count now shares.
    const lengthArgOmitted = Utils.isUndefined(typeAndLengthOrFormat[1]);
    // When given at all, it must be a valid non-negative integer — an exact character count
    // in character-pool/named-set mode, or a maximum total character count in quoted-string-
    // list mode (see buildFromStringListResult).
    if (!lengthArgOmitted && (isNaN(parseInt(typeAndLengthOrFormat[1])) || parseInt(typeAndLengthOrFormat[1]) < 0))
      throw new Error(
        `Length part invalid in [${rawToken}]. Expect ${tokenStart}random${delimiter}<type>${delimiter}<length>${tokenEnd}. Was: [${typeAndLengthOrFormat[1]}]`
      );

    if (stringListItems) {
      // Quoted-string-list mode. A given length/cap is a maximum, not an exact count — see
      // buildFromStringListResult. Omitted entirely, it means "pick exactly one whole item,
      // however long it is" — not an uncapped fill loop, which could never terminate against
      // a pool with no empty-string item.
      result = lengthArgOmitted
        ? stringListItems[Utils.getRandomInt(0, stringListItems.length - 1)]
        : buildFromStringListResult(stringListItems, parseInt(typeAndLengthOrFormat[1]));
    } else {
      // Character-pool/named-set mode — an omitted length defaults to 1 (a single random
      // character); otherwise use the given exact count. Build the result by picking that
      // many characters from the pool, independently at random each time (so repeats within
      // the result are allowed).
      const exactLength = lengthArgOmitted ? 1 : parseInt(typeAndLengthOrFormat[1]);
      for (let count = 0; count < exactLength; count++) {
        result += select[Utils.getRandomInt(0, select.length - 1)];
      }
    }
  }
  return result;
}

/**
 * Splits `tokenBody` — the text after `random`'s own verb delimiter — into the `[type,
 * lengthOrFormat]` parts {@link doRandomToken} works with. For `date(...)`/`float(...)`/
 * `from(...)`, uses the shared {@link findLeadingParenCall} to find that call's real,
 * quote-aware-matched closing `)` first, then splits on whatever follows it — rather than on
 * the first raw occurrence of `delimiter` anywhere in `tokenBody`, which would otherwise cut
 * straight through a delimiter character sitting inside, say, a `from('a;b')` quoted item.
 * Every other verb (letters/digits/etc.) has no `(...)`-bounded, test-author-controlled
 * content of its own, so a plain delimiter split is always safe for them.
 *
 * @returns One element if `tokenBody` is a bare `date(...)`/`float(...)`/`from(...)` call
 *   with nothing trailing it. Valid for `from(...)` either way it resolves (quoted-string-list
 *   mode picks one whole item; character-pool mode defaults the omitted length to 1).
 *   `date(...)`/`float(...)` still need their own second part (a format string / decimal-places
 *   count respectively — neither is a length {@link doRandomToken} could sensibly default to
 *   1) — currently an unhandled `TypeError` reading `.toLowerCase()` of `undefined`, not a
 *   clean verb-specific error; pre-existing, not introduced by the pool-default change above,
 *   and out of scope here. Two elements otherwise: `[type, lengthOrFormat]`.
 */
function splitRandomVerbArgs(tokenBody: string, delimiter: string, escapeChar: string): string[] {
  const trimmedBody = tokenBody.trim();
  const leadingCall = findLeadingParenCall(trimmedBody, escapeChar);
  // Not a name(...)-shaped call at all (a bare verb like "digits"), or one whose parens never
  // find a matching close (unterminated) — the plain split is exactly right for the former,
  // and lands on the same "Unrecognised random Type"/"Invalid length part" errors
  // doRandomToken already throws for the latter, rather than inventing a new error here.
  if (!leadingCall) return StringUtils.splitRemaining(tokenBody, delimiter, 2);

  const { call: type, remainder } = leadingCall;
  // Nothing trails the matched call at all.
  if (remainder === "") return [type];
  // The real separator, found strictly after the matched call's own closing paren — take
  // everything past it as the length/format argument, whole, never split again (this verb
  // never takes a third argument).
  if (remainder.startsWith(delimiter)) return [type, remainder.slice(delimiter.length)];
  // Something trails the call's closing ')' that isn't the delimiter — this is never a
  // length/format argument (that case is the branch above, which only fires when the
  // delimiter genuinely comes right after the ')'), so throwing doRandomToken's generic
  // "Invalid length part" here would misname the actual problem. Thrown here, not deferred to
  // that generic check, because only this function knows the ')' really did close validly —
  // downstream only ever sees whatever ends up in the length slot, with no way to tell "a
  // length argument that happens to be invalid" apart from "this was never a length argument
  // at all."
  throw new Error(
    `Trailing content after a from(...)/float(...)/date(...) call — expected [${delimiter}] or end of token ` +
    `immediately after the closing ')', found: [${remainder}]`
  );
}

/**
 * Parses `content` — everything after `from(...)`'s own opening `(`, including its own
 * closing `)` — as a comma-separated list of quoted strings, for `random|from(...)`'s
 * quoted-string-list mode. `content` must open with `'` or `"`; the caller is expected to
 * have already checked that before calling this (see `doRandomToken`'s own `from(...)`
 * handling).
 *
 * Returns the parsed list of item values (quotes stripped, escapes resolved) on success, or
 * `undefined` on ANY parse failure — an unterminated quote, an unexpected character
 * immediately after a closing quote, or a `)` that ends an item list but isn't the very last
 * character of `content` (meaning something trails after it). `undefined` is the caller's
 * signal to fall back to the original character-pool parse instead of throwing — see
 * `docs/design/random-from-quoted-string-lists.md` for why a failure here isn't a thrown
 * error.
 *
 * Grammar (see the design doc for the full reasoning): one or more items, each `'...'` or
 * `"..."`, separated by `,`, with incidental whitespace tolerated around each comma and
 * before the first item's opening quote. Inside an item, the engine's current escape char
 * (`escapeChar`, never hardcoded — see {@link Detokeniser.EscapeChar}) escapes that item's OWN
 * quote character (e.g. `` `' `` inside a `'...'` item under the default); the opposite quote
 * character, and structural characters like `)`/`,` that would otherwise end the call or the
 * item, are all just literal content while a quote is open — e.g. `'he)llo'` is the single
 * item `he)llo`, not a truncated `he` followed by a stray `)`.
 *
 * @example parseFromQuotedStringList("'a','b')", "`") → ["a", "b"]
 * @example parseFromQuotedStringList("'he)llo')", "`") → ["he)llo"]
 * @example parseFromQuotedStringList("'he')llo')", "`") → undefined (unescaped ' inside the
 *   item closes it early; what follows — `)llo')` — is neither `,` nor a final-character `)`)
 */
function parseFromQuotedStringList(content: string, escapeChar: string): string[] | undefined {
  const items: string[] = [];
  let index = 0;

  // Repeats once per item — each iteration either appends one parsed item and loops back
  // round for the next (comma found), returns the completed list (the call's own closing
  // paren found), or gives up entirely (anything else) via the early `return undefined`s
  // below, rather than ever looping forever.
  for (;;) {
    // Skip incidental whitespace before this item's opening quote.
    while (index < content.length && /\s/.test(content[index])) index++;

    // This item must open with a quote character — anything else here (including running
    // off the end of content) means the list is malformed from this point.
    const quoteChar = content[index];
    if (quoteChar !== "'" && quoteChar !== '"') return undefined;
    index++;

    // Scan the item's own content, up to the first UNESCAPED occurrence of its own opening
    // quote character — the opposite quote character, and any other character, are just
    // literal content with no special meaning while this item's quote is open.
    let value = "";
    let closed = false;
    while (index < content.length) {
      if (content[index] === escapeChar && index + 1 < content.length) {
        // Escaped character — take the next character literally (this is how a literal
        // occurrence of this item's own quote character gets included), and skip both.
        value += content[index + 1];
        index += 2;
        continue;
      }
      if (content[index] === quoteChar) {
        // Unescaped occurrence of this item's own quote character — the item ends here.
        closed = true;
        index++;
        break;
      }
      // Ordinary character — copy it through as item content, unchanged.
      value += content[index];
      index++;
    }
    // Ran off the end of content without finding the closing quote — malformed.
    if (!closed) return undefined;
    items.push(value);

    // Skip incidental whitespace before checking what follows this item's closing quote.
    while (index < content.length && /\s/.test(content[index])) index++;

    // A comma means another item follows — loop back round to parse it.
    if (content[index] === ",") {
      index++;
      continue;
    }
    // A ')' only ends the whole list if it's the very last character of content — anything
    // trailing after it means something is wrong with the input (most often a forgotten
    // escape earlier on), not a valid end to the call.
    if (content[index] === ")" && index === content.length - 1) return items;
    // Neither a comma nor a valid closing paren — malformed.
    return undefined;
  }
}

/**
 * Builds the resolved value for `random|from(...)`'s quoted-string-list mode: repeatedly
 * appends a random item from `items`, as long as it still fits within `maxChars` total
 * characters — unlike character-pool mode's exact count, this is a cap, since a test author
 * can't know in advance how many characters a randomly-picked item is going to contribute.
 *
 * @param items - The parsed list of candidate strings (see {@link parseFromQuotedStringList}).
 * @param maxChars - The maximum total length of the result.
 * @returns A string built from zero or more whole items, never exceeding `maxChars`
 *   characters — `""` if even the shortest item in `items` can't fit (e.g. `maxChars` is
 *   `0`, or every item is longer than it).
 */
function buildFromStringListResult(items: string[], maxChars: number): string {
  let result = "";
  let remaining = maxChars;

  // One random item per iteration, stopping (rather than retrying a different item) the
  // moment a draw doesn't fit — see the design doc for why "first draw wins, success or
  // stop" was chosen over retrying other items to better fill the remaining budget.
  while (remaining > 0) {
    const candidate = items[Utils.getRandomInt(0, items.length - 1)];
    // This draw doesn't fit in what's left — stop; a smaller remaining budget on a later
    // iteration would only ever get harder to fill, never easier.
    if (candidate.length > remaining) break;
    result += candidate;
    remaining -= candidate.length;
    // An empty-string item was just appended — it can never reduce `remaining`, so without
    // this explicit stop, an unlucky (or all-empty) item list could draw it forever and
    // never terminate.
    if (candidate.length === 0) break;
  }
  return result;
}

/**
 * Extracts the content inside the first set of parentheses in `input`, respecting the
 * engine's current escape char (`` ` `` by default — passed in as `escapeChar`, never
 * hardcoded, so this stays in sync with {@link Detokeniser.EscapeChar} rather than silently
 * diverging from it). An escaped `)` (i.e. `` `) `` under the default) is treated as a literal
 * `)` and does not end the content.
 * @example parseParenContent("from(abc`))", "`") → "abc)"
 */
function parseParenContent(input: string, escapeChar: string): string {
  // No opening paren at all — nothing to extract.
  const openParen = input.indexOf("(");
  if (openParen === -1) return "";
  let result = "";
  // Start scanning right after the opening paren.
  let i = openParen + 1;
  while (i < input.length) {
    if (input[i] === escapeChar && i + 1 < input.length) {
      // Escaped character — take the character that follows the escape char literally
      // (e.g. `` `) `` → literal `)`) and skip both; it never ends the content.
      result += input[i + 1];
      i += 2;
    } else if (input[i] === ")") {
      // Unescaped closing paren — this is the real end of the content.
      break;
    } else {
      // Ordinary character — copy it through as-is.
      result += input[i];
      i++;
    }
  }
  return result;
}

/**
 * Generates a random floating-point number within an inclusive `min,max` range, for
 * `random|float(min,max)|<decimals>` tokens. Returns the raw random value — the caller
 * ({@link doRandomToken}) truncates/formats it to the requested number of decimal places.
 * @param limits - The unparsed `"min,max"` text from inside `float(...)`'s parentheses.
 * @returns A random number `n` with `min <= n <= max`.
 * @throws {Error} If `limits` isn't exactly two comma-separated numbers, or either one isn't
 *   a valid finite number.
 */
function doRandomFloat(limits: string, delimiter: string, tokenStart: string, tokenEnd: string): number {
  // Expect exactly two comma-separated numbers: "min,max".
  const minimumAndMaximum: string[] = limits.split(",");

  if (minimumAndMaximum.length != 2)
    throw new Error(`Invalid Maximum and Minimum floats. Expect ${tokenStart}random${delimiter}float(min,max)${delimiter}<decimals>${tokenEnd}. Max/min was: [${limits}]`);
  const min = parseFloat(minimumAndMaximum[0]);
  const max = parseFloat(minimumAndMaximum[1]);

  // Validate min and max separately so the error pinpoints which one is actually invalid.
  if (isNaN(min)) throw new Error(`Invalid Minimum float. Expect ${tokenStart}random${delimiter}float(min,max)${delimiter}<decimals>${tokenEnd}. Max/min was: [${limits}]`);
  if (isNaN(max)) throw new Error(`Invalid Maximum float. Expect ${tokenStart}random${delimiter}float(min,max)${delimiter}<decimals>${tokenEnd}. Max/min was: [${limits}]`);

  return Utils.getRandomFloat(min, max);
}
