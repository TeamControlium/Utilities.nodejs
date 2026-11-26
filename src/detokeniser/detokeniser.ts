import { Log, LogLevels, StringUtils, Utils } from "../index.js";
import { builtinDate, builtinDiff, builtinTimezone } from "./dateBuiltins.js";
import { builtinBase64, builtinJWT } from "./encodingBuiltins.js";
import { builtinMockRequests } from "./mockingBuiltins.js";
import { builtinRandom } from "./randomBuiltins.js";
import { builtinSetting } from "./systemBuiltins.js";

/**
 * Thrown for anything that means "this text doesn't look like a valid, resolvable token" —
 * an unterminated `<%`, an unmatched `%>`, an empty token body, malformed verb/qualifier
 * syntax, or a verb nothing claims. Thrown unconditionally everywhere this engine detects one
 * of those — but only ever *caught* in one place: {@link Detokeniser.doToken}'s own recursive
 * check of a handler's *returned* value (see this class's own "Nesting" doc section). There,
 * and only there, it's caught and treated as "this wasn't really fresh token syntax after
 * all" — the handler's raw output is used literally instead of propagating the error.
 *
 * Why the asymmetry: malformed syntax in the *original input* a tester typed is always a hard
 * failure (see "Malformed input" below) — nobody calls {@link Detokeniser.doAsync} on data they
 * don't want detokenised, so an unterminated `<%` there is a genuine mistake worth surfacing
 * immediately. A handler's own *generated* output is a different kind of text entirely — e.g.
 * `random|from(...)` legitimately drawing literal `<`/`%`/`>` characters from a test-author-
 * chosen pool. If that draw happens to produce `<%` with nothing to close it, that's incidental
 * data shape, not a typo, and shouldn't crash the whole call — same reasoning the engine this
 * replaces applied to incidental `<%`/`%>` adjacency in unrelated input data, just relocated to
 * the one place it still genuinely applies now that point 4's tolerant-input-fallback is gone.
 */
class MalformedTokenSyntaxError extends Error {}

/**
 * Thrown when {@link Detokeniser.maxNestingDepth} is exceeded — by either guard that enforces
 * it (see this class's own "Nesting" doc section). Never caught anywhere in this engine, unlike
 * {@link MalformedTokenSyntaxError} — exceeding the configured depth is always a hard failure,
 * including when discovered while recursing into a handler's own returned value, because it's
 * exactly the defensive guard against a handler whose output resolves back into itself that
 * {@link Detokeniser.maxNestingDepth}'s own doc comment describes; silently swallowing it would
 * defeat the guard's entire purpose.
 */
class RecursionDepthExceededError extends Error {}

/**
 * Max length {@link Detokeniser.doAsync}'s own top-level `TestDebug` logging truncates the raw
 * string to, for the single-line "no tokens found" case.
 */
const LOG_NO_TOKEN_TRUNCATE_LENGTH = 48;

/**
 * Max length per-token `TestDebug` logging (and error messages quoting the offending text)
 * truncate to.
 */
const LOG_TOKEN_TRUNCATE_LENGTH = 64;

/**
 * Opens/closes a marker — see {@link Detokeniser}'s own "Opacity" doc section. Private-use-area
 * code points: guaranteed never to occur in real test data, loaded file content, or any
 * built-in's generated output, which is exactly why they're safe to use as an internal-only
 * sentinel nothing else in the grammar (delimiter, `(`/`)`/`'`/`"`/`` ` ``/`<`/`%`/`>`) already
 * claims.
 */
const MARKER_OPEN = "";
const MARKER_CLOSE = "";

/**
 * Processes strings containing tokens in the format `<%verb|arg|arg%>`, replacing each token
 * with its resolved value. Tokens can be nested to any depth, anywhere in the token's own
 * structure (including inside a verb's own parenthesised parameters) — the innermost is always
 * resolved first.
 *
 * This file is the resolution *engine* only — see `utils/docs/design/
 * detokeniser-v2-engine-rewrite.md` for the full design history and the reasoning behind every
 * decision below; this comment only summarises the result. The built-in verbs themselves live
 * in sibling files grouped by what they do — `randomBuiltins.ts`, `dateBuiltins.ts`,
 * `systemBuiltins.ts`, `encodingBuiltins.ts`, `mockingBuiltins.ts`.
 *
 * ## Token syntax
 * ```
 * <%verb|arg|arg%>
 * <%verb(qualifier)|arg|arg%>
 * ```
 * - **verb** — identifies which registered handler resolves this token.
 * - **qualifier** — optional, parenthesised text immediately after the verb (e.g. `date(nsw)`).
 *   Not interpreted by the engine — handed to whichever handler matches `verb` to interpret
 *   however it likes. Content is everything up to the first *unescaped* `)`, not nesting-aware
 *   on its own structural characters (an inner `(` is literal) — but a nested `<%...%>` token
 *   written inside it IS resolved first, same as anywhere else (see "Nesting" below). Nothing
 *   is required to follow the closing `)` — a parameterised verb can be the whole token.
 * - **arg** — handler-specific, delimiter-separated (each built-in's own file documents its
 *   shape).
 *
 * ## Nesting
 * Tokens resolve innermost-first, so nested tokens compose naturally, anywhere in the token's
 * structure:
 * ```typescript
 * await Detokeniser.doAsync('<%date|addDays(<%random|digits|1%>)|dd-MM-yyyy%>');
 * await Detokeniser.doAsync('<%diff|<%timezone|Africa/Lusaka%>|<%timezone|Europe/London%>%>');
 * ```
 * A handler's own *returned* value is also checked for fresh, unescaped token syntax and
 * resolved the same way — a handler that recognises bad input and returns a corrected token for
 * the engine to resolve (rather than resolving it itself) works correctly:
 * ```typescript
 * // date() sees an unrecognised zone, returns <%date(NZST);addWorkingDays(3);dd-MM-yyyy%> for
 * // the engine to resolve — same mechanism as any other nested token, one level deeper.
 * ```
 * Both forms of nesting — written directly in the input, and freshly introduced by a handler's
 * own output — count against {@link Detokeniser.maxNestingDepth}, since both are, structurally,
 * the same recursive "resolve any unescaped tokens in this text" operation. Exceeding it throws
 * — the defensive guard against a misconfigured handler (e.g. one that loads a file containing
 * a token that resolves back into itself) looping forever.
 *
 * ## Opacity
 * A resolved value that ends up inside a still-open *outer* token's own body must never let its
 * own characters be mistaken for that outer token's structural syntax by whatever splitting
 * convention that verb's own handler happens to use — not just the delimiter, but anything any
 * handler's own grammar keys on (quotes, parens, or a convention nobody's written yet). The
 * engine achieves this by never splicing a resolved value's real text into an enclosing frame
 * directly: it stores the real value in a table (one per top-level {@link Detokeniser.doAsync}
 * call) and splices in a **marker** instead — `<open><digits><close>`, built from reserved
 * sentinel characters no real content will ever contain. Every handler's own splitting is
 * automatically protected with zero marker-awareness required, because a marker contains none
 * of the characters any splitting convention could key on.
 *
 * A handler that needs the *real* content of something it extracts from `args` (most of them —
 * a timezone name, a numeric offset — do) calls {@link Detokeniser.VerbContext.resolveMarkers}
 * on that extracted piece, after its own splitting, before using it. A handler that's indifferent
 * to content (just reshuffling opaque blobs) never needs to call it at all. Markers left
 * unresolved in whatever a handler returns are resolved automatically, once, at the very top of
 * the whole call, before the result is ever handed back to the original caller — nothing in
 * between ever needs to force early resolution, which is also why opacity survives arbitrary
 * nesting depth for free: a marker can ride unresolved through any number of enclosing frames.
 *
 * ## Escaping
 * The escape character is `` ` `` (backtick), fixed — see the design doc's own sentinel/escape
 * survey (point 9) for why this replaced `/`: `/` is the single most common character in file
 * paths and URLs, exactly the data this framework spends most of its time handling, so it
 * silently ate real path separators sitting next to a token boundary. Escaping only has an
 * effect immediately before a token boundary sequence (`<%` or `%>`) — a run of escape chars
 * anywhere else is left completely untouched.
 *
 * | Input | Output | Notes |
 * |---|---|---|
 * | `` `<% `` | `<%` | Literal `<%` — not treated as token start |
 * | `` `%> `` | `%>` | Literal `%>` — not treated as token end |
 * | `` ``<% `` | `` `<% `` | Escaped escape char, followed by a real token start |
 * | `/path/<%literal%>/here` | `/path/<%literal%>/here` | `/` here is nowhere near this engine's own escape character |
 *
 * An escaped token inside a handler's own returned value is left alone (not resolved) exactly
 * like an escaped token in the original input — de-escaping happens once, automatically, at the
 * very end of the whole top-level call. Pass `{ deEscape: false }`
 * ({@link Detokeniser.DoOptions.deEscape}) to defer even that, when this call's output will be
 * detokenised again later and escape sequences need to survive intact for that later pass.
 * `{ escapeOutgoingTokens: true }` goes the other way — after everything else (marker
 * resolution, recursive resolution, de-escaping) is done, it makes one final pass over the
 * string about to be returned and escapes every literal `<%`/`%>` it finds, so a caller who is
 * about to feed this result into a *later* `doAsync` call doesn't have it misread as live token
 * syntax (e.g. a handler that loaded a file whose content happens to contain that sequence
 * incidentally). Fires exactly once, on the top-level result only.
 *
 * ## Malformed input
 * Unlike the engine this replaces, malformed input is never tolerated as literal text — an
 * unterminated `<%`, a stray `%>`, or a verb nothing claims all throw. `doAsync` is only ever
 * called on strings a tester deliberately wants detokenised; there's no "incidental `<%`/`%>`
 * adjacency in unrelated data" case to protect against here, because nobody calls it on data
 * they don't intend to be token-processed. A tester whose own data genuinely collides with the
 * active boundary has {@link Detokeniser.tokenStartStop} as an escape hatch (switch boundary)
 * rather than losing this fail-loud guarantee.
 *
 * ## Dispatch — built-ins are callbacks too
 * Every built-in verb is registered into {@link Detokeniser._builtinCallbacks} the same shape
 * {@link Detokeniser.addCallback} registers a custom one into. Resolving a token tries, in
 * order: every callback registered for that verb via `addCallback`, most recently registered
 * first (so a callback can override an earlier one, or a built-in of the same name); then the
 * built-in for that verb, if any. A callback declines by returning `undefined`.
 *
 * {@link Detokeniser.doAsync} is the only entry point — it always awaits every callback, sync or
 * async, so there's no separate sync method whose caller would need to know in advance whether
 * every token resolves synchronously.
 *
 * @see {@link Detokeniser.addCallback}
 * @see {@link Detokeniser.doAsync}
 */
export class Detokeniser {
  private static _endTokenChar = "%>";
  private static _startTokenChar = "<%";
  private static EscapeChar = "`";
  private static _delimiter = "|";
  private static _maxNestingDepth = 8;

  /**
   * The only characters a caller may set {@link Detokeniser.delimiter} to — see this field's own
   * history in the design doc for the full reasoning. An allow-list, not a deny-list, so a
   * future built-in's own sub-grammar can't silently re-break the delimiter feature by claiming
   * a character nobody thought to deny.
   */
  private static readonly _allowedDelimiters = new Set([" ", "|", ";", ":", "~", "^", "!", "?", "&"]);

  /**
   * The only values a caller may set {@link Detokeniser.tokenStartStop} to — each the full
   * 4-character open+close form (first two characters are the open sequence, last two are the
   * close sequence), never a 2-character shorthand, so the value itself is unambiguous about
   * exactly what the resulting {@link Detokeniser._startTokenChar}/
   * {@link Detokeniser._endTokenChar} will be without requiring the caller to remember a
   * separate decoding rule.
   *
   * `<%%>` is the default — see the design doc's own sentinel/escape-character survey (point 9)
   * for why: `<`/`>` are illegal in Windows filenames and vanishingly rare in Unix paths or
   * plain JSON, and `%` immediately next to either is rarer still outside the JSP/ASP/ERB
   * scriptlet convention this pair borrows from. The other three exist as alternates for a
   * tester whose own data shape collides with it anyway:
   *
   * `()` is deliberately excluded, unlike the bracket pairs — it isn't just an incidental-data
   * collision risk (the thing this setting exists to let a tester route around), it collides
   * with this grammar's own reserved syntax. Several built-ins take bare `(...)` arguments
   * today (`addDays(n)`, `date(fromEpoch,toEpoch)`, `random(...)`, `float(min,max)`,
   * `from(...)`), and the verb qualifier syntax itself is `verb(qualifier)`.
   * `((date(addDays(5))|format))` under a `((`/`))` boundary closes the token early, at
   * `addDays(5)`'s own closing `)` sitting immediately next to `date(...)`'s own closing `)`
   * — a `))` pair, long before the real end — breaking most non-trivial existing built-in
   * usage, not a rare edge case.
   *
   * `{{`/`}}` is included despite having a real collision risk of its own — nested JSON
   * *objects* (`{{jwt|{"a":{"b":1}}|secret%>`'s payload ends `...1}}`, a genuine `}}`) are at
   * least as common as nested arrays in API test payloads, and `{{`/`}}` also collides with
   * Handlebars/Mustache/Jinja2 template syntax if the AUT itself renders those — but a tester
   * who knows their own data shape may still have good reason to prefer it over the default.
   */
  private static readonly _allowedTokenStartStops = new Set(["<%%>", "[[]]", "{{}}", "<<>>"]);

  // User-registered callbacks, keyed by verb (lowercased/trimmed). Lazily created on first
  // addCallback call. Cleared by resetCallbacks()/reset() — test/suite state, not framework
  // capability, per the "100% clean start every test" guarantee those two methods provide.
  private static _userCallbacks: Map<string, Array<Detokeniser.Callback>> | undefined = undefined;

  // Built-in verb handlers, keyed by verb. Framework capability, not test state — untouched by
  // reset()/resetCallbacks(). Tried only after every _userCallbacks entry for that verb has had
  // a turn.
  private static readonly _builtinCallbacks: Map<string, Detokeniser.Callback> = new Map<string, Detokeniser.Callback>([
    ["random", builtinRandom],
    ["date", builtinDate],
    ["timezone", builtinTimezone],
    ["diff", builtinDiff],
    ["setting", builtinSetting],
    ["base64", builtinBase64],
    ["jwt", builtinJWT],
    ["mockintercepts", builtinMockRequests],
  ]);

  /**
   * Master on/off switch for token processing. When `false`, {@link Detokeniser.doAsync} returns
   * its input completely unchanged — no scanning, no error on malformed token syntax, nothing.
   * A plain public field, settable at any time by any caller, including mid-test.
   * @default true
   * @see {@link Detokeniser.reset}
   */
  public static enabled = true;

  /**
   * The character that separates a verb (and optional qualifier) from its arguments, and
   * separates one argument from the next. A getter/setter pair, not a plain field: a bad value
   * here can't just be tolerated — it needs rejecting immediately, at the point it's set.
   * @throws {Error} If set to anything other than a single character from the allow-list.
   * @default "|"
   * @see {@link Detokeniser.reset}
   */
  public static get delimiter(): string {
    return this._delimiter;
  }

  public static set delimiter(value: string) {
    Utils.assertType(value, "string", "Detokeniser.delimiter", "value");
    if (!this._allowedDelimiters.has(value)) {
      throw new Error(
        `Detokeniser.delimiter: [${Utils.describeValue(value)}] is not an allowed delimiter character — must be exactly one of: ` +
        [...this._allowedDelimiters].map((char) => (char === " " ? "<space>" : char)).join(", ")
      );
    }
    this._delimiter = value;
  }

  /**
   * The token start/stop — the characters that open/close a token, e.g. the `<%`/`%>` in
   * `<%random|digits|6%>`. A getter/setter pair, like {@link Detokeniser.delimiter}, taking
   * the full 4-character open+close form (`"<%%>"`, `"[[]]"`, `"{{}}"`, or `"<<>>"`) — never a
   * 2-character shorthand — so the value is self-describing and a caller can never end up with
   * a mismatched open/close pair. See {@link Detokeniser._allowedTokenStartStops}'s own doc
   * comment for why `()` isn't in the allow-list, why the default is `<%%>` rather than a
   * bracket pair, and why `{{`/`}}` is included despite its own collision risk.
   *
   * Exists so a tester whose data shape collides with the current boundary — most commonly a
   * 2D JSON array like `[[1,2],[3,4]]` colliding with `[[`/`]]`, which looks identical to the
   * scanner as a `[[`-opened token until nothing claims the resulting bogus verb and the whole
   * call throws — has an escape hatch: switch to a boundary their data doesn't collide with,
   * rather than losing the fail-loud-on-unrecognised-verb guarantee entirely. Settable the
   * same way `delimiter`/`maxNestingDepth` are — a default at suite setup, or changed for the
   * scope of a single test (e.g. via a Cucumber step def in `@controlium/cucumber`, not this
   * package) and reset after, same per-test-reset expectation {@link Detokeniser.reset}
   * already gives `delimiter`.
   *
   * Escaping, de-escaping, nesting, markers, and every other mechanic in this engine already
   * reference {@link Detokeniser._startTokenChar}/{@link Detokeniser._endTokenChar} as fields,
   * never a literal boundary string — changing this setting needs no change anywhere else.
   * @throws {Error} If set to anything other than one of the exact 4-character forms in
   *   {@link Detokeniser._allowedTokenStartStops} — including a 2-character shorthand like
   *   `"<%"`, a mismatched pair like `"<%}}"`, or any value not in the allow-list.
   * @default "<%%>"
   * @see {@link Detokeniser.reset}
   */
  public static get tokenStartStop(): string {
    return this._startTokenChar + this._endTokenChar;
  }

  public static set tokenStartStop(value: string) {
    Utils.assertType(value, "string", "Detokeniser.tokenStartStop", "value");
    if (!this._allowedTokenStartStops.has(value)) {
      throw new Error(
        `Detokeniser.tokenStartStop: [${Utils.describeValue(value)}] is not an allowed token boundary — must be exactly one of: ` +
        [...this._allowedTokenStartStops].join(", ")
      );
    }
    this._startTokenChar = value.slice(0, 2);
    this._endTokenChar = value.slice(2, 4);
  }

  /**
   * How many levels deep nested/recursive token resolution is allowed to go before
   * {@link Detokeniser.doAsync} throws rather than continuing — see this class's own "Nesting"
   * doc section for why this exists (the defensive guard against a handler whose own output
   * resolves back into itself, directly or via a cycle). Settable the same way
   * {@link Detokeniser.delimiter} is — a default read from settings, or overridden mid-test.
   * @throws {Error} If set to anything other than a positive integer.
   * @default 8
   * @see {@link Detokeniser.reset}
   */
  public static get maxNestingDepth(): number {
    return this._maxNestingDepth;
  }

  public static set maxNestingDepth(value: number) {
    Utils.assertType(value, "number", "Detokeniser.maxNestingDepth", "value");
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Detokeniser.maxNestingDepth: [${Utils.describeValue(value)}] must be a positive integer.`);
    }
    this._maxNestingDepth = value;
  }

  /**
   * Resets the Detokeniser to factory defaults: {@link Detokeniser.enabled} restored to `true`,
   * {@link Detokeniser.delimiter} restored to `"|"`, {@link Detokeniser.tokenStartStop} restored
   * to `"<%%>"`, {@link Detokeniser.maxNestingDepth} restored to `8`, escape char restored to
   * `` ` ``, and all user-registered callbacks cleared.
   * @example
   * afterEach(() => Detokeniser.reset());
   */
  public static reset() {
    this.enabled = true;
    this.delimiter = "|";
    this.tokenStartStop = "<%%>";
    this.maxNestingDepth = 8;
    this.EscapeChar = "`";
    this._userCallbacks = undefined;
  }

  /**
   * Registers a custom handler for `verb`. Handlers registered for the same verb are tried in
   * **reverse** registration order (most-recently-registered first) — so the latest one wins
   * among several, and any of them can override a built-in of the same verb name.
   *
   * @param verb - The verb this handler resolves, e.g. `"charcode"` for `<%charcode|...%>`
   *   tokens. Matched case-insensitively, trimmed.
   * @param callback - See {@link Detokeniser.VerbContext} for what's available on `context`.
   *
   * @example
   * Detokeniser.addCallback('charcode', ({ args, delimiter }) => {
   *   const [char, base] = args.split(delimiter);
   *   const code = char.charCodeAt(0);
   *   return base === 'hex' ? code.toString(16) : String(code);
   * });
   * await Detokeniser.doAsync('<%charcode|A|hex%>'); // → '41'
   *
   * @see {@link Detokeniser.resetCallbacks}
   * @see {@link Detokeniser.doAsync}
   */
  public static addCallback(verb: string, callback: Detokeniser.Callback) {
    Utils.assertType(verb, "string", "Detokeniser.addCallback", "verb");
    Utils.assertType(callback, "function", "Detokeniser.addCallback", "callback");
    const key = verb.toLowerCase().trim();
    if (!this._userCallbacks) {
      this._userCallbacks = new Map<string, Array<Detokeniser.Callback>>();
    }
    if (!this._userCallbacks.has(key)) {
      this._userCallbacks.set(key, []);
    }
    this._userCallbacks.get(key)!.push(callback);
  }

  /**
   * Removes all user-registered callbacks. Built-in handlers live in
   * {@link Detokeniser._builtinCallbacks}, untouched by this method.
   * @see {@link Detokeniser.reset} to also restore all defaults
   */
  public static resetCallbacks() {
    this._userCallbacks = undefined;
  }

  /**
   * Resolves all tokens in the given string and returns a Promise of the result. The single,
   * sole entry point — every built-in token type is fully synchronous internally, but this
   * always awaits any registered callback that returns a `Promise`, so a caller never needs to
   * know in advance whether the tokens a given string happens to contain will all resolve
   * synchronously or not.
   *
   * @param tokenisedString - String potentially containing `<%...%>` tokens
   * @param options - See {@link Detokeniser.DoOptions}
   * @returns Promise resolving to the input string with all tokens replaced
   * @throws If any token is malformed, unsupported, a callback throws, or
   *   {@link Detokeniser.maxNestingDepth} is exceeded
   *
   * @example
   * await Detokeniser.doAsync('Ref-<%random|digits|6%>');                 // → e.g. 'Ref-482910'
   * await Detokeniser.doAsync('<%date|addDays(<%random|digits|1%>)|dd-MM-yyyy%>');
   * await Detokeniser.doAsync('Press `<%Enter`%> to continue');           // → 'Press <%Enter%> to continue'
   */
  public static async doAsync(tokenisedString: string, options: Detokeniser.DoOptions = {}): Promise<string> {
    if (!this.enabled) return tokenisedString;

    if (typeof tokenisedString !== "string") {
      return this.doResolve(tokenisedString, options);
    }

    if (!tokenisedString.includes(this._startTokenChar)) {
      Log.writeLine(LogLevels.FrameworkInformation, `Processed [${StringUtils.truncateIfNeeded(tokenisedString, LOG_NO_TOKEN_TRUNCATE_LENGTH)}], no tokens found`);
    }

    return this.doResolve(tokenisedString, options);
  }

  /**
   * Wraps {@link Detokeniser.resolveTokens} — the actual scan — with type validation, error
   * context, and the final marker-resolution/de-escape/escape-outgoing passes, in that order
   * (see this class's own "Opacity"/"Escaping" doc sections for why that order matters). Not
   * part of this class's public API.
   */
  private static async doResolve(tokenisedString: string, options: Detokeniser.DoOptions = {}): Promise<string> {
    try {
      Utils.assertType(tokenisedString, "string", "Detokeniser.doAsync", "tokenisedString");
      const markerTable: string[] = [];
      const resolved = await this.resolveTokens(tokenisedString, options, markerTable, 0);
      const markersResolved = this.resolveMarkersInText(markerTable, resolved);
      const deEscaped = this.doDeEscapesIfRequired(options.deEscape ?? true, markersResolved);
      return this.doEscapeOutgoingTokensIfRequired(options.escapeOutgoingTokens ?? false, deEscaped);
    } catch (err: unknown) {
      const errText = `Error processing [${tokenisedString}]: ${Utils.errorMessage(err)}`;
      Log.writeLine(LogLevels.Error, errText);
      throw Error(errText);
    }
  }

  /**
   * The resolution engine behind {@link Detokeniser.doAsync}. A single left-to-right pass over
   * `text`, using a stack of not-yet-closed `<%` positions:
   * - An unescaped `<%` pushes a new, empty frame.
   * - An unescaped `%>` pops the innermost open frame, resolves its accumulated body via
   *   {@link Detokeniser.doToken}, and appends the result — as a marker, never as raw text, see
   *   this class's own "Opacity" doc section — to whichever buffer is now current.
   * - Every other character is copied straight through, unchanged.
   *
   * Also invoked recursively by {@link Detokeniser.doToken} on a handler's own returned value,
   * one `depth` deeper, to catch any unescaped token syntax that value freshly introduces — see
   * this class's own "Nesting" doc section. `depth` is shared across both triggers for exactly
   * that reason: structurally, they're the same operation.
   *
   * Malformed input is never tolerated as literal text here — see this class's own "Malformed
   * input" doc section for why that's a deliberate change from the engine this replaces.
   */
  private static async resolveTokens(text: string, options: Detokeniser.DoOptions, markerTable: string[], depth: number): Promise<string> {
    if (depth > this.maxNestingDepth) {
      throw new RecursionDepthExceededError(
        `Detokeniser: maxNestingDepth (${this.maxNestingDepth}) exceeded while resolving [${StringUtils.truncateIfNeeded(this.resolveMarkersInText(markerTable, text), LOG_TOKEN_TRUNCATE_LENGTH)}] — ` +
        `check for a handler whose own output resolves back into itself, directly or via a cycle.`
      );
    }

    interface OpenFrame {
      buffer: string;
    }

    const stack: OpenFrame[] = [];
    let mainOutput = "";

    const appendCurrent = (chunk: string): void => {
      if (stack.length > 0) stack[stack.length - 1].buffer += chunk;
      else mainOutput += chunk;
    };

    let index = 0;
    while (index < text.length) {
      if (text.startsWith(this._startTokenChar, index) && !this.isEscaped(text, index)) {
        if (stack.length >= this.maxNestingDepth) {
          throw new RecursionDepthExceededError(
            `Detokeniser: maxNestingDepth (${this.maxNestingDepth}) exceeded — too many levels of [${this._startTokenChar}] nesting in [${StringUtils.truncateIfNeeded(this.resolveMarkersInText(markerTable, text), LOG_TOKEN_TRUNCATE_LENGTH)}].`
          );
        }
        stack.push({ buffer: "" });
        index += this._startTokenChar.length;
        continue;
      }
      if (text.startsWith(this._endTokenChar, index) && !this.isEscaped(text, index)) {
        if (stack.length === 0) {
          throw new MalformedTokenSyntaxError(
            `Detokeniser: unmatched [${this._endTokenChar}] — no corresponding [${this._startTokenChar}] found before it in [${StringUtils.truncateIfNeeded(this.resolveMarkersInText(markerTable, text), LOG_TOKEN_TRUNCATE_LENGTH)}].`
          );
        }
        const closedFrame = stack.pop()!;
        const resolvedValue = await this.doToken(closedFrame.buffer, options, markerTable, depth);
        appendCurrent(this.allocateMarker(markerTable, resolvedValue));
        index += this._endTokenChar.length;
        continue;
      }
      appendCurrent(text[index]);
      index++;
    }

    if (stack.length > 0) {
      throw new MalformedTokenSyntaxError(
        `Detokeniser: unterminated [${this._startTokenChar}] — never found its own closing [${this._endTokenChar}] in [${StringUtils.truncateIfNeeded(this.resolveMarkersInText(markerTable, text), LOG_TOKEN_TRUNCATE_LENGTH)}].`
      );
    }

    return mainOutput;
  }

  /**
   * Stores `value` in `markerTable` and returns the marker text that stands in for it — see
   * this class's own "Opacity" doc section. Never resolved back until
   * {@link Detokeniser.resolveMarkersInText} is explicitly called on text containing it, either
   * by a handler (via {@link Detokeniser.VerbContext.resolveMarkers}) or, once, by
   * {@link Detokeniser.doResolve} on the final top-level result.
   */
  private static allocateMarker(markerTable: string[], value: string): string {
    const index = markerTable.length;
    markerTable.push(value);
    return `${MARKER_OPEN}${index}${MARKER_CLOSE}`;
  }

  /**
   * Substitutes every `<open><digits><close>` marker found in `text` with its real value from
   * `markerTable`, recursively resolving markers *within* that real value first — a value stored
   * under one marker can itself contain another (e.g. a handler that glues two already-resolved,
   * still-opaque pieces together without dereferencing either). Recursion always terminates: a
   * marker's stored value was always fully constructed, including allocation of any marker names
   * *within* it, strictly before that value itself was given a new marker — a cycle back to a
   * marker's own index is structurally impossible.
   *
   * A `<open>` not actually followed by `digits` then `<close>` is left completely untouched —
   * these sentinel characters are reserved precisely so real content never produces this
   * sequence by accident, so treating a near-miss as literal text (rather than throwing) is the
   * safe default, not a silently-swallowed bug.
   */
  private static resolveMarkersInText(markerTable: string[], text: string): string {
    let result = "";
    let index = 0;
    while (index < text.length) {
      if (text[index] === MARKER_OPEN) {
        let scan = index + 1;
        let digits = "";
        while (scan < text.length && text[scan] >= "0" && text[scan] <= "9") {
          digits += text[scan];
          scan++;
        }
        if (digits.length > 0 && text[scan] === MARKER_CLOSE) {
          const storedValue = markerTable[Number.parseInt(digits, 10)];
          result += this.resolveMarkersInText(markerTable, storedValue);
          index = scan + 1;
          continue;
        }
      }
      result += text[index];
      index++;
    }
    return result;
  }

  /**
   * After all tokens are resolved and markers substituted, removes escaping from any
   * token-boundary sequence (`<%`/`%>`) that was escaped to prevent it being recognised as a real
   * token. Position-aware, not a global find-and-replace — only a run of escape chars immediately
   * preceding `<%` or `%>` is touched. An odd-length run means that boundary sequence itself was
   * escaped (one char consumed revealing it as literal text, the remaining even run collapses
   * pairwise); an even-length run means it wasn't (it still collapses pairwise, but the boundary
   * text is left alone). A run not immediately followed by a boundary sequence is never touched,
   * at any length — e.g. a literal backtick elsewhere in the text with no `<%`/`%>` next to it.
   */
  private static doDeEscapesIfRequired(deEscape: boolean, stringToProcess: string): string {
    let processedString = stringToProcess;

    if (deEscape && !StringUtils.isBlank(processedString)) {
      const boundarySequences = [this._startTokenChar, this._endTokenChar];
      let result = "";
      let i = 0;
      while (i < processedString.length) {
        if (processedString[i] !== this.EscapeChar) {
          result += processedString[i];
          i++;
          continue;
        }
        let runEnd = i;
        while (runEnd < processedString.length && processedString[runEnd] === this.EscapeChar) runEnd++;
        const runLength = runEnd - i;
        const followingBoundary = boundarySequences.find((boundary) => processedString.startsWith(boundary, runEnd));
        if (Utils.isUndefined(followingBoundary)) {
          result += processedString.slice(i, runEnd);
          i = runEnd;
          continue;
        }
        result += this.EscapeChar.repeat(Math.floor(runLength / 2));
        if (runLength % 2 === 1) {
          result += followingBoundary;
          i = runEnd + followingBoundary.length;
        } else {
          i = runEnd;
        }
      }
      processedString = result;
    }
    return processedString;
  }

  /**
   * When `escapeOutgoingTokens` is set ({@link Detokeniser.DoOptions.escapeOutgoingTokens}),
   * makes one final, blind pass over `text` — the fully-resolved, de-escaped, top-level result
   * about to be handed back to the original caller — and escapes every literal occurrence of
   * `<%`/`%>` it finds, regardless of how that occurrence got there (a de-escaped-and-revealed
   * token, or a handler having loaded file content that happens to contain the sequence
   * incidentally). Not provenance-tracked — deliberately, see this class's own "Escaping" doc
   * section — so a caller that's about to feed this result into a *later* `doAsync` call doesn't
   * have it misread as live token syntax there.
   */
  private static doEscapeOutgoingTokensIfRequired(escapeOutgoingTokens: boolean, text: string): string {
    if (!escapeOutgoingTokens) return text;
    return text
      .split(this._startTokenChar)
      .join(this.EscapeChar + this._startTokenChar)
      .split(this._endTokenChar)
      .join(this.EscapeChar + this._endTokenChar);
  }

  /**
   * Splits a token body into verb / qualifier / args. The verb ends at the first `(` or `|`,
   * whichever comes first; a `(` starts a qualifier, ending at the first unescaped `)` (no
   * nesting of its own structural characters — an inner `(` is literal — though a `<%...%>`
   * token written inside it has already been fully resolved to a marker by the time this runs,
   * since {@link Detokeniser.resolveTokens} always resolves inner frames before the outer one
   * closes); everything after the verb section is `args`, de-escaped the same way `<%`/`%>`
   * boundaries are, so a handler never has to deal with residual escape characters of its own.
   */
  private static parseVerbSection(token: string, markerTable: string[]): { verb: string; rawVerb: string; qualifier: string | undefined; args: string } {
    let qualifierOpenIndex = -1;
    let delimiterIndex = -1;
    for (let i = 0; i < token.length; i++) {
      if (token[i] === "(") {
        qualifierOpenIndex = i;
        break;
      }
      if (token[i] === this._delimiter) {
        delimiterIndex = i;
        break;
      }
    }

    if (qualifierOpenIndex === -1) {
      const verbText = delimiterIndex === -1 ? token : token.substring(0, delimiterIndex);
      const args = delimiterIndex === -1 ? "" : token.substring(delimiterIndex + 1);
      return {
        verb: verbText.toLowerCase().trim(),
        rawVerb: verbText,
        qualifier: undefined,
        args: this.doDeEscapesIfRequired(true, args),
      };
    }

    const verbText = token.substring(0, qualifierOpenIndex);
    let qualifier = "";
    let i = qualifierOpenIndex + 1;
    let closed = false;
    while (i < token.length) {
      if (token[i] === this.EscapeChar && i + 1 < token.length) {
        qualifier += token[i + 1];
        i += 2;
        continue;
      }
      if (token[i] === ")") {
        closed = true;
        i++;
        break;
      }
      qualifier += token[i];
      i++;
    }
    if (!closed) {
      throw new MalformedTokenSyntaxError(
        `Unterminated '(' in verb qualifier of token [${this.resolveMarkersInText(markerTable, token)}] — expected a closing ')'.`
      );
    }
    const rawVerb = token.substring(0, i);
    let args = "";
    if (i < token.length) {
      if (token[i] !== this._delimiter) {
        throw new MalformedTokenSyntaxError(
          `Malformed token [${this.resolveMarkersInText(markerTable, token)}] — expected [${this._delimiter}] or end of string immediately after the verb qualifier, got [${token[i]}].`
        );
      }
      args = token.substring(i + 1);
    }
    return {
      verb: verbText.toLowerCase().trim(),
      rawVerb,
      qualifier,
      args: this.doDeEscapesIfRequired(true, args),
    };
  }

  /**
   * Tries each handler in `handlers` — the user-registered callbacks for one specific verb — in
   * **reverse** order (most-recently-registered first), awaiting each regardless of sync/async,
   * returning the first non-`undefined` result. A handler throwing here is logged and treated
   * the same as "returned undefined" — one buggy user callback shouldn't block every other
   * callback (or the built-in) registered for the same verb. Deliberately NOT used for the
   * built-in handler itself (see {@link Detokeniser.doToken}) — a built-in throwing means it's
   * already recognised the verb as its own and found the arguments invalid, which must propagate
   * directly, not get swallowed into a generic "unsupported token" message.
   */
  private static async tryHandlers(handlers: Array<Detokeniser.Callback> | undefined, context: Detokeniser.VerbContext): Promise<string | undefined> {
    if (!handlers) return undefined;
    for (let index = handlers.length - 1; index >= 0; index--) {
      try {
        const result = await Promise.resolve(handlers[index](context));
        if (!Utils.isNullOrUndefined(result)) return result;
      } catch (e) {
        Log.writeLine(LogLevels.Error, `Error processing callback (ignoring and setting response to undefined): ${Utils.errorMessage(e)}`);
      }
    }
    return undefined;
  }

  /**
   * Resolves a single token body: parse verb/qualifier/args once, try every user-registered
   * callback for that verb (most-recently-registered first), then the single built-in handler
   * for that verb (if any), throwing if nothing matched. Then — see this class's own "Nesting"
   * doc section — recursively resolves any unescaped token syntax the handler's own return value
   * freshly introduced, one `depth` deeper, before returning. Logs one `TestDebug` line pairing
   * this token's own raw text with its own (marker-resolved, for readability) final value.
   */
  private static async doToken(token: string, options: Detokeniser.DoOptions, markerTable: string[], depth: number): Promise<string> {
    if (!token) {
      throw new MalformedTokenSyntaxError("Empty token!  Token must be populated.");
    }

    const { verb, rawVerb, qualifier, args } = this.parseVerbSection(token, markerTable);
    const context: Detokeniser.VerbContext = {
      verb,
      rawVerb,
      qualifier,
      args,
      delimiter: this.delimiter,
      escapeChar: this.EscapeChar,
      tokenStart: this._startTokenChar,
      tokenEnd: this._endTokenChar,
      options,
      resolveMarkers: (text: string) => this.resolveMarkersInText(markerTable, text),
    };

    let processedToken = await this.tryHandlers(this._userCallbacks?.get(verb), context);
    if (Utils.isNullOrUndefined(processedToken)) {
      const builtinHandler = this._builtinCallbacks.get(verb);
      if (builtinHandler) {
        processedToken = await Promise.resolve(builtinHandler(context));
      }
    }

    if (Utils.isNullOrUndefined(processedToken)) {
      // Resolved for display — verb/token may themselves contain an internal marker (e.g. a
      // genuine nested token sitting next to incidental <%/%> adjacency, such as a 2D JSON
      // array, that together got misparsed as one bogus verb) — a human reading this error
      // must see the real, resolved text, never raw, invisible marker sentinel characters.
      throw new MalformedTokenSyntaxError(
        `Unsupported token [${this.resolveMarkersInText(markerTable, verb)}] — no registered callback or built-in claims this verb ` +
        `(token was [${this._startTokenChar}${this.resolveMarkersInText(markerTable, token)}${this._endTokenChar}]).`
      );
    }

    // The handler's own return value may itself contain fresh, unescaped token syntax (e.g. a
    // self-correcting handler) — resolve it the same way as any other nesting, one level
    // deeper. Skipped entirely when there's plainly nothing to resolve, the overwhelmingly
    // common case, both as an optimisation and so `depth` only grows when something real is
    // actually being recursed into.
    //
    // Unlike every other call to resolveTokens, a MalformedTokenSyntaxError from THIS one is
    // deliberately swallowed — see that error class's own doc comment for why: this text is a
    // handler's own generated output, not something a tester typed, so "doesn't look like a
    // real token" here means "wasn't really fresh token syntax after all", not "a mistake
    // worth failing the test over". A RecursionDepthExceededError (or anything else — a
    // handler's own thrown validation error) still propagates untouched.
    if (processedToken.includes(this._startTokenChar)) {
      try {
        processedToken = await this.resolveTokens(processedToken, options, markerTable, depth + 1);
      } catch (err) {
        if (!(err instanceof MalformedTokenSyntaxError)) throw err;
        Log.writeLine(
          LogLevels.Warning,
          `Handler for verb [${verb}] returned a value containing [${this._startTokenChar}] that didn't resolve to a ` +
          `real, well-formed token (${Utils.errorMessage(err)}) — using its output literally rather than failing.`
        );
      }
    }

    const rawToken = `${this._startTokenChar}${token}${this._endTokenChar}`;
    Log.writeLine(
      LogLevels.TestDebug,
      `Processed [${StringUtils.truncateIfNeeded(rawToken, LOG_TOKEN_TRUNCATE_LENGTH)}] to [${StringUtils.truncateIfNeeded(this.resolveMarkersInText(markerTable, processedToken), LOG_TOKEN_TRUNCATE_LENGTH)}]`
    );
    return processedToken;
  }

  /**
   * Determines whether the boundary sequence (`<%` or `%>`) starting at `positionToTest` in
   * `fullString` is escaped, by counting the run of consecutive escape characters immediately
   * before it: an odd count means the boundary itself is escaped, an even count means it's not.
   * Used by {@link Detokeniser.resolveTokens} to decide whether a candidate `<%`/`%>` is real
   * token syntax or literal text — de-escaping itself happens later, once, in
   * {@link Detokeniser.doDeEscapesIfRequired}; this method only ever decides, never mutates.
   */
  private static isEscaped(fullString: string, positionToTest: number): boolean {
    let index: number;
    let escapeCharCount = 0;
    let returnIsEscaped = false;

    if (positionToTest > 0) {
      index = positionToTest;
      while (!(--index < 0)) {
        if (fullString[index] == this.EscapeChar) {
          escapeCharCount++;
        } else {
          break;
        }
      }
      if (escapeCharCount % 2 == 1) {
        returnIsEscaped = true;
      }
    }
    return returnIsEscaped;
  }
}

// ─── Detokeniser types ────────────────────────────────────────────────────────

/**
 * Everything a verb handler needs, parsed once by the engine before any handler is called.
 */
export interface Detokeniser_VerbContext {
  /** The matched verb, lowercased/trimmed — e.g. `"date"`. */
  verb: string;
  /**
   * The verb section exactly as written, unparsed — e.g. `"date"` or `"date(nsw)"`. A safety
   * net: use this if a handler needs to see the literal text rather than trust the engine's own
   * `verb`/`qualifier` split.
   */
  rawVerb: string;
  /** Content of `verb(...)`, if the token had a qualifier — `undefined` otherwise. May contain
   *  unresolved markers — see {@link Detokeniser_VerbContext.resolveMarkers}. */
  qualifier: string | undefined;
  /**
   * Everything after the verb section, already de-escaped. Handler-specific shape. May contain
   * unresolved markers standing in for a nested token's resolved value — see
   * {@link Detokeniser_VerbContext.resolveMarkers}. Safe to split on {@link
   * Detokeniser_VerbContext.delimiter} (or any other convention — quotes, parens) without a
   * marker ever being mistaken for a structural character; not safe to use its content directly
   * (e.g. as a timezone name, a number) without resolving markers in it first.
   */
  args: string;
  /**
   * The current {@link Detokeniser.delimiter}. A handler that splits `args` into further parts
   * itself must split on this, not a hardcoded `"|"`.
   */
  delimiter: string;
  /**
   * The engine's current escape character (`` ` `` by default — see {@link Detokeniser}'s own
   * "Escaping" doc section). A handler that does its own escape-aware sub-parsing of a piece it
   * extracted from `args`/`qualifier` (e.g. recognising an escaped literal `)` inside a
   * parenthesised sub-argument) must use this, not a hardcoded character — otherwise it silently
   * drifts out of sync the moment this value changes, exactly the bug that motivated adding this
   * field (`randomBuiltins.ts`'s `parseParenContent` used to hardcode `/`).
   */
  escapeChar: string;
  /**
   * The engine's current open/close boundary sequence — `<%`/`%>` by default, or whichever of
   * {@link Detokeniser._allowedTokenStartStops}'s other members a caller has set. Every
   * error message a handler throws that illustrates the expected token shape (e.g. "needs 2
   * parts, like X") must build that illustration from these, never from a hardcoded `[[`/`]]`
   * or `<%`/`%>` — otherwise the message shows a boundary that isn't the one actually active,
   * confusing a tester who correctly used the live one and just got a mismatched example back.
   */
  tokenStart: string;
  tokenEnd: string;
  /**
   * Substitutes any `<open><digits><close>` marker found in `text` with its real, original
   * value — see {@link Detokeniser}'s own "Opacity" doc section. Call this on a piece extracted
   * from `args`/`qualifier` *after* any splitting of your own, immediately before using that
   * piece's actual content (parsing it as a number, passing it to an API, measuring its length)
   * — never *before* splitting, which would reopen the exact corruption this scheme exists to
   * prevent. A handler that never inspects content (just reshuffles opaque blobs) never needs to
   * call this at all — unresolved markers in a handler's own return value are resolved
   * automatically by the engine.
   */
  resolveMarkers: (text: string) => string;
  /** The same {@link Detokeniser.DoOptions} the caller passed to {@link Detokeniser.doAsync}. */
  options: Detokeniser.DoOptions;
}

/**
 * Signature for a handler registered via {@link Detokeniser.addCallback}. Every built-in verb
 * handler is implemented with this same shape. May be synchronous or asynchronous —
 * {@link Detokeniser.doAsync} always awaits the result either way.
 *
 * @param context - See {@link Detokeniser.VerbContext}.
 * @returns The replacement string, a Promise resolving to it, or `undefined` to pass to the next
 *   handler registered for this verb.
 */
export interface Detokeniser_Callback {
  (context: Detokeniser.VerbContext): string | undefined | Promise<string | undefined>;
}

/**
 * Options passed to {@link Detokeniser.doAsync}.
 */
export interface Detokeniser_DoOptions {
  /**
   * Key/value pairs made available to `<%setting|profileParameterName: "key"%>` tokens.
   * @example { username: 'alice', environment: 'staging' }
   */
  contextParameters?: Record<string, unknown>;

  /**
   * Whether escaped token-boundary sequences (`` `<% ``, `` `%> ``) are de-escaped once every
   * token in this call has been resolved. Defaults to `true`. Pass `false` for any intermediate
   * resolution whose output gets its own final `doAsync` pass further down the pipeline, so
   * escape sequences survive untouched for that later, designated pass to resolve exactly once.
   */
  deEscape?: boolean;

  /**
   * When `true`, after everything else is done (marker resolution, recursive resolution,
   * de-escaping), makes one final pass over the top-level result and escapes every literal
   * `<%`/`%>` it finds — see {@link Detokeniser}'s own "Escaping" doc section. Defaults to
   * `false`. Use when this result is about to be fed into a *later* `doAsync` call and must not
   * be misread as live token syntax there.
   */
  escapeOutgoingTokens?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Detokeniser {
  export type Callback = Detokeniser_Callback;
  export type VerbContext = Detokeniser_VerbContext;
  export type DoOptions = Detokeniser_DoOptions;
}
