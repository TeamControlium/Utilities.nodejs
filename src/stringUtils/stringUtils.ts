import { Log, LogLevels } from "../index.js";
import { Utils } from "../utils/utils.js";

/**
 * General String related test-related utilities.
 * @note
 * Originally written as String extensions, re-written as static functions for broader compatibility.
 */
export class StringUtils {
  /**
   * Removes leading and trailing instances of given character from a string
   * @param originalString
   * String to be trimmed
   * @param characterToTrim
   * Character to be removed from start and end of string, if present
   */
  public static trimChar(originalString: string, characterToTrim: string): string {
    Utils.assertType(originalString, "string", "trimChar", "originalString");
    Utils.assertType(characterToTrim, "string", "trimChar", "characterToTrim");

    // Check we have only been given a single char to trim.  Bomb if not.
    if (characterToTrim.length !== 1) {
      Log.logErrorAndThrow(`characterToTrim (${characterToTrim}) must be a single character!`);
    }
    // characterToTrim is about to be dropped into a regex character class ([...]) — escape
    // the three characters that are special inside one (']' closes the class early, '^' at
    // the start negates it, '\' starts an escape sequence) so each is matched as a literal
    // character instead of being interpreted as regex syntax. Any other character needs no
    // escaping inside a character class, so the lookup simply falls back to it unchanged.
    const charsNeedingRegexEscape: Record<string, string> = { "]": "\\]", "^": "\\^", "\\": "\\\\" };
    const normalizedCharToTrim = charsNeedingRegexEscape[characterToTrim] ?? characterToTrim;

    // Strip any run of the (now-escaped) character from the very start and/or very end of
    // the string, leaving any occurrences in the middle untouched.
    return originalString.replace(new RegExp("^[" + normalizedCharToTrim + "]+|[" + normalizedCharToTrim + "]+$", "g"), "");
  }

  /**
   * Trims single or double quotes from string if string starts AND ends in same quote character
   * @param originalString
   * String to be trimmed
   */
  public static trimQuotes(originalString: string): string {
    Utils.assertType(originalString, "string", "trimQuotes", "originalString");

    let trimmedString = originalString;

    // Only strip the outer quotes if the string both starts AND ends with the SAME quote
    // character (either single or double) — an unmatched pair (e.g. starts with ' but ends
    // with ") is left completely untouched.
    if ((trimmedString.startsWith("'") && trimmedString.endsWith("'")) || (trimmedString.startsWith('"') && trimmedString.endsWith('"'))) {
      trimmedString = trimmedString.substring(1, trimmedString.length - 1);
    }
    return trimmedString;
  }

  /**
   * Checks if character at index is an Alpha character
   * @param stringToCheck
   * String containing character to check
   * @param indexZeroBased - default 0
   * Index of character to check
   * @returns
   * Boolean true is alpha, otherwise false
   */
  public static isAlpha(stringToCheck: string, indexZeroBased = 0) {
    Utils.assertType(stringToCheck, "string", "isAlpha", "stringToCheck");
    Utils.assertType(indexZeroBased, "number", "isAlpha", "indexZeroBased");

    // indexZeroBased must actually be within the string — fail fast and clearly if not.
    if (stringToCheck.length - 1 < indexZeroBased) {
      const errorText = `Cannot check if char [${indexZeroBased} (Zero based)] isAlpha as length of stringToCheck is only ${stringToCheck.length} characters long!`;
      Log.logErrorAndThrow(errorText);
    }
    // A character is "alpha" if upper/lower-casing it actually changes it — a non-alpha
    // character (digit, punctuation, whitespace) is unaffected by case conversion, so the two
    // forms stay equal.
    return stringToCheck.charAt(indexZeroBased).toLowerCase() !== stringToCheck.charAt(indexZeroBased).toUpperCase();
  }

  /**
   * Set first character of string to Capital (if Alpha)
   * @param originalString
   * String to set first character
   * @param searchFirstAlpha - default false
   * If true, capitalises the first ALPHA character anywhere in the string (e.g. "3abc" ->
   * "3Abc") instead of always acting on literal index 0.
   * @returns
   * originalString with first character capitalised
   */
  public static capitaliseFirstCharacter(originalString: string, searchFirstAlpha = false): string {
    Utils.assertType(originalString, "string", "capitaliseFirstCharacter", "originalString");
    Utils.assertType(searchFirstAlpha, "boolean", "capitaliseFirstCharacter", "searchFirstAlpha");

    if (searchFirstAlpha) {
      // Capitalise the FIRST alpha character anywhere in the string (not necessarily index
      // 0) — e.g. "3abc" becomes "3Abc". Split into individual characters so a single
      // character can be mutated in place.
      const asArray = originalString.split("");
      // Array.find stops at the first element for which the callback returns true — used
      // here purely for its short-circuiting, not for its return value. Mutate the first
      // alpha character to uppercase, in place, then stop; non-alpha characters before it
      // are left untouched.
      asArray.find((item, index) => {
        if (this.isAlpha(item)) {
          asArray[index] = item.toUpperCase();
          return true;
        } else {
          return false;
        }
      });
      return asArray.join("");
    } else {
      // Default case: capitalise literal index 0, regardless of whether it's alpha.
      return originalString.charAt(0).toUpperCase() + originalString.slice(1);
    }
  }

  /**
   * Splits a string upto substrings a maximum number of times using the specified separator and return then as an array
   * @param originalString
   * String to be split
   * @param separator
   * Character to use as seperator.  If more than one character, function will error.
   * @param limit
   * A value used to limit the number of elements returned in the array. Last element contains rest of string.
   */
  public static splitRemaining(originalString: string, separator: string, limit: number, doNotSeparateInQuotes = false): string[] {
    Utils.assertType(originalString, "string", "splitRemaining", "originalString");
    Utils.assertType(separator, "string", "splitRemaining", "separator");
    Utils.assertType(limit, "number", "splitRemaining", "limit");
    Utils.assertType(doNotSeparateInQuotes, "boolean", "splitRemaining", "doNotSeparateInQuotes");

    // separator must be exactly one character, and limit must be positive.
    if (separator.length === 1 && limit > 0) {
      // Split fully first (respecting quotes, if requested), then re-merge anything past the
      // (limit - 1)th part back together, re-joined with the separator — so the FIRST
      // (limit - 1) parts stay split, and everything remaining collapses into one final
      // "remainder" part.
      const allParts = StringUtils.split(originalString, separator, doNotSeparateInQuotes);
      const partsToMax = allParts.slice(0, limit - 1);
      const partsAfterMax = allParts.slice(limit - 1);
      return partsAfterMax.length > 0 ? partsToMax.concat([partsAfterMax.join(separator)]) : partsToMax;
    } else {
      const error = `Seperator [Length was ${separator.length}] must be single character and limit [Limit was ${limit}] greater than 0.`;
      Log.logErrorAndThrow(error);
    }
  }

  /**
   * Splits a string upto substrings a maximum number of times using the specified separator and return then as an array
   * @param originalString
   * String to be split
   * @param separator
   * A string that identifies character or characters to use in separating the string.
   * @param limit
   * A value used to limit the number of elements returned in the array. First element contains start of string.
   */
  public static splitLeading(originalString: string, separator: string, limit: number, doNotSeparateInQuotes = false): string[] {
    Utils.assertType(originalString, "string", "splitLeading", "originalString");
    Utils.assertType(separator, "string", "splitLeading", "separator");
    Utils.assertType(limit, "number", "splitLeading", "limit");
    Utils.assertType(doNotSeparateInQuotes, "boolean", "splitLeading", "doNotSeparateInQuotes");

    // Cap limit at the string's own length — a limit bigger than the string could ever
    // produce would otherwise skew the slice math below.
    const realLimit = limit > originalString.length ? originalString.length : limit;
    // separator must be exactly one character, and limit must be positive.
    if (separator.length === 1 && limit > 0) {
      // Split fully first (respecting quotes, if requested), then re-merge everything
      // BEFORE the last (realLimit - 1) parts back together, re-joined with the separator —
      // so the LAST (realLimit - 1) parts stay split, and everything before them collapses
      // into one leading "remainder" part (mirror image of splitRemaining, which keeps the
      // leading parts split instead).
      const allParts = StringUtils.split(originalString, separator, doNotSeparateInQuotes);
      const partsToMax = allParts.slice(0, allParts.length - realLimit + 1);
      const partsAfterMax = allParts.slice(allParts.length - realLimit + 1, allParts.length);
      return partsToMax.length > 0 ? [partsToMax.join(separator)].concat(partsAfterMax) : partsAfterMax;
    } else {
      const error = `Seperator [Length was ${separator.length}] must be single character and limit [Limit was ${limit}] greater than 0.`;
      Log.logErrorAndThrow(error);
    }
  }

  /**
   * Splits a string into parts, optionally ignoring slips with quotes
   * @param originalString
   * String to be split
   * @param separator
   * Character to use as seperator.  If more than one character, function will error.
   * @param doNotSeparateInQuotes (default true)
   * If true, separator char is ignored within single or double quotes (matching)
   * @returns
   * Array of original string
   */
  public static split(originalString: string, separator: string, doNotSeparateInQuotes = true): Array<string> {
    Utils.assertType(originalString, "string", "split", "originalString");
    Utils.assertType(separator, "string", "split", "separator");
    Utils.assertType(doNotSeparateInQuotes, "boolean", "split", "doNotSeparateInQuotes");

    // separator must be exactly one character.
    if (separator.length === 1) {
      if (doNotSeparateInQuotes) {

        ////////////////////////////////////////////////////
        //
        // Walks the string one (possibly backslash-escaped) "token" at a time, building up
        // an array of parts while tracking whether the walk is currently inside a quoted
        // span — a separator character seen while inside quotes is treated as literal text,
        // not a split point, so e.g. `a,"b,c",d` splits into `a`, `b,c`, `d`, not four parts.

        // /\\?.|^$/gs matches either a backslash followed by any character (an escape
        // sequence, kept together as one token so e.g. `\,` isn't mistaken for an
        // unescaped separator) or any single character on its own, or (for an empty
        // string) the empty match at start/end — giving one token per iteration, never
        // splitting an escape sequence across two tokens. The `s` (dotAll) flag is required
        // here: without it, `.` does not match line-terminator characters (`\n`, `\r`,
        // U+2028, U+2029), so a bare newline in the input would match neither alternative
        // and be silently dropped from the token stream entirely — corrupting the result
        // by fusing the characters either side of it together. (Bug found and fixed during
        // this readability pass — see stringUtils.spec.ts's regression test for this case.)
        const result = originalString.match(/\\?.|^$/gs)?.reduce(
          (workingObject, currentChar) => {
            // currentChar is a quote character (' or ") — toggle quote-tracking: entering
            // a quoted span if not already in one, or closing it if it matches the quote
            // character that opened it (a different quote type inside an open quote does
            // NOT close it — so "it's" stays intact under double-quote tracking).
            if (['"', "'"].includes(currentChar)) {
              if (workingObject.inQuote === "") {
                workingObject.inQuote = currentChar;
              } else if (workingObject.inQuote === currentChar) {
                workingObject.inQuote = "";
              }
            }
            // Only split on the separator when NOT currently inside a quoted span — a
            // separator inside quotes is literal text, not a delimiter.
            if (workingObject.inQuote === "" && currentChar === separator) {
              // About to close out the current part — strip any wrapping quotes from it
              // (they were only there to protect its contents from being split) before
              // starting a fresh, empty part for what comes next.
              workingObject.array[workingObject.array.length - 1] = StringUtils.trimQuotes(workingObject.array[workingObject.array.length - 1]);
              workingObject.array.push("");
            } else {
              // Not a split point — append this token to the current (last) part, undoing
              // the escaping on any backslash-escaped character (e.g. `\,` becomes `,`)
              // since the escape's only purpose was to survive this same matching pass.
              workingObject.array[workingObject.array.length - 1] += currentChar.replace(/\\(.)/, "$1");
            }
            return workingObject;
          },
          { array: [""], inQuote: "" }
        ).array ?? [originalString];
        // The very last part never went through the "closing out a part" branch above (there's
        // no trailing separator after it), so its wrapping quotes — if any — are stripped here
        // as a final step.
        result[result.length - 1] = StringUtils.trimQuotes(result[result.length - 1]);
        return result;
      } else {
        // Quote-awareness not requested — a plain native split is sufficient.
        return originalString.split(separator);
      }
    } else {
      const error = `Seperator [Length was ${separator.length}] must be single character.`;
      Log.logErrorAndThrow(error);
    }
  }

  /**
   * Splits a string upto substrings a maximum number of times using the specified separator,
   * exactly like {@link StringUtils.splitRemaining}, except each of the first `limit - 1`
   * fields may be wrapped in matching `'...'`/`"..."` quotes to protect a literal occurrence
   * of `separator` inside it — the final, absorbed field is never quote-processed, same as
   * plain `splitRemaining`.
   *
   * Quoting is purely positional and opt-in: a field is only treated as quoted if its very
   * first character is `'` or `"` — a quote character anywhere else in a field is ordinary
   * literal text, exactly as `splitRemaining` already treats it. This is what makes adopting
   * this method backwards compatible with any existing unquoted usage: nothing changes unless
   * a field is deliberately opened with a quote character.
   *
   * Literal-content rule inside a quoted field is CSV-style doubling, not backslash-escaping:
   * a doubled quote of the *same* kind the field opened with (`''` inside `'...'`, `""` inside
   * `"..."`) is a literal quote character and does not end the field; a single, undoubled
   * instance of that same kind ends it. The opposite quote kind is just literal text inside a
   * quoted field (e.g. a bare `"` inside a `'...'`-quoted field needs no special handling at
   * all). After the closing quote, any further characters up to the next unescaped separator
   * are appended onto the field as-is (POSIX-shell-style adjacency — `'abc'def` → `abcdef`),
   * rather than being treated as an error.
   *
   * @param originalString
   * String to be split
   * @param separator
   * Character to use as separator. If more than one character, function will error.
   * @param limit
   * A value used to limit the number of elements returned in the array. Last element contains
   * rest of string, unsplit and never quote-processed.
   * @returns
   * Array of up to `limit` fields, each with its wrapping quotes (if any) removed and any
   * doubled same-kind quote inside collapsed to one literal quote character.
   * @throws
   * If a field opens with a quote character but never finds its matching close before the
   * next unescaped separator or the end of the string.
   * @example
   * StringUtils.splitRemainingQuoted("a|b|c", "|", 2);                 // => ["a", "b|c"]
   * StringUtils.splitRemainingQuoted("'a|b'|c", "|", 2);               // => ["a|b", "c"]
   * StringUtils.splitRemainingQuoted(`'it''s a test'|c`, "|", 2);      // => ["it's a test", "c"]
   * StringUtils.splitRemainingQuoted("'abc'def|c", "|", 2);            // => ["abcdef", "c"]
   */
  public static splitRemainingQuoted(originalString: string, separator: string, limit: number): string[] {
    Utils.assertType(originalString, "string", "splitRemainingQuoted", "originalString");
    Utils.assertType(separator, "string", "splitRemainingQuoted", "separator");
    Utils.assertType(limit, "number", "splitRemainingQuoted", "limit");

    // separator must be exactly one character, and limit must be positive — same contract as
    // splitRemaining.
    if (separator.length !== 1 || limit <= 0) {
      const error = `Seperator [Length was ${separator.length}] must be single character and limit [Limit was ${limit}] greater than 0.`;
      Log.logErrorAndThrow(error);
    }

    // Fully split first (every field, quote-aware, no limit applied yet — mirrors how
    // splitRemaining itself builds on a full StringUtils.split before slicing), each field
    // tagged with where it started in originalString. Needed so the eventual "absorbed
    // remainder" below can be read back out of originalString verbatim: unlike
    // splitRemaining's own plain-text fields (where re-joining already-split parts with
    // `separator` losslessly reconstructs the original), re-joining already-dequoted,
    // already-doubling-collapsed fields here would NOT reconstruct the original raw text.
    const allFields = StringUtils.splitAllQuotedFields(originalString, separator);

    // Fewer fields exist than requested — nothing to absorb into a final "remainder" field,
    // same as splitRemaining's own behaviour when the input doesn't have enough separators
    // (it returns fewer than `limit` elements rather than padding with empty strings).
    if (allFields.length <= limit - 1) {
      return allFields.map((field) => field.value);
    }
    // Enough fields exist to need absorbing: the first (limit - 1) are kept as their already
    // quote-processed values; everything from where field[limit - 1] started onward is taken
    // verbatim from originalString — raw, unprocessed, exactly like splitRemaining's own
    // final field.
    const keptFields = allFields.slice(0, limit - 1).map((field) => field.value);
    const remainderStartIndex = allFields[limit - 1].startIndex;
    return keptFields.concat([originalString.substring(remainderStartIndex)]);
  }

  /**
   * Fully splits `originalString` on every occurrence of `separator`, quote-aware (see
   * {@link StringUtils.splitRemainingQuoted}'s own doc comment for the quoting/doubling/
   * adjacency rules), with no limit — the quote-aware equivalent of a full
   * {@link StringUtils.split}. Each returned field carries `startIndex`, the position in
   * originalString where that field began, so a caller needing a verbatim (not
   * quote-processed) tail can slice directly out of the original text instead of re-joining
   * already-processed field values.
   */
  private static splitAllQuotedFields(originalString: string, separator: string): Array<{ value: string; startIndex: number }> {
    const fields = new Array<{ value: string; startIndex: number }>();
    let position = 0;
    // Always read at least one field, even for an empty string — matches StringUtils.split's
    // own "" -> [""] behaviour. Keep reading only while the field just read actually ended on
    // a real separator (nextPosition within the string) rather than running off the end —
    // running off the end means there's nothing left to start a further field with, matching
    // native String.split's trailing-separator behaviour (a trailing separator DOES produce
    // one further, empty field; no trailing separator at all does not).
    let endedOnSeparator = true;
    while (endedOnSeparator) {
      const field = StringUtils.readOneQuotedField(originalString, position, separator);
      fields.push({ value: field.value, startIndex: position });
      endedOnSeparator = field.nextPosition <= originalString.length;
      position = field.nextPosition;
    }
    return fields;
  }

  /**
   * Reads one `separator`-delimited field starting at `startIndex`, for
   * {@link StringUtils.splitAllQuotedFields}/{@link StringUtils.splitRemainingQuoted} — see
   * the latter's own doc comment for the quoting/doubling/adjacency rules this implements.
   * Not quote-aware at all if the field doesn't open with a quote character: it just reads up
   * to the next unescaped separator (or the end of the string) verbatim, identical to what a
   * plain character split would produce.
   *
   * `nextPosition` in the result is always either a real index within `originalString` (a
   * separator was found and consumed — there may be a further field, even an empty one,
   * starting there) or exactly `originalString.length + 1` (no separator was found — nothing
   * left to start a further field with). That `+ 1` sentinel, not `originalString.length`
   * itself, is deliberate: it stays distinguishable from "a separator was found exactly at
   * the last character," which legitimately produces `nextPosition === originalString.length`.
   */
  private static readOneQuotedField(
    originalString: string,
    startIndex: number,
    separator: string
  ): { value: string; nextPosition: number } {
    // Field doesn't open with a quote character — the unquoted, backwards-compatible case:
    // read straight through to the next separator (or the end of the string), no special
    // handling of any quote character encountered along the way.
    if (originalString[startIndex] !== "'" && originalString[startIndex] !== '"') {
      const separatorIndex = originalString.indexOf(separator, startIndex);
      return separatorIndex === -1
        ? { value: originalString.substring(startIndex), nextPosition: originalString.length + 1 }
        : { value: originalString.substring(startIndex, separatorIndex), nextPosition: separatorIndex + 1 };
    }

    // Field opens with a quote character — scan past it, same kind, tracking for either a
    // doubled same-kind quote (literal quote char, field continues) or a single, undoubled
    // one (field's quoted portion ends here).
    const quoteChar = originalString[startIndex];
    let value = "";
    let index = startIndex + 1;
    let closed = false;
    while (index < originalString.length) {
      if (originalString[index] === quoteChar) {
        if (originalString[index + 1] === quoteChar) {
          // Doubled same-kind quote — one literal quote character, field continues.
          value += quoteChar;
          index += 2;
          continue;
        }
        // Single, undoubled quote of the same kind — the quoted portion ends here.
        closed = true;
        index += 1;
        break;
      }
      // Any other character, including the opposite quote kind, is literal content.
      value += originalString[index];
      index++;
    }
    if (!closed) {
      const error = `splitRemainingQuoted: unterminated ${quoteChar} quote starting at position ${startIndex} of [${originalString}] — expected a closing ${quoteChar} (doubled ${quoteChar}${quoteChar} for a literal quote character) before the next [${separator}] or end of string.`;
      Log.logErrorAndThrow(error);
    }
    // Past the closing quote: POSIX-shell-style adjacency — any further literal text up to
    // the next unescaped separator is appended onto the field as-is, not treated as an error.
    const separatorIndex = originalString.indexOf(separator, index);
    if (separatorIndex === -1) {
      value += originalString.substring(index);
      return { value, nextPosition: originalString.length + 1 };
    }
    value += originalString.substring(index, separatorIndex);
    return { value, nextPosition: separatorIndex + 1 };
  }

  /**
   * Splits a string into verb and paremeters.  Parameters are part enclosed in trailing brackets.
   * @param rawCommand
   * String containing command verb and, optionally, braces enclosing parameters
   * @returns
   * Object with verb and parameters properties
   * @example
   * "hello"
   * results in verb: "hello", parameters: ''
   * "hello(this is, good)"
   * results in verb: "hello", parameters: 'this is, good'
   * @throws
   * Error if badly formed (no trailing close braces etc....)
   */
  public static splitVerbAndParameters(rawCommand: string): { verb: string; parameters: string } {
    Log.writeLine(LogLevels.FrameworkDebug, `Got string [${rawCommand}]`);
    // Presence of an opening bracket at all is what decides whether this command has
    // parameters — a bare verb with no brackets is the no-parameters case, below.
    if (rawCommand.includes("(")) {
      // Has an opening bracket — it must close at the very end of the string, otherwise
      // it's malformed.
      if (rawCommand.endsWith(")")) {
        // Split on the first '(' only (limit 2) so a parameter value that itself contains
        // '(' isn't mistaken for another split point; take everything after it, then drop
        // the single trailing ')'.
        let paramsPart = StringUtils.splitRemaining(rawCommand, '(', 2)[1];
        paramsPart = paramsPart.substring(0, paramsPart.length - 1);
        Log.writeLine(LogLevels.FrameworkDebug, `Parameters are: [${paramsPart}]`);

        return {
          verb: rawCommand.split("(")[0],
          parameters: paramsPart,
        };
      } else {
        // Opening bracket exists but nothing closes it at the end — malformed input.
        const errText = `Object <${rawCommand}> has no closing brackets! If has opening brackets then must have closing brackets`;
        Log.logErrorAndThrow(errText);
      }
    } else {
      // No brackets at all — the whole string is just the verb, with no parameters.
      return {
        verb: rawCommand,
        parameters: "",
      };
    }
  }

  /**
   * Removes all non-alphanumerics from string
   * @param originalString
   * String to remove non-alphanumerics from
   */
  public static removeNonAlphaNumeric(originalString: string): string {
    Utils.assertType(originalString, "string", "removeNonAlphaNumeric", "originalString");
    // Strip every run of characters that is NOT an ASCII letter or digit — punctuation,
    // whitespace, and any non-ASCII character are all removed.
    return originalString.replace(/[^a-zA-Z0-9]+/g, "");
  }

  /**
   * Removes all whitespace from string
   * @param originalString
   * String to remove whitespace from
   */
  public static removeWhitespace(originalString: string): string {
    Utils.assertType(originalString, "string", "removeWhitespace", "originalString");
    // Strip every run of whitespace (spaces, tabs, newlines, etc.) anywhere in the string.
    return originalString.replace(/\s+/g, "");
  }

  /**
   * Encode given string to enable use within HTML
   * @param originalString
   * Non-encoded string to be HTML encoded
   * @returns
   * Original string HTML encoded.
   */
  static encodeHTML(originalString: string): string {
    Utils.assertType(originalString, "string", "encodeHTML", "originalString");
    // Replace every occurrence of any of the five HTML-significant characters with its named
    // entity, via a lookup table — the ?? "" fallback is unreachable in practice since the
    // regex only ever matches a character that's a key in the table, but keeps the lookup
    // total rather than possibly-undefined.
    return originalString.replace(
      /[&<>'"]/g,
      (tag) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      }[tag] ?? "")
    );
  }

  /**
   * Replace all matching instances with replacement
   * @param original
   * String to replace values in
   * @param searchValue
   * Value to replace
   * @param replaceValue
   * Value to replace mathes with
   * @returns
   * Original string with all matching occuranced replaced
   */
  static replaceAll(original: string, searchValue: string, replaceValue: string): string {
    // All three parameters must actually be strings — fail fast and clearly rather than
    // letting native replaceAll throw its own less-informative TypeError (or silently
    // stringify something unexpected) below. (Previously this only checked `original` for
    // null/undefined, which let a non-string, non-nullish value — e.g. a number — straight
    // through to `.replaceAll`, crashing with a generic "x.replaceAll is not a function"
    // instead of this function's own clear error; fixed during this readability pass.)
    Utils.assertType(original, "string", "replaceAll", "original");
    Utils.assertType(searchValue, "string", "replaceAll", "searchValue");
    Utils.assertType(replaceValue, "string", "replaceAll", "replaceValue");
    // Native String.prototype.replaceAll (ES2021+, safe given this package's Node >=22 floor)
    // treats searchValue as a literal, not a pattern — no manual regex/escaping needed.
    return original.replaceAll(searchValue, replaceValue);
  }

  /**
   * Checks if a string is blank
   * @param text
   * String to be verified for blank
   * @returns
   * Boolean true is empty or with blankspaces, otherwise false
   */
  static isBlank(text: string): boolean {
    // null/undefined count as blank too, so that check comes first — anything else that
    // isn't actually a string (e.g. a number) is a caller error and must be rejected
    // explicitly, rather than reaching `.trim()` and crashing with an unclear native error.
    if (Utils.isNullOrUndefined(text)) {
      return true;
    }
    Utils.assertType(text, "string", "isBlank", "text");
    return text.trim().length === 0;
  }

  /**
   * Wraps `text` so no single line exceeds `width` characters — for readability (e.g. a
   * log line), not canonical word-wrapping. Existing line breaks are preserved as-is (a
   * line already within `width` is left completely untouched); only a line that's actually
   * too long gets split, at a hard character boundary rather than a word boundary — simpler
   * and good enough for arbitrary text/binary-ish content that may have no word boundaries
   * at all.
   *
   * @param text - The text to wrap.
   * @param width - Maximum characters per line.
   * @returns `text` with every over-length line split into multiple lines.
   * @throws {Error} If `width` is not a positive integer.
   *
   * @example
   * StringUtils.wrapLines("a".repeat(10), 4); // => "aaaa\naaaa\naa"
   * StringUtils.wrapLines("short\nlines", 100); // => "short\nlines" (unchanged)
   */
  static wrapLines(text: string, width: number): string {
    Utils.assertType(text, "string", "wrapLines", "text");
    Utils.assertType(width, "number", "wrapLines", "width");
    // width must be a positive integer.
    if (!Number.isInteger(width) || width < 1) {
      const errText = `wrapLines: [width] must be a positive integer — received [${width}]`;
      Log.logErrorAndThrow(errText);
    }
    // Split on existing line breaks first, so each original line is wrapped independently
    // and a line already within width is left completely untouched.
    return text
      .split(/\r?\n/)
      .map((line) => {
        // Line already fits — nothing to do.
        if (line.length <= width) {
          return line;
        }
        // Line is too long — chop it into fixed-size chunks at hard character boundaries
        // (not word boundaries), since arbitrary text/binary-ish content may have no word
        // boundaries to break on at all.
        const chunks: string[] = [];
        for (let i = 0; i < line.length; i += width) {
          chunks.push(line.slice(i, i + width));
        }
        return chunks.join("\n");
      })
      .join("\n");
  }

  /** Single-character escapes recognised by {@link resolveLineEndingEscape} — the same set `\n`/`\r`/etc. mean in a JS string literal, just introduced by `/` instead of `\`. */
  private static readonly LINE_ENDING_SINGLE_CHAR_ESCAPES: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  };

  /**
   * Resolves a line-ending override clause (e.g. from a `(<escaped> line endings)` Gherkin
   * clause, or any other caller with the same need) into the literal separator it describes
   * — `undefined`/omitted means "no override", returning a plain `"\n"` unchanged.
   *
   * `escapeClause` uses `/` as its escape character (not `\`) — deliberately independent of
   * so this grammar never gets entangled with a different component's own escaping rules.
   * Recognises:
   * - `/n` `/r` `/t` `/b` `/f` `/v` `/0` — the standard C-family/ECMAScript single-letter
   *   escapes (LF/CR/TAB/backspace/form-feed/vertical-tab/NUL).
   * - `/#<number>;` — an arbitrary character by code point, terminated by `;` (so a literal
   *   digit can immediately follow without ambiguity — the same convention HTML's own
   *   `&#NNN;` numeric character references use). `<number>` is **decimal** by default
   *   (`/#65;` → `'A'`) — deliberately not hex, so a non-technical author never needs to
   *   understand a base other than the one they already use daily — but a `0x`/`0o`/`0b`
   *   prefix opts into hex/octal/binary (`/#0x41;`, `/#0o101;`, `/#0b1000001;`), via
   *   `Number()`'s own native prefix handling, not bespoke per-base parsing.
   * - `//` — a literal `/`.
   * - Any other character, not preceded by `/`, is literal, verbatim.
   * - Anything else after a `/` throws — never silently guessed, same rule as every other
   *   cast in this codebase (`number:`/`boolean:`/etc.).
   *
   * @param escapeClause - The raw escape text (everything between `/`-delimiters), or
   *   `undefined` for "no override".
   * @returns The literal separator the clause describes — substitute this for every `\n` in
   *   whatever text the override applies to (e.g. `text.split('\n').join(result)`).
   * @throws {Error} If `/` is followed by anything not recognised by this grammar — including
   *   nothing at all (a trailing `/`), or an unterminated `/#...` numeric escape.
   *
   * @example
   * StringUtils.resolveLineEndingEscape(undefined);     // => "\n"
   * StringUtils.resolveLineEndingEscape("/r/n");         // => "\r\n"
   * StringUtils.resolveLineEndingEscape("/#0x41;");      // => "A"
   */
  public static resolveLineEndingEscape(escapeClause: string | undefined): string {
    if (Utils.isUndefined(escapeClause)) return "\n";

    let resolved = "";
    let i = 0;
    while (i < escapeClause.length) {
      const char = escapeClause[i];
      // Not an escape sequence at all — copy the character through verbatim.
      if (char !== "/") {
        resolved += char;
        i += 1;
        continue;
      }

      const next = escapeClause[i + 1] as string | undefined;
      // "//" — a literal "/".
      if (next === "/") {
        resolved += "/";
        i += 2;
        continue;
      }
      // "/#<number>;" — an arbitrary character by code point, decimal by default, with
      // 0x/0o/0b prefixes opting into hex/octal/binary via Number()'s own parsing.
      if (next === "#") {
        const closingIndex = escapeClause.indexOf(";", i + 2);
        if (closingIndex === -1) {
          throw new Error(
            `StringUtils.resolveLineEndingEscape: [${escapeClause}] has an unterminated "/#" numeric escape at position ${i} — expected a closing ";".`
          );
        }
        const numberText = escapeClause.slice(i + 2, closingIndex);
        const codePoint = Number(numberText);
        if (numberText.length === 0 || !Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
          throw new Error(
            `StringUtils.resolveLineEndingEscape: [${escapeClause}] has "/#${numberText};", which is not a valid character code (expected a non-negative integer, decimal by default, or 0x/0o/0b-prefixed).`
          );
        }
        resolved += String.fromCodePoint(codePoint);
        i = closingIndex + 1;
        continue;
      }
      // One of the fixed single-character escapes (/n /r /t /b /f /v /0).
      if (next !== undefined && next in StringUtils.LINE_ENDING_SINGLE_CHAR_ESCAPES) {
        resolved += StringUtils.LINE_ENDING_SINGLE_CHAR_ESCAPES[next];
        i += 2;
        continue;
      }

      // Nothing above matched — an unrecognised (or entirely absent) escape, never silently
      // guessed.
      throw new Error(
        `StringUtils.resolveLineEndingEscape: [${escapeClause}] has an unrecognised escape "/${next ?? ""}" at position ${i}. Recognised: /n /r /t /b /f /v /0 /#<number>; //.`
      );
    }
    return resolved;
  }


  /**
   * Caps `text` at `maxLength` characters. When it doesn't fit, the preferred form replaces
   * the middle with a marker — keeping a prefix and the final 16 characters of the original
   * text intact (so a value's distinguishing tail, e.g. a trailing ID, is never lost to
   * truncation), with the marker itself reporting how many characters the original was. If
   * `maxLength` is too small to fit that marker plus the kept 16-character end-text, there's
   * nothing sensible to build the nice form from, so this falls back to a plain hard cut of
   * `text`'s first `maxLength` characters instead — no marker, no kept end-text, but the
   * result is still never longer than `maxLength`.
   *
   * @param text - The text to cap.
   * @param maxLength - The maximum length of the result — must be a positive integer.
   * @returns `text` unchanged if it already fits within `maxLength`; otherwise a string of
   *   exactly `maxLength` characters — the marker-based form (a prefix, the truncation
   *   marker naming the original length, and the original's final 16 characters) when
   *   `maxLength` is large enough to fit it, or a plain hard cut to `maxLength` characters
   *   when it isn't.
   * @throws {Error} If `text` isn't a string, or `maxLength` isn't a positive integer. Never
   *   throws over `maxLength` being merely *too small for the nice form* — that falls back
   *   to the plain hard cut above instead.
   *
   * @example
   * StringUtils.truncateIfNeeded("short", 100); // => "short" (unchanged — already fits)
   * StringUtils.truncateIfNeeded("x".repeat(200), 50);
   * // => "x ... (truncated as 200 too long) xxxxxxxxxxxxxxxx" (exactly 50 characters)
   * StringUtils.truncateIfNeeded("x".repeat(1000), 5);
   * // => "xxxxx" (maxLength 5 can't fit the marker, so this is a plain hard cut, not the marker form)
   */
  public static truncateIfNeeded(text: string, maxLength: number): string {
    Utils.assertType(text, "string", "truncateIfNeeded", "text");
    Utils.assertType(maxLength, "number", "truncateIfNeeded", "maxLength");
    if (!Number.isInteger(maxLength) || maxLength < 1) {
      Log.logErrorAndThrow(`truncateIfNeeded: [maxLength] must be a positive integer — received [${maxLength}]`);
    }
    const textLength = text.length;

    if (textLength <= maxLength) return text;

    const truncationText = ` ... (truncated as ${textLength} too long) `;
    const endTextLength = 16;
    const prefixLength = maxLength - truncationText.length - endTextLength;

    // prefixLength going negative means maxLength can't even fit the marker plus the kept
    // end-text, so fall back to a plain hard cut of the first maxLength characters instead.
    // (maxLength is already guaranteed >= 1 by the guard above, so there's no need to
    // special-case maxLength <= 0 here — that case already threw before reaching this line.)
    if (prefixLength < 0) {
      return text.slice(0, maxLength);
    }

    // Result is always exactly maxLength characters: prefixLength + truncationText.length + endTextLength === maxLength.
    return `${text.slice(0, prefixLength)}${truncationText}${text.slice(textLength - endTextLength)}`;
  }

  /**
   * Named escape for a control character with a familiar, commonly-recognised one — used by
   * {@link cleanControlChars}'s `'escape'` mode. Every other C0 control character (and
   * `DEL`) falls back to a `\xNN` hex escape instead (see that method's own doc comment for
   * why two hex digits always suffice).
   */
  private static readonly NAMED_CONTROL_CHAR_ESCAPES: Record<string, string> = {
    "\0": "\\0",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
  };

  /**
   * Handles every control character in `text` — the C0 set (`0x00`–`0x1F`) plus `DEL`
   * (`0x7F`); this deliberately does **not** also cover the C1 range (`0x80`–`0x9F`), which
   * is non-printing but not traditionally called a "control character" the way C0/DEL are —
   * per `mode`:
   * - `'escape'` — replaces each with a visible escape sequence: a familiar named one
   *   (`\r`, `\n`, `\t`, `\0`, `\b`, `\f`, `\v`) where one exists, otherwise `\xNN` (e.g.
   *   `\x01`). Every C0/DEL code point fits in a single byte, so the hex form is always
   *   exactly two digits — never `\xNNNN`, there's nothing in this range that needs more.
   * - `'hex'` — replaces each with its literal hex value, `0xNN` (e.g. a CR becomes the
   *   4-character text `0x0D`) — not a backslash escape sequence, a literal hex notation,
   *   for a caller that wants the value named explicitly (e.g. in a log line) rather than
   *   rendered as something a string-literal parser could read back.
   * - `'strip'` — removes each one outright, replacing it with nothing.
   *
   * Only control characters are ever touched — every other character in `text`, however
   * unusual, passes through completely unchanged.
   *
   * @param text - The text to sanitise.
   * @param mode - `'escape'` / `'hex'` / `'strip'` — see above. Defaults to `'escape'`.
   * @returns `text` with every control character replaced per `mode`. Unchanged if `text`
   *   contains no control characters at all.
   * @throws {Error} If `text` is not a string, or `mode` is not one of the three recognised
   *   values.
   *
   * @example
   * StringUtils.cleanControlChars("a\r\nb");            // => "a\\r\\nb" (default: "escape")
   * StringUtils.cleanControlChars("a\x01b", "escape");  // => "a\\x01b"
   * StringUtils.cleanControlChars("a\r\nb", "hex");     // => "a0x0D0x0Ab"
   * StringUtils.cleanControlChars("a\r\nb", "strip");   // => "ab"
   */
  static cleanControlChars(text: string, mode: "escape" | "hex" | "strip" = "escape"): string {
    Utils.assertType(text, "string", "cleanControlChars", "text");
    if (mode !== "escape" && mode !== "hex" && mode !== "strip") {
      Log.logErrorAndThrow(`cleanControlChars: [mode] must be 'escape', 'hex' or 'strip' — received [${Utils.describeValue(mode)}]`);
    }
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x1F\x7F]/g, (char) => {
      if (mode === "strip") return "";
      const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      if (mode === "hex") return `0x${hex}`;
      return this.NAMED_CONTROL_CHAR_ESCAPES[char] ?? `\\x${hex}`;
    });
  }

}
