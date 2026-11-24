import { JsonUtils, Log, Utils } from "../index.js";

const SOURCE_VERB = "file";
const CAST_VERBS = ["number", "boolean", "json"] as const;
type CastVerb = typeof CAST_VERBS[number];
const ALL_VERBS = new Set<string>([SOURCE_VERB, ...CAST_VERBS]);

/**
 * Real runtime type guard for `CastVerb` — used instead of a bare `as CastVerb` assertion
 * at the one place a candidate verb string becomes a `castVerb` (see `splitVerbs`). Without
 * this, that assignment was "safe" only by coincidence: it relied on `ALL_VERBS` always
 * being built as exactly `{SOURCE_VERB} ∪ CAST_VERBS`, with nothing locally enforcing that
 * relationship — if it ever drifted, a bogus `castVerb` would sail straight through
 * `applyCast`'s switch (which TypeScript considers exhaustive *because* of that same
 * trusted-but-unchecked assertion) and silently return `undefined` instead of throwing.
 */
// Exported (file-local, not re-exported from this package's public index.ts barrel) purely
// so the spec file can test this guard directly — the behaviour it protects is otherwise
// unreachable through ValueExpression.parse's own public surface, by design.
export function isCastVerb(verb: string): verb is CastVerb {
  return (CAST_VERBS as readonly string[]).includes(verb);
}

/**
 * Parses a single "value expression" string — the convention this package uses anywhere a
 * tabular/textual source needs typed values from plain text (a table cell's `Value` column,
 * a header value, anywhere else with the same need) — into its resolved, correctly-typed
 * value.
 *
 * Two independent choices, composed with a comma, both appearing — always — before a
 * single colon, with the actual argument (inline text, or a file path) coming once, after
 * it:
 * - **Source**: where the raw text comes from. Default is inline (the expression's own
 *   text, verbatim). `file:<path>` instead loads the named file's contents (resolved via
 *   {@link Utils.resolveTestDataPath} — always relative to the configured test-data root,
 *   never absolute) as the raw text.
 * - **Cast**: what type to interpret that raw text as. Default is string (no interpretation
 *   at all). `number:`/`boolean:`/`json:` instead parse it as that type. `json:` itself
 *   defaults to strict JSON, but accepts JSON5 instead (unquoted keys, single-quoted
 *   strings, trailing commas, comments) via the `useJson5` option, below — the test
 *   author's own step wording never changes either way, only the calling code's choice.
 *
 * `file,number:xyzzy.num` composes both: load `xyzzy.num`'s contents, then cast them to a
 * number. No implicit type-sniffing anywhere — an unrecognised (or absent) verb list is
 * always the literal string, verbatim. Getting a number/boolean/JSON value requires saying
 * so explicitly; this is **not forgiving** of a value that merely *looks* like a number, to
 * avoid surprising a test author with a silent wrong-type coercion.
 *
 * The first colon is what matters, not any colon — whatever follows it is never split
 * again, so `json:{"a":"x,y:z"}` is safe: the text before the *first* colon won't be a
 * recognised verb list, so the whole thing falls through to "literal, unstructured"
 * automatically, with no special-casing needed.
 *
 * @param expression - The raw text to parse.
 * @param options - Optional settings:
 *   - `useJson5` — when `true`, `json:` parses using JSON5 rules (unquoted keys,
 *     single-quoted strings, trailing commas, comments, etc.) instead of strict JSON.
 *     Defaults to `false` (strict JSON) — this is the same choice, and the same default,
 *     as {@link JsonUtils.parse}'s own `useJson5` parameter, just threaded through from
 *     here. The *caller* (the "using code") decides, not this method — a test-framework
 *     caller whose `json:` cast only ever produces an in-memory object that gets
 *     `JSON.stringify`-ed again before going anywhere (e.g. a request body, a header map)
 *     has nothing to lose from passing `true`; a caller that treats the parsed value's
 *     *shape* as evidence the original text really was strict JSON should leave it `false`.
 *   - `allowCastVerbs` — when `false`, `number`/`boolean`/`json` are not recognised as
 *     verbs at all, only `file` is — so e.g. `json:hello` is no longer intercepted as a cast
 *     attempt; it's just the literal text `json:hello`. Defaults to `true`. For a caller
 *     whose destination can only ever be text anyway (a header value, a query-string
 *     parameter) — where every cast verb either buys nothing (`number:42` and plain `42`
 *     produce identical wire text) or actively restricts what's expressible (`json:` can
 *     resolve to a shape, like a plain object, with no valid wire representation at all) —
 *     disabling cast verbs removes a footgun with no corresponding capability loss: a value
 *     that happens to start with a recognised verb's name is no longer misread as a cast
 *     attempt instead of being sent as the literal text it was meant to be. `file:` stays
 *     available regardless, since sourcing text from a file is an independent capability
 *     with nothing to do with casting to a type.
 * @returns The resolved value: a `string`, `number`, `boolean`, or (via `json:`) any
 *   JSON-compatible shape, including an object or array. A caller with narrower
 *   requirements (e.g. a header value, which can never be an object) must validate the
 *   result itself — this has no idea what the value is *for*.
 * @throws {Error} If the same source or cast category is repeated (e.g. `file,file:x`,
 *   `number,boolean:x`); if `file:`'s path is blank or cannot be read; if `number:`'s value
 *   isn't a valid finite number; if `boolean:`'s value isn't exactly `true` or `false`
 *   (case-sensitive, no `"1"`/`"yes"`/etc.); or if `json:`'s value isn't valid JSON (or,
 *   with `useJson5: true`, valid JSON5).
 *
 * @example
 * await ValueExpression.parse('Bearer abc123');            // => 'Bearer abc123'  (inline, string)
 * await ValueExpression.parse('number:42');                // => 42
 * await ValueExpression.parse('boolean:true');              // => true
 * await ValueExpression.parse('json:{"a":1}');              // => { a: 1 }
 * await ValueExpression.parse('json:{a:1}', { useJson5: true }); // => { a: 1 }  (JSON5 — unquoted key)
 * await ValueExpression.parse('file:token.txt');            // => <file contents, trimmed, as a string>
 * await ValueExpression.parse('file,boolean:flag.txt');     // => true/false, cast from file contents
 * await ValueExpression.parse('json:hello', { allowCastVerbs: false }); // => 'json:hello'  (cast verbs off — literal text, not a cast attempt)
 * await ValueExpression.parse('file:token.txt', { allowCastVerbs: false }); // => <file contents, trimmed, as a string>  ('file:' still works)
 */
export class ValueExpression {
  static async parse(expression: string, options?: { useJson5?: boolean; allowCastVerbs?: boolean }): Promise<unknown> {

    ////////////////////////////////////////////////////
    //
    // Resolves a value-expression string end to end: work out which verbs (if any) the
    // expression uses, load it from a file if the 'file' source verb was given, then apply
    // whichever cast verb (if any) was given to the resulting raw text.

    // expression must actually be a string — fail fast and clearly if not.
    Utils.assertType(expression, "string", "ValueExpression.parse", "expression");

    // Work out the source verb / cast verb / remaining argument text from the expression.
    const { sourceVerb, castVerb, argument } = ValueExpression.splitVerbs(expression, options?.allowCastVerbs ?? true);

    let rawText: string;
    if (sourceVerb === SOURCE_VERB) {
      // 'file' source verb given — resolve the argument as a path (relative to the
      // configured test-data root), load that file's contents, trim surrounding whitespace.
      const resolvedPath = Utils.resolveTestDataPath(argument);
      rawText = Utils.getFileContents(resolvedPath).trim();
    } else {
      // No source verb given — the argument text itself IS the raw text, as-is.
      rawText = argument;
    }

    // Apply whichever cast verb (if any) was given to the resolved raw text, and return
    // the result.
    return ValueExpression.applyCast(expression, rawText, castVerb, options?.useJson5 ?? false);
  }

  /**
   * Splits `expression` into its (optional) source/cast verbs and the remaining argument,
   * on the *first* colon only. If there's no colon, or the text before it isn't entirely
   * recognised verbs (comma-separated, each exactly `file`/`number`/`boolean`/`json`, or
   * just `file` when `allowCastVerbs` is `false`), the whole original `expression` is
   * treated as the argument, with no verbs at all — the literal, unstructured case.
   */
  private static splitVerbs(expression: string, allowCastVerbs: boolean): { sourceVerb?: string; castVerb?: CastVerb; argument: string } {

    ////////////////////////////////////////////////////
    //
    // Identify whether the passed-in string has valid verbs preceding the first colon. If the
    // string has no colon, or the text before the first colon isn't entirely a comma-delimited
    // list of recognised verbs, the whole string passed in is handed straight back as the
    // argument, with sourceVerb and castVerb both left undefined.

    // Find the first colon in the string passed in.
    const firstColon = expression.indexOf(":");
    // No colon at all — return the whole string as 'argument' (leaving sourceVerb and castVerb undefined).
    if (firstColon === -1) {
      return { argument: expression };
    }
    // Check that every comma-delimited piece of text preceding the first colon is a recognised
    // verb — present in ALL_VERBS normally, or in just {file} when allowCastVerbs is false, so
    // a cast verb's name (e.g. 'json') isn't recognised as a verb at all in that mode. If
    // there's no text before the colon at all, or any one of the comma-delimited pieces isn't
    // recognised, this isn't a verb list — return the whole string as 'argument' (leaving
    // sourceVerb and castVerb undefined). Otherwise, candidateVerbs holds the confirmed,
    // recognised verb list for the loop below to classify.
    const recognisedVerbs = allowCastVerbs ? ALL_VERBS : new Set([SOURCE_VERB]);
    const candidateVerbsText = expression.slice(0, firstColon);
    const candidateVerbs = candidateVerbsText.split(",").map((verb) => verb.trim());
    const allRecognised = candidateVerbsText.length > 0 && candidateVerbs.every((verb) => recognisedVerbs.has(verb));
    if (!allRecognised) {
      return { argument: expression };
    }

    // The text preceding the first colon is confirmed to be entirely recognised verbs. Walk
    // candidateVerbs and classify each one as the source verb ('file') or a cast verb
    // ('number'/'boolean'/'json'), populating:
    //   - sourceVerb: 'file', if 'file' appears anywhere in the list (always valid at most once).
    //   - castVerb: whichever cast verb appears in the list (also valid at most once) — or
    //     undefined if the list contained only 'file' and nothing else.
    let sourceVerb: string | undefined;
    let castVerb: CastVerb | undefined;
    // Loop through every comma-delimited verb found before the expression's first colon.
    for (const verb of candidateVerbs) {
      // This item is the source verb ('file').
      if (verb === SOURCE_VERB) {
        // 'file' already seen earlier in this same list (e.g. 'file,file:...') — reject it: only
        // one source verb is allowed.
        if (!Utils.isUndefined(sourceVerb)) {
          Log.logErrorAndThrow(`ValueExpression.parse: [${expression}] repeats the '${SOURCE_VERB}' verb — only one source verb is allowed`);
        }
        // First time seeing 'file' in this list — record it.
        sourceVerb = verb;
      } else {
        // This item isn't 'file', so (since it already passed the ALL_VERBS check above) it must
        // be one of the cast verbs. isCastVerb is a real runtime check, not just a type
        // assertion — see its own doc comment for why that matters.
        if (!isCastVerb(verb)) {
          Log.logErrorAndThrow(`ValueExpression.parse: [${expression}] — [${verb}] is not a recognised cast verb (expected one of: ${CAST_VERBS.join(", ")}).`);
        }
        // A cast verb already seen earlier in this same list (e.g. 'boolean,number:...') —
        // reject it: only one cast verb is allowed.
        if (!Utils.isUndefined(castVerb)) {
          Log.logErrorAndThrow(`ValueExpression.parse: [${expression}] combines conflicting cast verbs ['${castVerb}', '${verb}'] — only one cast verb is allowed`);
        }
        // First cast verb seen in this list — record it.
        castVerb = verb;
      }
    }

    // sourceVerb is 'file' if the verb list contained 'file' (in either position: alone, or
    // paired with a cast verb), otherwise undefined.
    // castVerb is whichever cast verb the verb list contained (alone, or paired with 'file'),
    // otherwise undefined. argument is always everything after that first colon, unchanged.
    return { sourceVerb, castVerb, argument: expression.slice(firstColon + 1) };
  }

  /** Applies the resolved cast verb (if any) to the already-source-resolved raw text. */
  private static applyCast(originalExpression: string, rawText: string, castVerb: CastVerb | undefined, useJson5: boolean): unknown {

    ////////////////////////////////////////////////////
    //
    // Applies whichever cast verb (if any) was resolved by splitVerbs to the already
    // source-resolved raw text, and returns the cast value. No cast verb at all just
    // returns the raw text unchanged, as a plain string — every other branch either
    // returns a successfully-cast value or throws a clear error, never both "sort of
    // worked" and silent.

    switch (castVerb) {
      // No cast verb given — return the raw text unchanged, as a plain string.
      case undefined:
        return rawText;
      case "number": {
        // Trim surrounding whitespace, then try to parse as a number.
        const trimmed = rawText.trim();
        const parsed = Number(trimmed);
        // Number('') is 0, not NaN — a known JS gotcha — so an empty value has to be
        // checked for explicitly, separately from the finite check below it.
        if (trimmed.length === 0 || !Number.isFinite(parsed)) {
          Log.logErrorAndThrow(`ValueExpression.parse: [${originalExpression}] — [number:] value [${rawText}] is not a valid finite number`);
        }
        return parsed;
      }
      case "boolean": {
        // Trim surrounding whitespace, then accept only an exact, lowercase 'true'/'false'
        // — no "1"/"yes"/"TRUE"/etc — never guess at what the test author meant.
        const trimmed = rawText.trim();
        if (trimmed !== "true" && trimmed !== "false") {
          Log.logErrorAndThrow(`ValueExpression.parse: [${originalExpression}] — [boolean:] value [${rawText}] must be exactly 'true' or 'false'`);
        }
        return trimmed === "true";
      }
      case "json": {
        // Parse as JSON (or, if useJson5 was given, JSON5) — JsonUtils.parse does the
        // actual parsing; this just adds the ValueExpression-specific error wrapping.
        try {
          return JsonUtils.parse(rawText, useJson5);
        } catch (err) {
          Log.logErrorAndThrow(`ValueExpression.parse: [${originalExpression}] — [json:] value is not valid JSON${useJson5 ? "5" : ""}: ${Utils.errorMessage(err)}\nValue: ${rawText}`);
        }
      }
      // False positive: the "json" case above never falls through at runtime, since
      // Log.logErrorAndThrow's `never` return type guarantees its catch block always
      // throws — a guarantee ESLint's purely syntactic fallthrough check can't see, only
      // TypeScript's own checker can (and does: typecheck passes clean).
      // eslint-disable-next-line no-fallthrough
      default: {
        // Unreachable given splitVerbs' own isCastVerb guard — kept as a second,
        // independent backstop (defence in depth, not redundancy): if this function is
        // ever called some other way, or splitVerbs' guard is ever removed/weakened, this
        // is what stops castVerb from silently falling through to an implicit
        // `return undefined` instead of a clear, loud error.
        Log.logErrorAndThrow(`ValueExpression.parse: [${originalExpression}] — internal error: unrecognised cast verb [${String(castVerb)}]. This should be unreachable.`);
      }
    }
  }
}
