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
      const error = `characterToTrim (${characterToTrim}) must be a single character!`;
      Log.writeLine(LogLevels.Error, ` ${error}`);
      throw new Error(error);
    }
    // characterToTrim is about to be dropped into a regex character class ([...]) — escape
    // the three characters that are special inside one (']' closes the class early, '^' at
    // the start negates it, '\' starts an escape sequence) so each is matched as a literal
    // character instead of being interpreted as regex syntax.
    let normalizedCharToTrim = characterToTrim === "]" ? "\\]" : characterToTrim;
    normalizedCharToTrim = normalizedCharToTrim === "^" ? "\\^" : normalizedCharToTrim;
    normalizedCharToTrim = normalizedCharToTrim === "\\" ? "\\\\" : normalizedCharToTrim;

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
   * @returns
   * originalString with first character capitalised
   */
  public static capitaliseFirstCharacter(originalString: string, searchFirstAlpha = false): string {
    Utils.assertType(originalString, "string", "capitaliseFirstCharacter", "originalString");

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
  public static splitRemaining(originalString: string, separator: string, limit: number,doNotSeparateInQuotes = false): string[] {
    Utils.assertType(originalString, "string", "splitRemaining", "originalString");
    Utils.assertType(separator, "string", "splitRemaining", "separator");
    Utils.assertType(limit, "number", "splitRemaining", "limit");

    // separator must be exactly one character, and limit must be positive.
    if (separator.length === 1 && limit > 0) {
      // Split fully first (respecting quotes, if requested), then re-merge anything past the
      // (limit - 1)th part back together, re-joined with the separator — so the FIRST
      // (limit - 1) parts stay split, and everything remaining collapses into one final
      // "remainder" part.
      const allParts = StringUtils.split(originalString,separator,doNotSeparateInQuotes);
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
  public static splitLeading(originalString: string, separator: string, limit: number,doNotSeparateInQuotes = false): string[] {
    Utils.assertType(originalString, "string", "splitLeading", "originalString");
    Utils.assertType(separator, "string", "splitLeading", "separator");
    Utils.assertType(limit, "number", "splitLeading", "limit");

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
      const allParts = StringUtils.split(originalString,separator,doNotSeparateInQuotes);
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
  public static split(originalString: string, separator: string, doNotSeparateInQuotes = true):Array<string> {
    Utils.assertType(originalString, "string", "split", "originalString");
    Utils.assertType(separator, "string", "split", "separator");

    // separator must be exactly one character.
    if (separator.length === 1) {
      if (doNotSeparateInQuotes) {

        ////////////////////////////////////////////////////
        //
        // Walks the string one (possibly backslash-escaped) "token" at a time, building up
        // an array of parts while tracking whether the walk is currently inside a quoted
        // span — a separator character seen while inside quotes is treated as literal text,
        // not a split point, so e.g. `a,"b,c",d` splits into `a`, `b,c`, `d`, not four parts.

        // /\\?.|^$/g matches either a backslash followed by any character (an escape
        // sequence, kept together as one token so e.g. `\,` isn't mistaken for an
        // unescaped separator) or any single character on its own, or (for an empty
        // string) the empty match at start/end — giving one token per iteration, never
        // splitting an escape sequence across two tokens.
        const result = originalString.match(/\\?.|^$/g)?.reduce(
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
        ).array??[originalString];
        // The very last part never went through the "closing out a part" branch above (there's
        // no trailing separator after it), so its wrapping quotes — if any — are stripped here
        // as a final step.
        result[result.length - 1] = StringUtils.trimQuotes(result[result.length - 1])
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
    Log.writeLine(LogLevels.FrameworkDebug,`Got string [${rawCommand}]`);
    // Presence of an opening bracket at all is what decides whether this command has
    // parameters — a bare verb with no brackets is the no-parameters case, below.
    if (rawCommand.includes("(")) {
      // Has an opening bracket — it must close at the very end of the string, otherwise
      // it's malformed.
      if (rawCommand.endsWith(")")) {
        // Split on the first '(' only (limit 2) so a parameter value that itself contains
        // '(' isn't mistaken for another split point; take everything after it, then drop
        // the single trailing ')'.
        let paramsPart = StringUtils.splitRemaining(rawCommand,'(',2)[1];
        paramsPart = paramsPart.substring(0, paramsPart.length - 1);
        Log.writeLine(LogLevels.FrameworkDebug,`Parameters are: [${paramsPart}]`);

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
    return originalString.replace(/[^a-zA-Z0-9]+/g, "");
  }

  /**
   * Removes all whitespace from string
   * @param originalString
   * String to remove whitespace from
   */
  public static removeWhitespace(originalString: string): string {
    Utils.assertType(originalString, "string", "removeWhitespace", "originalString");
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
    // original must actually be a string — fail fast and clearly rather than letting
    // replaceAll throw its own less-informative TypeError on null/undefined below.
    if (Utils.isNullOrUndefined(original)) {
      const errText = `Cannot replace [${searchValue}] with [${replaceValue}] Original is null or undefined!`;
      Log.logErrorAndThrow(errText, {stackOffset: 1});
    }
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
  static isBlank(text:string):boolean{
    return Utils.isNullOrUndefined(text) || text.trim().length === 0;
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
   * any other escaping convention in this codebase (e.g. `Detokeniser`'s own `/`-escaping),
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

}
