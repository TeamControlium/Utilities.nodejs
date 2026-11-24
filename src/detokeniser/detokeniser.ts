import { Log, LogLevels, StringUtils, Utils } from "../index.js";
import { builtinDate, builtinDiff, builtinTimezone } from "./dateBuiltins.js";
import { builtinBase64, builtinJWT } from "./encodingBuiltins.js";
import { builtinMockRequests } from "./mockingBuiltins.js";
import { builtinRandom } from "./randomBuiltins.js";
import { builtinSetting } from "./systemBuiltins.js";

/**
 * Thrown by {@link Detokeniser.doToken} specifically when nothing — no registered callback,
 * no built-in — claims the matched verb at all. A dedicated type, not a plain `Error`, so
 * {@link Detokeniser.resolveTokens} can tell this one case apart from every other way
 * resolving a token can fail (a callback/built-in that *did* recognise the verb, then
 * rejected its arguments) without string-matching an error message — brittle, and the kind of
 * thing a future wording change would silently break.
 *
 * Why this distinction matters: an unrecognised verb is the exact, unavoidable symptom of two
 * completely different situations that look identical from here — a genuinely malformed `[[`/
 * `]]` pair that was never a token at all (most realistically incidental, unrelated `[[`/`]]`
 * adjacency in surrounding literal data, e.g. a JSON nested array like `[[1,2],[3,4]]`), or a
 * test author's genuine typo in a real verb name (`[[radnom|digits|4]]`). `resolveTokens`
 * resolves that ambiguity in favour of the former — treating the whole matched span as literal,
 * unresolved text rather than throwing — a deliberate trade, not a default: it accepts that a
 * genuine verb-name typo now fails silently (the literal, unresolved token text flows straight
 * through, with only a `Warning`-level log to notice it by) in exchange for literal `[[`/`]]`
 * adjacency anywhere in untouched, unrelated data no longer breaking detokenisation outright.
 * See `utils/docs/design/detokeniser-structural-parsing-redesign.md`'s "third gap" section for
 * the full reasoning and the alternatives considered.
 */
class UnsupportedTokenError extends Error {}

/**
 * Max length {@link Detokeniser.doAsync}'s own top-level `TestDebug` logging truncates the raw
 * string to, via {@link StringUtils.truncateIfNeeded}, for the single-line "no tokens found"
 * case — short, since nothing was actually resolved, there's nothing further worth showing.
 */
const LOG_NO_TOKEN_TRUNCATE_LENGTH = 48;

/**
 * Max length {@link Detokeniser.doToken}'s own per-token `TestDebug` logging truncates the raw
 * token text and its resolved value to, independently, via {@link StringUtils.truncateIfNeeded}
 * — one line per token actually resolved, e.g. `Processed [[[jwt;...]]] to [eyJ...]`, so a
 * multi-token string gets one clearly-paired line per token rather than one undifferentiated
 * before/after dump of the whole string.
 */
const LOG_TOKEN_TRUNCATE_LENGTH = 64;

/**
 * Processes strings containing tokens in the format `[[verb|arg|arg]]`, replacing each token
 * with its resolved value. Tokens can be nested — the innermost is always resolved first.
 *
 * This file is the resolution *engine* only: token-boundary scanning, escaping, the
 * innermost-first resolve loop, and the verb/qualifier/args dispatch mechanism. The built-in
 * verbs themselves (`random`/`date`/`timezone`/`diff`/`setting`/`base64`/`jwt`/
 * `mockintercepts`) live in sibling files, grouped by what they do — `randomBuiltins.ts`,
 * `dateBuiltins.ts`, `systemBuiltins.ts`, `encodingBuiltins.ts`, `mockingBuiltins.ts` — see
 * each one's own doc comment for the verbs it implements and their syntax.
 *
 * ## Token syntax
 * ```
 * [[verb|arg|arg]]
 * [[verb(qualifier)|arg|arg]]
 * ```
 * - **verb** — identifies which registered handler resolves this token (see "Dispatch" below)
 * - **qualifier** — optional, parenthesised text immediately after the verb, with no delimiter
 *   before it (e.g. `date(nsw)`). Not interpreted by the engine at all — it's handed to
 *   whichever handler matches `verb`, for that handler to interpret however it likes (e.g. a
 *   business-day-aware `date` callback might use a qualifier to select a public-holiday
 *   calendar). None of the built-in verbs use one today.
 * - **arg** — handler-specific, `|`-delimited (each built-in's own file documents its shape)
 *
 * ### Qualifier parsing
 * A qualifier is only recognised if `(` immediately follows the verb name, with nothing in
 * between. Its content is everything up to the first *unescaped* `)` — not nesting-aware,
 * the same rule several built-ins already use for their own paren-delimited arguments (e.g.
 * `random|from(...)`): an inner `(` is just a literal character with no special meaning, only
 * the first unescaped `)` ends it. A literal `)` inside a qualifier needs the escape char
 * (`/)`), same as everywhere else in this grammar. An unterminated `(` (no closing `)` found
 * before the end of the token) throws a clear error rather than guessing what was meant.
 *
 * ```
 * date(nsw)|addWorkingDays(7)|dd/MM/yyyy   → verb "date", qualifier "nsw"
 * someverb(ddd(sd)|arg1|arg2               → verb "someverb", qualifier "ddd(sd" (first
 *                                             unescaped ")" ends it — the earlier "(" is just
 *                                             literal qualifier text, not nesting)
 * ```
 *
 * ---
 * ## Nesting
 * Tokens are resolved innermost-first, so nested tokens compose naturally:
 * ```typescript
 * // Date N random days from now, where N is itself a random digit
 * await Detokeniser.doAsync('[[date|addDays([[random|digits|1]])|dd-MM-yyyy]]');
 *
 * // Hours between Lusaka and London, right now
 * await Detokeniser.doAsync('[[diff|[[timezone|Africa/Lusaka]]|[[timezone|Europe/London]]]]');
 * ```
 *
 * ---
 * ## Escaping
 * The escape character is `/`, fixed — `EscapeChar` is a private implementation detail, not
 * a public setting. Escaping only has any effect
 * immediately before a token boundary sequence (`[[` or `]]`) — a run of escape chars
 * anywhere else in the string (e.g. the `//` in `https://example.com`) is left completely
 * untouched, not collapsed. This is deliberate: an escape character's only job is resolving
 * an actual conflict with token syntax, not globally "meaning" something everywhere it
 * appears — same as `\\` in a C-family string literal, or POSIX shell's backslash inside
 * double quotes, both of which only have special meaning immediately before a recognised
 * character, never as a context-free find-and-replace over the whole string.
 *
 * | Input | Output | Notes |
 * |---|---|---|
 * | `/[[` | `[[` | Literal `[[` — not treated as token start |
 * | `/]]` | `]]` | Literal `]]` — not treated as token end |
 * | `//[[` | `/[[` | Escaped escape char, followed by a real token start |
 * | `https://example.com` | `https://example.com` | `//` here is nowhere near `[[`/`]]` — left alone, not collapsed |
 *
 * De-escaping normally happens automatically at the end of {@link Detokeniser.doAsync} — pass
 * `{ deEscape: false }` ({@link Detokeniser.DoOptions.deEscape}) to defer it, when this call's
 * output will be detokenised again later and escape sequences need to survive intact for that
 * later, final pass.
 *
 * ---
 * ## Dispatch — built-ins are callbacks too
 * Every built-in verb is registered into {@link Detokeniser._builtinCallbacks} the same shape
 * {@link Detokeniser.addCallback} registers a custom one into — a built-in isn't a privileged
 * special case, it's just always present. Resolving a token tries, in order:
 * 1. Every callback registered for that verb via {@link Detokeniser.addCallback}, most
 *    recently registered first — so a callback can deliberately override an earlier one, or
 *    override a built-in of the same verb name.
 * 2. The built-in registered for that verb, if any.
 *
 * A callback declines by returning `undefined`, passing to the next one tried. If nothing
 * claims the verb at all, {@link Detokeniser.resolveTokens} treats the whole matched `[[...]]`
 * span as literal, unresolved text (logged at `Warning`) rather than throwing — see
 * {@link UnsupportedTokenError}'s own doc comment for why.
 *
 * {@link Detokeniser.doAsync} is the only entry point — it always awaits every callback, sync
 * or async, so there's no separate sync method whose caller would need to know in advance
 * whether every token a test might pass in resolves synchronously or not.
 *
 * @see {@link Detokeniser.addCallback}
 * @see {@link Detokeniser.doAsync}
 */
export class Detokeniser {
  private static readonly _endTokenChar = "]]";
  private static readonly _startTokenChar = "[[";
  private static EscapeChar = "/";
  private static _delimiter = "|";

  /**
   * The only characters a caller may set {@link Detokeniser.delimiter} to. Deliberately an
   * allow-list, not a deny-list of "known bad" characters: several structurally-significant
   * characters are already baked into the grammar in ways that are easy to forget all of —
   * `[`/`]` (token boundaries), `(`/`)` (the qualifier syntax, and several built-ins' own
   * sub-grammar — `date`'s `addDays(n)`, `random`'s `from(...)`/`float(min,max)`), `/` (the
   * escape char), `,` (several built-ins' own sub-argument separator — `random|float(min,max)`,
   * `date|random(fromEpoch,toEpoch)`, `date|followingDay(epoch,dayName)`), and `'`/`"` (the
   * quoting convention `jwt`/`base64`/`diff` already rely on to protect a literal delimiter
   * character inside a value). A deny-list would mean every future built-in's own syntax is a
   * fresh, undocumented way to silently re-break the delimiter feature; an allow-list keeps it
   * safe by construction regardless of what any future verb introduces.
   *
   * Narrowed further than just "whatever's left", to non-alphanumeric punctuation only — a
   * letter/digit delimiter doesn't break the grammar, but reopens the same class of problem
   * from the opposite direction: a character that routinely shows up as *data* inside a
   * resolved value (e.g. almost any letter or digit appears somewhere in typical base64
   * output) is a live footgun even with escaping available, since nobody escapes content they
   * don't know is there. A space is deliberately included — unusual, but a caller's own choice
   * to make, and it doesn't collide with anything.
   */
  private static readonly _allowedDelimiters = new Set([" ", "|", ";", ":", "~", "^", "!", "?", "&"]);

  // User-registered callbacks, keyed by verb (lowercased/trimmed). Lazily created on first
  // addCallback call — most consumers never register one at all, so this stays undefined
  // (not an empty Map) until needed. Cleared by resetCallbacks()/reset() — test/suite state,
  // not framework capability, per the "100% clean start every test" guarantee those two
  // methods exist to provide.
  private static _userCallbacks: Map<string, Array<Detokeniser.Callback>> | undefined = undefined;

  // Built-in verb handlers, keyed by verb. Framework capability, not test state — untouched
  // by reset()/resetCallbacks(). Tried by doToken only after every _userCallbacks entry
  // registered for that same verb has had a turn.
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
   * Master on/off switch for token processing. When `false`, {@link Detokeniser.doAsync}
   * returns its input completely unchanged — no scanning, no error on malformed token
   * syntax, nothing. A plain public field (not a getter/setter
   * pair) deliberately — same shape as `Logger.loggingLevel`, settable at any time by any
   * caller, including mid-test, e.g. a Cucumber step like `Given Detokeniser is disabled`.
   *
   * This exists as the deliberate, explicit escape hatch for a caller that wants a value
   * passed straight through with zero processing, no matter what it contains — a second,
   * coarser mechanism alongside per-occurrence character-escaping within a string, for a
   * caller that doesn't want to escape every token-like substring individually.
   *
   * @default true
   * @see {@link Detokeniser.reset} — restores this to `true`, among other defaults. Any
   *   consumer resetting per-test (as this project's test-runner drivers do, in
   *   `@controlium/framework`'s own `afterTest()`) gets this reset for free, automatically,
   *   per [[feedback_test_atomicity_non_negotiable]] — a test that turns this off must never
   *   be able to leak that into whatever test runs next.
   */
  public static enabled = true;

  /**
   * The character that separates a verb (and optional qualifier) from its arguments, and
   * separates one argument from the next — e.g. the `|`s in `[[random|digits|6]]`. A getter/
   * setter pair, not a plain field like {@link Detokeniser.enabled}: unlike a boolean, a bad
   * value here (multi-character, or one of the handful of characters already structurally
   * significant elsewhere in the grammar) can't just be tolerated — it needs rejecting
   * immediately, at the point it's set, not discovered later as a confusing parse failure deep
   * inside some unrelated token.
   *
   * Still plain-assignable, exactly like `enabled` — `Detokeniser.delimiter = ';'` — a caller
   * never needs to call a separate method; the validation is just transparent to that syntax.
   *
   * Restricted to a fixed allow-list ({@link Detokeniser._allowedDelimiters} — see its own doc
   * comment for the full reasoning): `|` (the default), space, `;`, `:`, `~`, `^`, `!`, `?`,
   * `&`. Every character outside that list either already means something else in this
   * grammar (`[`/`]`/`(`/`)`/`/`/`,`/`'`/`"`) or is a letter/digit that would routinely collide
   * with ordinary resolved-value content (e.g. base64 output).
   *
   * @throws {Error} If set to anything other than a single character from the allow-list.
   * @default "|"
   * @see {@link Detokeniser.reset} — restores this to `"|"`, among other defaults.
   * @example
   * Detokeniser.delimiter = ';'; // e.g. in a Cucumber Before hook, to avoid a DataTable's own
   *                               // use of '|' as a column separator colliding with a token's
   * Detokeniser.delimiter = '('; // throws — '(' is already the qualifier/sub-grammar character
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
   * Resets the Detokeniser to factory defaults:
   * - {@link Detokeniser.enabled} restored to `true`
   * - {@link Detokeniser.delimiter} restored to `"|"`
   * - Escape char restored to `/`
   * - All user-registered callbacks cleared
   *
   * Call this in test teardown to guarantee a clean state between scenarios.
   * @example
   * afterEach(() => Detokeniser.reset());
   */
  public static reset() {
    this.enabled = true;
    this.delimiter = "|";
    this.EscapeChar = "/";
    this._userCallbacks = undefined;
  }

  /**
   * Registers a custom handler for `verb`. Both sync and async handlers are registered via
   * this method and share the same per-verb callback list.
   *
   * Handlers registered for the same verb are tried in **reverse** registration order
   * (most-recently-registered first) — so the latest one wins among several, and any of them
   * can override a built-in of the same verb name (built-ins are only tried after every
   * registered callback for that verb has declined). Return `undefined` to pass to the next
   * handler; an error is thrown if nothing matches at all.
   *
   * @param verb - The verb this handler resolves, e.g. `"charcode"` for `[[charcode|...]]`
   *   tokens. Matched case-insensitively, trimmed.
   * @param callback - `(context: Detokeniser.CallbackContext) => string | undefined | Promise<string | undefined>`
   *   — see {@link Detokeniser.CallbackContext} for what's available on `context`
   *
   * @example
   * // Handler for [[charcode|A|hex]] tokens — splits on `delimiter`, not a hardcoded '|', so
   * // it keeps working if a caller has changed Detokeniser.delimiter.
   * Detokeniser.addCallback('charcode', ({ args, delimiter }) => {
   *   const [char, base] = args.split(delimiter);
   *   const code = char.charCodeAt(0);
   *   return base === 'hex' ? code.toString(16) : String(code);
   * });
   * await Detokeniser.doAsync('[[charcode|A|hex]]'); // → '41'
   *
   * @example
   * // Async handler reading options.contextParameters
   * Detokeniser.addCallback('fromContext', ({ args, options }) => {
   *   return String(options.contextParameters?.[args] ?? '');
   * });
   *
   * @see {@link Detokeniser.resetCallbacks} to remove all registered callbacks
   * @see {@link Detokeniser.doAsync}
   */
  public static addCallback(verb: string, callback: Detokeniser.Callback) {
    Utils.assertType(verb, "string", "Detokeniser.addCallback", "verb");
    Utils.assertType(callback, "function", "Detokeniser.addCallback", "callback");
    const key = verb.toLowerCase().trim();
    // Lazily create the Map on first registration, and the per-verb array on first
    // registration for that specific verb.
    if (!this._userCallbacks) {
      this._userCallbacks = new Map<string, Array<Detokeniser.Callback>>();
    }
    if (!this._userCallbacks.has(key)) {
      this._userCallbacks.set(key, []);
    }
    // Append — tryHandlers below tries this list in REVERSE order, so the most recently
    // registered callback for this verb is the first one tried.
    this._userCallbacks.get(key)!.push(callback);
  }

  /**
   * Removes all user-registered callbacks. Built-in handlers live in
   * {@link Detokeniser._builtinCallbacks}, untouched by this method.
   * Use between tests or scenarios to ensure callback isolation.
   * @see {@link Detokeniser.reset} to also restore all defaults
   */
  public static resetCallbacks() {
    this._userCallbacks = undefined;
  }

  /**
   * Resolves all tokens in the given string and returns a Promise of the result. This is the
   * single, sole entry point — every built-in token type is fully synchronous internally, but
   * this always awaits any registered callback that returns a `Promise`, so a caller never
   * needs to know in advance whether the particular tokens a given string happens to contain
   * will all resolve synchronously or not. Calling code — especially in a test framework,
   * where the actual token content is often test-author-supplied data rather than something
   * the calling code itself controls — invariably can't know that in advance, so a separate
   * sync method would be a standing trap: it would silently skip any async callback, with no
   * error, the moment a test happened to need one.
   *
   * @param tokenisedString - String potentially containing `[[...]]` tokens
   * @param options - Optional processing options — see {@link Detokeniser.DoOptions},
   *   including {@link Detokeniser.DoOptions.deEscape} for deferring de-escaping to a later pass
   * @returns Promise resolving to the input string with all tokens replaced
   * @throws If any token is malformed, unsupported, or a callback throws
   *
   * @example
   * await Detokeniser.doAsync('Ref-[[random|digits|6]]');                        // → e.g. 'Ref-482910'
   * await Detokeniser.doAsync('Expires [[date|addDays(30)|dd/MM/yyyy]]');        // → e.g. 'Expires 01/05/2026'
   *
   * @example
   * // Nested tokens — innermost resolved first
   * await Detokeniser.doAsync('[[date|addDays([[random|digits|1]])|dd-MM-yyyy]]');
   *
   * @example
   * // Context parameters for [[setting|...]] tokens
   * await Detokeniser.doAsync('Hello [[setting|profileParameterName: "username"]]', {
   *   contextParameters: { username: 'Alice' }
   * }); // → 'Hello Alice'
   *
   * @example
   * // Escaping — produce literal [[ / ]] in output
   * await Detokeniser.doAsync('Press /[[Enter/]] to continue'); // → 'Press [[Enter]] to continue'
   *
   * ## Debug logging
   * If `tokenisedString` contains `[[` anywhere, each token actually resolved is logged
   * individually, once, by {@link Detokeniser.doToken} — one `TestDebug` line per token,
   * pairing its own raw text with its own resolved value (see that method's doc comment),
   * so a multi-token string gets one clearly-paired line per token rather than one
   * undifferentiated dump of the whole input and the whole output. Otherwise (no `[[` at all),
   * this method itself logs a single line: `Processed [<tokenisedString, truncated>], no
   * tokens found` — logged exactly once per call here in `doAsync` itself, never inside
   * {@link Detokeniser.resolveTokens} (the actual scan), since that method has no equivalent
   * notion of "a call" to guard against double-logging — it's a single pass, not recursive.
   * The `[[`-presence check this relies on is a cheap substring test, not real
   * parsing — see {@link Detokeniser.doToken}'s own doc comment for the one edge case that
   * follows from that (an escaped-only or unterminated `[[` logs nothing at all, rather than
   * "no tokens found" — the presearch says tokens might be present, but none actually resolve).
   */
  public static async doAsync(tokenisedString: string, options: Detokeniser.DoOptions = {}): Promise<string> {
    // Master on/off switch — when disabled, return the input completely unchanged.
    if (!this.enabled) return tokenisedString;

    // A non-string input is never valid — but the [[-presence check just below assumes a
    // string to call .includes on, so a bad type must be deferred to doResolve's own
    // Utils.assertType (inside its try/catch) before this method does anything else with it.
    if (typeof tokenisedString !== "string") {
      return this.doResolve(tokenisedString, options);
    }

    // No "[[" anywhere at all — resolveTokens' scan will never find a token to hand to
    // doToken, so nothing will log anything for this call unless this method does. See this
    // method's own "Debug logging" doc section above for why this specific check (rather than,
    // say, comparing the final result to the input) is what decides this.
    if (!tokenisedString.includes(this._startTokenChar)) {
      Log.writeLine(LogLevels.FrameworkInformation, `Processed [${StringUtils.truncateIfNeeded(tokenisedString, LOG_NO_TOKEN_TRUNCATE_LENGTH)}], no tokens found`);
    }

    return this.doResolve(tokenisedString, options);
  }

  /**
   * Wraps {@link Detokeniser.resolveTokens} — the actual scan — with type validation, error
   * context, and the final de-escape pass. Factored out from {@link Detokeniser.doAsync}
   * purely so that method's own "no tokens found" check fires exactly once per real external
   * call. Not part of this class's public API.
   */
  private static async doResolve(tokenisedString: string, options: Detokeniser.DoOptions = {}): Promise<string> {
    try {
      // tokenisedString must actually be a string — fail fast and clearly if not.
      Utils.assertType(tokenisedString, "string", "Detokeniser.doAsync", "tokenisedString");
      const resolved = await this.resolveTokens(tokenisedString, options);
      // Single pass, no recursion — de-escaping runs exactly once here, gated only by the
      // caller's own preference (defaults to true). See {@link Detokeniser.DoOptions.deEscape}.
      return this.doDeEscapesIfRequired(options.deEscape ?? true, resolved);
    } catch (err: unknown) {
      // Wrap whatever failed (bad token syntax, a callback throwing, etc.) with the original
      // input string for context, log it, then re-throw as a plain Error.
      const errText = `Error processing [${tokenisedString}]: ${Utils.errorMessage(err)}`;
      Log.writeLine(LogLevels.Error, errText);
      throw Error(errText);
    }
  }

  /**
   * The resolution engine behind {@link Detokeniser.doAsync} — see
   * `utils/docs/design/detokeniser-structural-parsing-redesign.md` for the full design
   * reasoning (this replaces a prior "find the innermost [[/]] pair, resolve it, splice the
   * result back in, then re-scan the whole combined string for the next one" design, which
   * had two injection-class bugs: a resolved value's delimiter corrupting a verb's own
   * argument split, and — the one this method exists to fix — a resolved value's own `[[`/`]]`
   * corrupting that re-scan, since the scan couldn't tell a verb's literal output apart from
   * genuine token syntax the test author wrote).
   *
   * A single left-to-right pass over the *original* tokenisedString, using a stack of
   * not-yet-closed `[[` positions:
   * - An unescaped `[[` pushes a new, empty frame.
   * - An unescaped `]]` pops the innermost open frame and resolves its accumulated body via
   *   {@link Detokeniser.doToken} immediately — awaited, so an async callback works exactly as
   *   before. The resolved value is appended to whichever frame is now on top of the stack (if
   *   any — that's nesting: the inner token's result becomes literal text inside the still-open
   *   outer token's own argument string) or to the main output if the stack is now empty (a
   *   top-level token).
   * - Every other character — including an escape char not immediately preceding a boundary,
   *   or one that is but doesn't actually escape anything the scan cares about here — is
   *   copied straight into whichever buffer is current, unchanged. De-escaping is deliberately
   *   not interleaved into this scan at all; it happens once, after this method returns, in
   *   {@link Detokeniser.doDeEscapesIfRequired} — exactly the same separation `doAsync` already
   *   had.
   *
   * The reason this closes off the bug this method replaces: a resolved value is only ever
   * written into a buffer. It is never handed back to anything that looks for `[[`/`]]` in it —
   * there is no re-scan step left for it to be misread by, regardless of what characters it
   * happens to contain.
   *
   * Malformed input is tolerated the same way the prior design was, not turned into a new class
   * of error: a `[[` that's never closed by a matching `]]` anywhere later in the string folds
   * back into the surrounding text as plain, unresolved literal content once the scan reaches
   * the end (see the trailing while loop below) — same as the prior design silently leaving an
   * unterminated `[[` as literal text. A stray, unescaped `]]` with nothing open on the stack to
   * close is likewise just literal text, not an error.
   *
   * A complete, correctly-matched `[[...]]` pair whose verb nothing claims is tolerated the
   * same way, deliberately, as of the "a third gap" fix in
   * `utils/docs/design/detokeniser-structural-parsing-redesign.md` — see
   * {@link UnsupportedTokenError}'s own doc comment for the full reasoning and the trade-off
   * it accepts.
   */
  private static async resolveTokens(tokenisedString: string, options: Detokeniser.DoOptions): Promise<string> {
    interface OpenFrame {
      buffer: string;
    }

    const stack: OpenFrame[] = [];
    let mainOutput = "";

    // Appends resolved or literal text to whichever buffer is "current" right now — the
    // innermost still-open frame's, or the main output if nothing is currently open.
    const appendCurrent = (text: string): void => {
      if (stack.length > 0) stack[stack.length - 1].buffer += text;
      else mainOutput += text;
    };

    let index = 0;
    while (index < tokenisedString.length) {
      if (tokenisedString.startsWith(this._startTokenChar, index) && !this.isEscaped(tokenisedString, index)) {
        // Opens a new frame — everything from here until its own matching `]]` (if any)
        // accumulates into this frame's own buffer, not the one that was current before it.
        stack.push({ buffer: "" });
        index += this._startTokenChar.length;
        continue;
      }
      if (tokenisedString.startsWith(this._endTokenChar, index) && !this.isEscaped(tokenisedString, index)) {
        if (stack.length === 0) {
          // No open frame to close — this `]]` was never a real boundary; just literal text.
          appendCurrent(this._endTokenChar);
          index += this._endTokenChar.length;
          continue;
        }
        // Closes the innermost open frame — resolve its accumulated body now, then route the
        // result per this method's own doc comment above.
        const closedFrame = stack.pop()!;
        const matchedSpan = this._startTokenChar + closedFrame.buffer + this._endTokenChar;
        let resolvedValue: string;
        try {
          resolvedValue = await this.doToken(closedFrame.buffer, options);
        } catch (err) {
          // Nothing claimed this verb at all — see UnsupportedTokenError's own doc comment
          // for why this one case (and only this one) falls back to literal, unresolved text
          // instead of propagating. Every other failure (a callback/built-in that recognised
          // the verb and rejected its arguments) still propagates normally, below.
          if (!(err instanceof UnsupportedTokenError)) throw err;
          Log.writeLine(
            LogLevels.Warning,
            `No verb matched [${StringUtils.truncateIfNeeded(matchedSpan, LOG_TOKEN_TRUNCATE_LENGTH)}] — ` +
            `treating it as literal text rather than failing. If this was meant to be a real ` +
            `token, check the verb name; if it's incidental [[/]] adjacency in unrelated data ` +
            `(e.g. a JSON nested array), this is expected and no action is needed.`
          );
          resolvedValue = matchedSpan;
        }
        appendCurrent(resolvedValue);
        index += this._endTokenChar.length;
        continue;
      }
      // Ordinary character — copy it through to whichever buffer is current, unchanged.
      appendCurrent(tokenisedString[index]);
      index++;
    }

    // Anything still open on the stack never found its own closing `]]` — fold each one back
    // into whatever's beneath it (or into the main output, for the outermost) as plain literal
    // text, prefixed with its own, now-meaningless `[[`. Innermost first: that's the order a
    // real closing sequence would have unwound them in, and appendCurrent (which looks at the
    // stack's current, shrinking length) routes each fold to the right place automatically.
    while (stack.length > 0) {
      const unclosedFrame = stack.pop()!;
      appendCurrent(this._startTokenChar + unclosedFrame.buffer);
    }

    return mainOutput;
  }

  /**
   * After all tokens are resolved, removes escaping from any token-boundary sequence
   * (`[[`/`]]`) that was escaped to prevent it being recognised as a real token.
   *
   * Position-aware, not a global find-and-replace: only a run of escape chars immediately
   * preceding `[[` or `]]` is ever touched. An odd-length run means that boundary sequence
   * itself was escaped — one escape char is consumed revealing it as literal text, and the
   * remaining (now even) run collapses pairwise. An even-length run means the boundary
   * sequence was never escaped — the run still collapses pairwise (each `//` is one literal
   * escape char), but the boundary text itself is left alone. A run *not* immediately
   * followed by `[[`/`]]` is never touched at all, at any length — there is nothing to
   * de-escape, because nothing about it ever conflicted with token syntax in the first
   * place (e.g. the `//` in `https://example.com`). See this class's own doc comment,
   * "Escaping" section, for why this has to be a local/positional decision rather than a
   * context-free substitution over the whole string.
   */
  private static doDeEscapesIfRequired(deEscape: boolean, stringToProcess: string): string {

    ////////////////////////////////////////////////////
    //
    // Scans stringToProcess left to right, copying it through untouched character by
    // character except where a run of escape characters sits immediately before a token
    // boundary sequence (`[[` or `]]`) — only there does the run get collapsed/consumed, per
    // the odd/even rule described in this method's own doc comment above.

    let processedString = stringToProcess;

    // Nothing to do if de-escaping wasn't requested, or there's no content to scan.
    if (deEscape && !StringUtils.isBlank(processedString)) {
      const boundarySequences = [this._startTokenChar, this._endTokenChar];
      let result = "";
      let i = 0;
      while (i < processedString.length) {
        // Not an escape char — copy it straight through and move on.
        if (processedString[i] !== this.EscapeChar) {
          result += processedString[i];
          i++;
          continue;
        }
        // Found the start of a run of consecutive escape chars — find where it ends.
        let runEnd = i;
        while (runEnd < processedString.length && processedString[runEnd] === this.EscapeChar) runEnd++;
        const runLength = runEnd - i;
        // Check whether a token-boundary sequence immediately follows this run.
        const followingBoundary = boundarySequences.find((boundary) => processedString.startsWith(boundary, runEnd));
        if (Utils.isUndefined(followingBoundary)) {
          // Not adjacent to a token boundary at all — leave this run completely untouched.
          result += processedString.slice(i, runEnd);
          i = runEnd;
          continue;
        }
        // Adjacent to a token boundary — collapse the run pairwise (each escaped-escape-char
        // pair becomes one literal escape char); what's left over (odd/even) is handled below.
        result += this.EscapeChar.repeat(Math.floor(runLength / 2));
        if (runLength % 2 === 1) {
          // Odd: the boundary sequence itself was escaped — reveal it as literal text and
          // skip past it; it's plain text now, not something to re-scan as a token.
          result += followingBoundary;
          i = runEnd + followingBoundary.length;
        } else {
          // Even: the run was already all literal escape-char pairs — the boundary sequence
          // was never escaped, so leave it for the main loop to copy through as-is.
          i = runEnd;
        }
      }
      processedString = result;
    }
    // No logging here — this method's own input/output is a sub-step of whatever doAsync
    // call is resolving (nested recursion, or a plain de-escape-only pass), and doAsync's own
    // top-level logging already shows the full before/after for the whole operation. A
    // separate trace here used to fire on any input≠output, token-resolution included, not
    // just genuine de-escaping — misleading, and now redundant besides.
    return processedString;
  }

  /**
   * Splits a token body into verb / qualifier / args, for doToken's dispatch below. See this
   * class's own "Dispatch"/"Qualifier parsing" doc sections above for the exact rules — in
   * short: the verb ends at the first `(` or `|`, whichever comes first; a `(` starts a
   * qualifier, ending at the first unescaped `)` (no nesting); everything after the verb
   * section is `args`, de-escaped the same way `[[`/`]]` boundaries are.
   */
  private static parseVerbSection(token: string): { verb: string; rawVerb: string; qualifier: string | undefined; args: string } {
    // Scan once for whichever comes first: a qualifier-opening "(" or the plain delimiter.
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
      // No qualifier — verb is everything up to the first delimiter, or the whole token if
      // there's no delimiter either (a bare verb with no args at all).
      const verbText = delimiterIndex === -1 ? token : token.substring(0, delimiterIndex);
      const args = delimiterIndex === -1 ? "" : token.substring(delimiterIndex + 1);
      return {
        verb: verbText.toLowerCase().trim(),
        rawVerb: verbText,
        qualifier: undefined,
        args: this.doDeEscapesIfRequired(true, args),
      };
    }

    // Has a qualifier — verb is the text before the "(". Scan forward for the first
    // unescaped ")"; everything between is the qualifier content, taken literally (no
    // nesting — an inner "(" has no special meaning, same rule as e.g. random|from(...)).
    const verbText = token.substring(0, qualifierOpenIndex);
    let qualifier = "";
    let i = qualifierOpenIndex + 1;
    let closed = false;
    while (i < token.length) {
      if (token[i] === this.EscapeChar && i + 1 < token.length) {
        // Escaped character — literal, never ends the qualifier.
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
      throw new Error(`Unterminated '(' in verb qualifier of token [${token}] — expected a closing ')'.`);
    }
    const rawVerb = token.substring(0, i);
    // The character right after the qualifier's closing ")" must be the delimiter, or
    // nothing (end of string, no args) — anything else is malformed.
    let args = "";
    if (i < token.length) {
      if (token[i] !== this._delimiter) {
        throw new Error(
          `Malformed token [${token}] — expected [${this._delimiter}] or end of string immediately after the verb qualifier, got [${token[i]}].`
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
   * Tries each handler in `handlers` — the user-registered callbacks for one specific verb —
   * in **reverse** order (most-recently-registered first, see {@link Detokeniser.addCallback}'s
   * own doc comment for why), awaiting each regardless of whether it's sync or async, and
   * returning the first non-`undefined` result.
   *
   * A handler throwing here is logged and treated the same as "returned undefined" — one
   * unexpected bug in a user-registered callback shouldn't block every other callback (or the
   * built-in) registered for the same verb from getting a turn. This is deliberately NOT used
   * for the built-in handler itself (see {@link Detokeniser.doToken}, which calls it directly)
   * — a built-in throwing means it's already recognised the verb as its own and found the
   * arguments invalid, which is a genuine, specific validation error that must propagate
   * directly, not get swallowed into a generic "Unsupported token" message.
   */
  private static async tryHandlers(
    handlers: Array<Detokeniser.Callback> | undefined,
    context: Detokeniser.CallbackContext
  ): Promise<string | undefined> {
    if (!handlers) return undefined;
    for (let index = handlers.length - 1; index >= 0; index--) {
      try {
        const result = await Promise.resolve(handlers[index](context));
        if (!Utils.isNullOrUndefined(result)) return result;
      } catch (e) {
        Log.writeLine(
          LogLevels.Error,
          `Error processing callback (ignoring and setting response to undefined): ${Utils.errorMessage(e)}`
        );
      }
    }
    return undefined;
  }

  /**
   * Resolves a single token body — see the main `////` comment inside for the resolution
   * mechanics. On success, logs one `TestDebug` line pairing this specific token's own raw
   * text with its own resolved value: `Processed [<token, truncated to
   * {@link LOG_TOKEN_TRUNCATE_LENGTH}>] to [<result, truncated to the same length>]` — this is
   * what gives a multi-token string one line per token (resolved innermost-first, so a nested
   * token's own line always precedes its parent's), rather than {@link Detokeniser.doAsync}
   * logging one undifferentiated dump of the whole input and the whole output. Logs nothing on
   * failure — there's no resolved value yet to pair the token with; the existing
   * `Detokeniser.doAsync`-wrapping error log (in {@link Detokeniser.doResolve}'s catch
   * block) already covers that path.
   */
  private static async doToken(token: string, options: Detokeniser.DoOptions = {}): Promise<string> {

    ////////////////////////////////////////////////////
    //
    // Resolves a single token body: parse verb/qualifier/args once (parseVerbSection), try
    // every user-registered callback for that verb (most-recently-registered first, so a
    // consumer can override a built-in), then fall through to the single built-in handler for
    // that verb (if any), and finally throw if nothing matched at all. See tryHandlers' own
    // doc comment for why user-callback errors are swallowed but a built-in's are not.

    // A token body must actually have content — "[[]]" or similar is always an error. Checked
    // once, centrally, here — not per-handler — since it applies regardless of which verb (if
    // any) the token would otherwise turn out to name.
    if (!token || token === "") {
      throw new Error("Empty token!  Token must be populated.");
    }

    const { verb, rawVerb, qualifier, args } = this.parseVerbSection(token);
    const context: Detokeniser.CallbackContext = { verb, rawVerb, qualifier, args, delimiter: this.delimiter, options };

    let processedToken = await this.tryHandlers(this._userCallbacks?.get(verb), context);
    if (Utils.isNullOrUndefined(processedToken)) {
      const builtinHandler = this._builtinCallbacks.get(verb);
      if (builtinHandler) {
        // Call the built-in directly, not through tryHandlers — any error it throws
        // propagates uncaught, per tryHandlers' own doc comment.
        processedToken = await Promise.resolve(builtinHandler(context));
      }
    }

    if (Utils.isNullOrUndefined(processedToken)) {
      // Nothing — no user callback, no built-in — ever resolved this token. A dedicated
      // error type, not a plain Error, so resolveTokens can recognise this specific case
      // (nothing claims the verb at all) apart from every other way a token can fail (a
      // callback/built-in recognised the verb and rejected its arguments) without relying on
      // string-matching this message, which callers must never do either — see
      // UnsupportedTokenError's own doc comment for why this distinction exists at all.
      throw new UnsupportedTokenError(`Unsupported token [${verb}]`);
    } else {
      // One line per token actually resolved — see this method's own doc comment above.
      const rawToken = `${this._startTokenChar}${token}${this._endTokenChar}`;
      Log.writeLine(
        LogLevels.TestDebug,
        `Processed [${StringUtils.truncateIfNeeded(rawToken, LOG_TOKEN_TRUNCATE_LENGTH)}] to [${StringUtils.truncateIfNeeded(processedToken, LOG_TOKEN_TRUNCATE_LENGTH)}]`
      );
      return processedToken;
    }
  }

  /**
   * Determines whether the boundary sequence (`[[` or `]]`) starting at `positionToTest` in
   * `fullString` is escaped, by counting the run of consecutive escape characters immediately
   * before it: an odd count means the boundary itself is escaped (one escape char "consumed"
   * by it, the rest pairing off), an even count means it's not (the run is just literal
   * escaped-escape-char pairs with nothing left over to escape the boundary). Used by
   * {@link Detokeniser.resolveTokens} to decide whether a candidate `[[`/`]]` is real token
   * syntax or literal text — de-escaping itself (removing the `/`) happens later, once, in
   * {@link Detokeniser.doDeEscapesIfRequired}; this method only ever decides, never mutates.
   */
  private static isEscaped(fullString: string, positionToTest: number): boolean {
    let index: number;
    let escapeCharCount = 0;
    let returnIsEscaped = false;

    // Nothing can precede position 0, so it can never be escaped.
    if (positionToTest > 0) {
      index = positionToTest;
      // Walk backward counting consecutive escape chars, stopping at the first non-escape
      // char (or the start of the string).
      while (!(--index < 0)) {
        if (fullString[index] == this.EscapeChar) {
          escapeCharCount++;
        } else {
          break;
        }
      }
      // Odd run length → the boundary sequence is escaped.
      if (escapeCharCount % 2 == 1) {
        returnIsEscaped = true;
      }
    }
    return returnIsEscaped;
  }
}

// ─── Detokeniser types ────────────────────────────────────────────────────────

/**
 * Everything a verb handler needs, parsed once by the engine before any handler is called —
 * see {@link Detokeniser}'s own "Token syntax"/"Qualifier parsing" doc sections for the rules
 * that produce these fields.
 */
export interface Detokeniser_CallbackContext {
  /** The matched verb, lowercased/trimmed — e.g. `"date"`. */
  verb: string;
  /**
   * The verb section exactly as written, unparsed — e.g. `"date"` or `"date(nsw)"` or
   * `"someverb(ddd(sd)"`. A safety net: use this if a handler needs to see the literal text
   * rather than trust the engine's own `verb`/`qualifier` split.
   */
  rawVerb: string;
  /** Content of `verb(...)`, if the token had a qualifier — `undefined` otherwise. */
  qualifier: string | undefined;
  /** Everything after the verb section, already de-escaped. Handler-specific shape. */
  args: string;
  /**
   * The current {@link Detokeniser.delimiter} — e.g. `"|"` by default. A handler that splits
   * `args` into further parts itself (most do) must split on this, not a hardcoded `"|"`, so
   * it keeps working correctly if a caller has changed the delimiter (e.g. a Cucumber `Before`
   * hook setting `Detokeniser.delimiter = ';'` to avoid colliding with a DataTable's own use
   * of `|` as a column separator).
   */
  delimiter: string;
  /** The same {@link Detokeniser.DoOptions} the caller passed to {@link Detokeniser.doAsync}. */
  options: Detokeniser.DoOptions;
}

/**
 * Signature for a handler registered via {@link Detokeniser.addCallback}. Every built-in verb
 * handler is implemented with this same shape.
 *
 * May be synchronous or asynchronous — {@link Detokeniser.doAsync}, the only entry point,
 * always awaits the result either way.
 *
 * @param context - See {@link Detokeniser.CallbackContext}. Destructure only the fields a
 *   given handler needs — e.g. `({ args }) => ...` for the common case.
 * @returns The replacement string, a Promise resolving to it, or `undefined` to pass to the
 *   next handler registered for this verb.
 */
export interface Detokeniser_Callback {
  (context: Detokeniser.CallbackContext): string | undefined | Promise<string | undefined>;
}

/**
 * Options passed to {@link Detokeniser.doAsync}.
 */
export interface Detokeniser_DoOptions {
  /**
   * Key/value pairs made available to `[[setting|profileParameterName: "key"]]` tokens.
   * Typically populated from Cucumber world parameters or a test profile configuration object.
   * @example { username: 'alice', environment: 'staging' }
   */
  contextParameters?: Record<string, unknown>;

  /**
   * Whether escaped token-boundary sequences (`/[[`, `/]]`) are de-escaped once every token in
   * this call has been resolved. Defaults to `true` — unchanged behaviour for every existing
   * caller that doesn't pass this option.
   *
   * De-escaping is a one-shot operation: once an escape marker is consumed, the literal text it
   * reveals is indistinguishable from genuine `[[`/`]]` syntax, so a second detokeniser pass over
   * the same text would misread it as a real token. Pass `false` for any intermediate resolution
   * — e.g. resolving one value that will be assembled into a larger body/request which gets its
   * own final {@link Detokeniser.doAsync} pass further down the pipeline — so escape sequences
   * survive untouched for that later, designated pass to resolve exactly once. See this class's
   * own "Escaping" section above.
   */
  deEscape?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Detokeniser {
  export type Callback = Detokeniser_Callback;
  export type CallbackContext = Detokeniser_CallbackContext;
  export type DoOptions = Detokeniser_DoOptions;
}
