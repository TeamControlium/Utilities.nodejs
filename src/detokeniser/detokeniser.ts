import { addDays, addHours, addMinutes, addMonths, addYears, format } from "date-fns";
import { formatInTimeZone, getTimezoneOffset } from "date-fns-tz";

import { JsonUtils, Log, LogLevels, StringUtils, Utils } from "../index.js";

// ─── MockUtils stub ───────────────────────────────────────────────────────────
// TODO: Replace with real import when MockUtils is brought into the package
const MockUtils = {
  interceptedRequests: undefined as object[] | undefined,
};


interface RunningString {
  currentToken: InnermostToken;
  outputString: string;
}
interface DoTokenReturn {
  processedToken?: string;
}
interface DoTokenPreambleReturn {
  offsetAndFormat: string[];
  verb: string;
  params: string | undefined;
  errParseDateOffset: string;
  errInvalidEpoch: string;
  errRandomParams: string;
  errFollowingDayParams: string;
  errInvalidDateVerb: string;
  // Raw IANA zone name (e.g. "Europe/London"), if the date token's optional 3rd part supplied
  // one — undefined means "format in local time", same as omitting it entirely.
  ianaZone: string | undefined;
}

/**
 * Processes strings containing tokens in the format `[[tokenType|expression|format]]`, replacing each
 * token with its resolved value. Tokens can be nested — the innermost is always resolved first.
 *
 * ## Token syntax
 * ```
 * [[tokenType|expression|format]]
 * ```
 * - **tokenType** — identifies the built-in handler or is matched against registered callbacks
 * - **expression** — what to compute (type-specific)
 * - **format** — how to format the result (type-specific, often optional)
 *
 * ---
 * ## Built-in token types
 *
 * ### `random` — random data
 * | Expression | Format | Example | Sample output |
 * |---|---|---|---|
 * | `digits` | count | `[[random\|digits\|6]]` | `482910` |
 * | `letters` | count | `[[random\|letters\|4]]` | `xKpQ` |
 * | `lowercaseletters` | count | `[[random\|lowercaseletters\|4]]` | `xkpq` |
 * | `uppercaseletters` | count | `[[random\|uppercaseletters\|4]]` | `XKPQ` |
 * | `alphanumerics` | count | `[[random\|alphanumerics\|8]]` | `a3Kx92Zp` |
 * | `from(<chars>)` | count | `[[random\|from(aeiou)\|3]]` | `ioa` |
 * | `float(min,max)` | decimal places | `[[random\|float(1.5,3.7)\|2]]` | `2.83` |
 * | `date(fromEpoch,toEpoch)` | date format | `[[random\|date(0,1700000000000)\|yyyy-MM-dd]]` | `1994-07-12` |
 *
 * ### `date` — date and time
 * Format is a [date-fns format string](https://date-fns.org/docs/format), or the special values
 * `epoch` (milliseconds since 1970-01-01) or `second-epoch`.
 *
 * | Expression | Example | Sample output |
 * |---|---|---|
 * | `today` / `now` | `[[date\|today\|dd-MM-yyyy]]` | `01-04-2026` |
 * | `yesterday` | `[[date\|yesterday\|dd-MM-yyyy]]` | `31-03-2026` |
 * | `tomorrow` | `[[date\|tomorrow\|dd-MM-yyyy]]` | `02-04-2026` |
 * | `addYears(n)` | `[[date\|addYears(-1)\|yyyy]]` | `2025` |
 * | `addMonths(n)` | `[[date\|addMonths(3)\|MMM yyyy]]` | `Jul 2026` |
 * | `addDays(n)` | `[[date\|addDays(5)\|dd-MM-yyyy]]` | `06-04-2026` |
 * | `addHours(n)` | `[[date\|addHours(2)\|HH:mm]]` | `14:30` |
 * | `addMinutes(n)` | `[[date\|addMinutes(30)\|HH:mm]]` | `13:00` |
 * | `random(fromEpoch,toEpoch)` | date format | `[[date\|random(0,1700000000000)\|yyyy-MM-dd]]` | random date |
 * | `followingDay(epoch,dayName)` | date format | `[[date\|followingDay(1711929600000,wednesday)\|dd-MM-yyyy]]` | next Wednesday |
 * | `yyyy-MM-dd` _(fixed date)_ | date format | `[[date\|2026-06-15\|EEEE]]` | `Monday` |
 *
 * An optional 3rd part gives a raw IANA zone name to format in, instead of local time — see
 * `timezone` below for where that string typically comes from:
 * ```
 * [[date|today|HH:mm|Europe/London]]              ← formatted in London time
 * [[date|addDays(1)|dd-MM-yyyy|Asia/Tokyo]]
 * ```
 *
 * Business-day-aware date math (skipping weekends/public holidays) and place-name-to-zone
 * lookups are deliberately **not** built in — they need an external data source (a holiday
 * calendar, a geocoding service) this package has no business bundling. Register a callback
 * via {@link Detokeniser.addCallback} for either, from a framework plugin or test suite.
 *
 * ### `timezone` — validate an IANA zone name
 * Validates its argument against the runtime's own IANA timezone database (`Intl.supportedValuesOf`)
 * and returns it unchanged if valid, or throws a clear error if not. Exists so a zone name can be
 * nested inside `date`/`diff` with the same validation either way gets, whether typed directly or
 * produced by some other token.
 * ```
 * [[timezone|Europe/London]]   →  Europe/London
 * [[timezone|Nowhere/Fake]]    →  throws: not a recognised IANA timezone name
 * ```
 *
 * ### `diff` — hours between two IANA zones
 * Signed difference, in hours, between two zones' current UTC offset (`zoneA` minus `zoneB`),
 * as a plain decimal number string — e.g. `"5"`, `"-5.5"`, `"5.75"` (Nepal-style quarter-hour
 * zones). "UTC" is itself a valid zone, so this also covers a single zone's offset from UTC.
 * ```
 * [[diff|Europe/London|Africa/Lusaka]]   →  e.g. "-2" (seasonal — Europe/London observes DST)
 * [[diff|Asia/Kathmandu|UTC]]            →  e.g. "5.75"
 * ```
 *
 * ### `setting` — retrieve a configured value
 * Parameters are given as JSON key/value pairs after the delimiter. Resolution order:
 * process env → npm config → context parameters → default value.
 * ```
 * [[setting|processEnvName: "MY_VAR"]]
 * [[setting|processEnvName: "MY_VAR", defaultValue: "fallback"]]
 * [[setting|npmPackageConfigName: "myconfig"]]
 * [[setting|profileParameterName: "myParam", defaultValue: "none"]]
 * ```
 *
 * ### `base64` — encode or decode
 * ```
 * [[base64|encode|Hello World]]        →  SGVsbG8gV29ybGQ=
 * [[base64|decode|SGVsbG8gV29ybGQ=]]   →  Hello World
 * ```
 *
 * ### `jwt` — generate a signed JWT
 * ```
 * [[jwt|{"sub":"1234","name":"Test"}|MySecret]]
 * [[jwt|{"sub":"1234"}|MySecret|{"algorithm":"HS256"}]]
 * ```
 *
 * ### `mockintercepts` — harvest a value from intercepted mock requests
 * ```
 * [[mockintercepts|$.requests[0].body.userId]]
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
 *
 * // "Now", formatted in Tokyo time
 * await Detokeniser.doAsync('[[date|today|yyyy-MM-dd HH:mm|[[timezone|Asia/Tokyo]]]]');
 * ```
 *
 * ---
 * ## Escaping
 * The escape character is `/` (configurable via `EscapeChar`). Escaping only has any effect
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
 * | `[[random\|from(xyz/[[)\|3]]` | 3 chars from `xyz[[` | `/[[` inside `from()` = `/[` (→`[`) + `[` = two `[` (higher weight) |
 * | `[[random\|from(abc/))\|2]]` | 2 chars from `abc)` | `/)` inside `from()` = literal `)` |
 *
 * De-escaping normally happens automatically at the end of {@link Detokeniser.doAsync} — pass
 * `{ deEscape: false }` ({@link Detokeniser.DoOptions.deEscape}) to defer it, when this call's
 * output will be detokenised again later and escape sequences need to survive intact for that
 * later, final pass.
 *
 * ---
 * ## Extending with callbacks
 * Custom token types are registered via {@link Detokeniser.addCallback}. Both sync and async handlers
 * share the same registration method and callback list. Callbacks are tried in registration order;
 * return `undefined` to pass to the next callback. If all callbacks return `undefined` and no built-in
 * handler matched, an error is thrown.
 *
 * {@link Detokeniser.doAsync} is the only entry point — it always awaits every callback, sync or
 * async, so there's no separate sync method whose caller would need to know in advance whether
 * every token a test might pass in resolves synchronously or not.
 *
 * @see {@link Detokeniser.addCallback}
 * @see {@link Detokeniser.doAsync}
 */
export class Detokeniser {
  private static readonly _endTokenChar = "]]";
  private static readonly _startTokenChar = "[[";
  private static EscapeChar = "/";
  private static readonly _delimiter = "|";

  private static _callbacks: Array<Detokeniser.Callback> | undefined = undefined;

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
   * Resets the Detokeniser to factory defaults:
   * - {@link Detokeniser.enabled} restored to `true`
   * - Escape char restored to `/`
   * - All registered sync and async callbacks cleared
   *
   * Call this in test teardown to guarantee a clean state between scenarios.
   * @example
   * afterEach(() => Detokeniser.reset());
   */
  public static reset() {
    this.enabled = true;
    this.EscapeChar = "/";
    this._callbacks = undefined;
  }

  /**
   * Registers a custom token handler. Both sync and async handlers are registered via this method
   * and share the same callback list.
   *
   * Callbacks are tried in registration order. The first to return a non-`undefined` value wins.
   * Return `undefined` to pass to the next callback. If all callbacks return `undefined` and no
   * built-in handler matched, an error is thrown.
   *
   * {@link Detokeniser.doAsync} — the single entry point — always awaits every registered
   * callback, sync or async, so either kind works without the caller needing to know in
   * advance which one it registered.
   *
   * @param callback - `(token: string) => string | undefined | Promise<string | undefined>`
   *   - `token` — full token body without `[[` / `]]`, e.g. `"mytype|arg1|arg2"` (delimiter is always `|`)
   *
   * @example
   * // Sync handler for [[env|VAR_NAME]] tokens
   * Detokeniser.addCallback((token) => {
   *   const [type, name] = token.split('|');
   *   if (type !== 'env') return undefined;
   *   return process.env[name] ?? '';
   * });
   * await Detokeniser.doAsync('Path: [[env|HOME]]'); // → 'Path: /home/user'
   *
   * @example
   * // Async handler for [[db|table|column|where]] tokens
   * Detokeniser.addCallback(async (token) => {
   *   const [type, table, column, where] = token.split('|');
   *   if (type !== 'db') return undefined;
   *   const row = await db.query(`SELECT ${column} FROM ${table} WHERE ${where} LIMIT 1`);
   *   return String(row[column]);
   * });
   * const result = await Detokeniser.doAsync('ID: [[db|users|id|active=1]]');
   *
   * @see {@link Detokeniser.resetCallbacks} to remove all registered callbacks
   * @see {@link Detokeniser.doAsync}
   */
  public static addCallback(callback: Detokeniser.Callback) {
    // callback must actually be a function — fail fast and clearly if not.
    Utils.assertType(callback, "function", "Detokeniser.addCallback", "callback");
    // Lazily create the callback list on first registration — most consumers never register
    // any callback at all, so this stays undefined (not an empty array) until needed.
    if (!this._callbacks) {
      this._callbacks = new Array<Detokeniser.Callback>();
    }
    // Append — callbacks are tried in registration order, so this list's order is significant.
    this._callbacks.push(callback);
  }

  /**
   * Removes all registered callbacks. Built-in token handlers are unaffected.
   * Use between tests or scenarios to ensure callback isolation.
   * @see {@link Detokeniser.reset} to also restore all defaults
   */
  public static resetCallbacks() {
    this._callbacks = undefined;
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
   * await Detokeniser.doAsync('[[random|uppercaseletters|3]]-[[random|digits|4]]'); // → e.g. 'XKP-7391'
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
   * @example
   * // Async callback for database-driven tokens
   * Detokeniser.addCallback(async (token) => {
   *   const [type, key] = token.split('|');
   *   if (type !== 'db') return undefined;
   *   return await fetchFromDatabase(key);
   * });
   * await Detokeniser.doAsync('User: [[db|users.name.first]]');
   */
  public static async doAsync(tokenisedString: string, options: Detokeniser.DoOptions = {}): Promise<string> {

    ////////////////////////////////////////////////////
    //
    // Resolves every token in tokenisedString, innermost-first: locate the leftmost-deepest
    // token, resolve it via doToken (awaiting it, so a registered callback can itself be
    // async), splice the resolved text back in, then recurse on the resulting string (which
    // may expose a new token, or may not) until no tokens remain — then de-escape any escaped
    // token-boundary sequences in the final result, unless the caller deferred that to a later
    // pass via options.deEscape. This is the single, sole entry point — see this method's own
    // doc comment above for why there's deliberately no separate synchronous sibling.

    // Master on/off switch — when disabled, return the input completely unchanged.
    if (!this.enabled) return tokenisedString;

    // Caller's own de-escape preference (defaults to true); deEscape (below) separately
    // tracks whether this call's own while-loop ever actually found/resolved a token.
    const deEscapeOption = options.deEscape ?? true;
    let deEscape = true;

    try {
      // tokenisedString must actually be a string — fail fast and clearly if not.
      Utils.assertType(tokenisedString, "string", "Detokeniser.doAsync", "tokenisedString");
      // Locate the first (innermost, leftmost) token, splitting the string into
      // preamble / token / postamble around it.
      const runningString = this.doPreamble(tokenisedString);

      // Loop until last token find found no tokens
      while (runningString.currentToken.hasToken) {
        // Process the last found token, prepend it to the text after the last found token then find any token in the resulting string
        runningString.currentToken = new InnermostToken(
          (await this.doToken(runningString.currentToken.childToken.substring(this._startTokenChar.length), options)) +
          runningString.currentToken.postamble,
          this._startTokenChar,
          this._endTokenChar,
          this.EscapeChar
        );
        // Diagnostic trace of this iteration's split, for debugging nested-token resolution.
        const logToken = runningString.currentToken.hasToken ? runningString.currentToken.childToken : '<No Token>';
        Log.writeLine(
          LogLevels.TestDebug,
          `Preamble:[${runningString.currentToken.preamble}] Token:[${logToken}] Postamble:[${runningString.currentToken.postamble}]`
        );
        // Concatinate the last found tokens preable (or full text if none found) to the built string and recursivley call self to ensure full token resolution
        runningString.outputString = await this.doAsync(runningString.outputString + runningString.currentToken.preamble, options);
        // A token was found and resolved this iteration — this call's own de-escape step
        // (below) stays suppressed; the recursive call above already handled de-escaping at
        // the point the recursion finally bottoms out with no tokens left.
        deEscape = false;
      }

      //
      // Okay, so there is a bug here.  But it shall remain unfixed as it requires time.
      //
      // The bug is that is the resolved token string contains a sequence of characters that makes doDeEscapesIfRequired think it sees an escaped special char
      // the it will de-escape it!!  However, probablity of incidence is currently low.  When/If it does happen (impact could be high!) it can then be fixed.
      //
      // IE.
      //  const encoded = Buffer.from('this/>escaped').toString('base64');
      //  const decoded = await Detokeniser.doAsync(`<base64;decode;${encoded}>`);
      //
      //  decoded would now be "this>escaped".  Should be "this/>escaped".
      //
      // `deEscapeOption` (caller-supplied, default true) gates this independently of `deEscape`
      // (this call's own internal "did I actually resolve a token" tracking) — an explicit
      // `false` always wins, regardless of whether this call found a token, so a caller
      // deferring de-escaping to a later pass gets that guarantee unconditionally. See
      // {@link Detokeniser.DoOptions.deEscape}.
      // De-escape now only if this call's own loop never found a token (deEscape still
      // true — the recursion has bottomed out here) AND the caller hasn't deferred it.
      runningString.outputString = this.doDeEscapesIfRequired(tokenisedString, deEscape && deEscapeOption, runningString.outputString);
      return runningString.outputString;
    } catch (err: unknown) {
      // Wrap whatever failed (bad token syntax, a callback throwing, etc.) with the original
      // input string for context, log it, then re-throw as a plain Error.
      const errText = `Error processing [${tokenisedString}]: ${Utils.errorMessage(err)}`;
      Log.writeLine(LogLevels.Error, errText);
      throw Error(errText);
    }
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
  private static doDeEscapesIfRequired(tokenisedString: string, deEscape: boolean, stringToProcess: string): string {

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
    // Trace what changed, if anything, for debugging.
    if (tokenisedString !== processedString) {
      Log.writeLine(LogLevels.TestDebug, `Processed [${tokenisedString}]\nto [${processedString}]`);
    }
    return processedString;
  }

  private static doPreamble(tokenisedString: string): RunningString {
    // Drill down to the left-most deepest (if nested) token
    const token = new InnermostToken(tokenisedString, this._startTokenChar, this._endTokenChar, this.EscapeChar);

    // Get all text to the left of any token found in the string passed in.  If no token was found Preamble will contain all text from passed string
    const outputString = token.preamble;
    // Package both the located token (or "no token found" state) and the text-so-far together,
    // ready for the caller's while loop to iterate on.
    return { currentToken: token, outputString };
  }

  private static doTokenMain(token: string, options: Detokeniser.DoOptions = {}): DoTokenReturn {

    ////////////////////////////////////////////////////
    //
    // Shared dispatch logic, called once per token by doToken: splits the token body into
    // its tokenName (before the first delimiter) and everything after it, de-escapes that
    // remainder, then routes to whichever built-in handler loweredTokenName matches. Every
    // built-in handler, including 'date'/'timezone'/'diff', is fully synchronous and resolved
    // right here — its result goes straight into doTokenReturn.processedToken. If none of the
    // built-ins match, processedToken stays undefined and doToken falls through to trying
    // registered callbacks instead.

    const doTokenReturn: DoTokenReturn = {};

    doTokenReturn.processedToken = undefined;

    // A token body must actually have content — "[[]]" or similar is always an error.
    if (!token || token === "") {
      throw new Error("Empty token!  Token must be populated.");
    }
    // Split on the first delimiter only: tokenName is the bit before it (e.g. "random",
    // "date"), postAmble is everything after (that handler's own arguments).
    const [tokenName, postAmble] = StringUtils.splitRemaining(token, this._delimiter, 2);
    const loweredTokenName = tokenName.toLowerCase().trim();
    // De-escape the arguments now — this is the single point where a nested, already-escaped
    // sub-expression inside a token's own arguments gets resolved before being handed to a
    // handler, so each handler never has to think about escaping itself.
    const postAmbleDeEscaped = this.doDeEscapesIfRequired(postAmble, true, postAmble);

    if (typeof doTokenReturn.processedToken === "undefined") {
      switch (loweredTokenName) {
        case "random":
          // 'random' needs at least a type and (usually) a length/format argument.
          if (StringUtils.isBlank(postAmbleDeEscaped)) throw new Error(`Random token [${token}] needs at least 2 parts (IE. {{random;type[;<length>]}} etc.)`);
          doTokenReturn.processedToken = this.doRandomToken(postAmbleDeEscaped);
          break;
        case "setting":
          {
            // 'setting' needs its JSON-ish parameter block (processEnvName/etc).
            if (StringUtils.isBlank(postAmbleDeEscaped)) throw new Error(`Setting token [${token}] needs at least 2 parts (IE. {{setting;processEnvName: "TEST_LOG_TO_CONSOLE")`);
            doTokenReturn.processedToken = this.doSettingToken(postAmbleDeEscaped, options);
            break;
          }
        case "mockintercepts":
          // 'mockintercepts' needs a JSONPath expression to harvest from intercepted requests.
          if (StringUtils.isBlank(postAmbleDeEscaped)) throw new Error(`Request token [${token}] needs 2 parts {{mockintercepts;JSONPath}}`);
          doTokenReturn.processedToken = this.doMockRequests(postAmbleDeEscaped);
          break;
        case "jwt":
          // 'jwt' needs at least a payload (signature/options are optional, see doJWTToken).
          if (StringUtils.isBlank(postAmbleDeEscaped))
            throw new Error(`JWT token [${token}] needs at least 2 parts (IE. {{jwt;payload[;signature[;options]]}} etc.)`);
          doTokenReturn.processedToken = this.doJWTToken(postAmbleDeEscaped);
          break;
        case "base64":
          // aha, we actuall need three parts <base64;encode|decode;<string>>
          // Split off the direction ('encode'/'decode') from the value to convert; only
          // proceed to doBase64 if the direction is actually one of those two literals.
          if (!StringUtils.isBlank(postAmbleDeEscaped)) {
            const [direction, value] = StringUtils.splitRemaining(postAmbleDeEscaped, this._delimiter, 2);
            if (direction == "encode" || direction == "decode") {
              doTokenReturn.processedToken = this.doBase64(value, direction);
              break;
            }
          }
          // Either no postamble at all, or a direction other than encode/decode — malformed.
          throw new Error(`BASE64 token [${token}] needs 3 parts (IE. {{base64;encode|decode;value}})`);
        case "date":
          // 'date' needs at least an offset verb and a format (doDateToken enforces the
          // exact shape, including the optional 3rd IANA-zone part) — this just guards
          // against a completely empty body, same as every other built-in above.
          if (StringUtils.isBlank(postAmbleDeEscaped))
            throw new Error(`Date token [${token}] needs 2 or 3 parts {{date;<offset>;<format>[;<ianaZone>]}}`);
          doTokenReturn.processedToken = this.doDateToken(postAmbleDeEscaped);
          break;
        case "timezone":
          // 'timezone' needs exactly the IANA zone name to validate.
          if (StringUtils.isBlank(postAmbleDeEscaped)) throw new Error(`Timezone token [${token}] needs an IANA zone name (IE. {{timezone;Europe/London}})`);
          doTokenReturn.processedToken = this.doTimezoneToken(postAmbleDeEscaped);
          break;
        case "diff":
          // 'diff' needs exactly two IANA zone names — doDiffToken enforces the exact count.
          if (StringUtils.isBlank(postAmbleDeEscaped)) throw new Error(`Diff token [${token}] needs 2 IANA zone names (IE. {{diff;<zoneA>;<zoneB>}})`);
          doTokenReturn.processedToken = this.doDiffToken(postAmbleDeEscaped);
          break;
        // default: genuinely unrecognised token name — processedToken stays undefined, so
        // the caller falls through to trying registered callbacks, and ultimately to an
        // "Unsupported token" error if none of those match either.
      }
    }
    return doTokenReturn;
  }

  private static async doToken(token: string, options: Detokeniser.DoOptions = {}): Promise<string> {

    ////////////////////////////////////////////////////
    //
    // Resolves a single token body: try the shared built-in dispatch first (doTokenMain —
    // every built-in, including 'date'/'timezone'/'diff', resolves fully synchronously
    // there), then — if still unresolved — try each registered callback in order, awaiting
    // it regardless of whether it's sync or async, and finally throw if nothing recognised
    // the token at all. A callback throwing is logged and treated as "didn't resolve it"
    // rather than propagated, letting the "Unsupported token" error below give the final,
    // clearer verdict instead.

    const doTokenReturn = this.doTokenMain(token, options);
    let processedToken: string | undefined = doTokenReturn.processedToken;
    //
    // If token still not been processed itterate through the callbacks, breaking as soon as it is processed.  Dirty
    // ucky loop. But it works....  If you know a sexier way of doing it please change!!
    //
    try {
      if (Utils.isNullOrUndefined(processedToken)) {
        if (typeof this._callbacks != "undefined") {
          // Try each registered callback in turn (sync or async — Promise.resolve wraps
          // either uniformly), stopping as soon as one actually resolves the token.
          for (const callback of this._callbacks) {
            processedToken = await Promise.resolve(callback(token));
            if (!Utils.isNullOrUndefined(processedToken)) break;
          }
        }
      }
    } catch (e) {
      // A callback throwing here is swallowed, not propagated — logged as an error and
      // treated the same as "returned undefined", letting the "Unsupported token" check
      // below produce the final, clearer error instead.
      Log.writeLine(
        LogLevels.Error,
        `Error processing async callback (ignoring and setting response to undefined):${(e as Error)?.message ?? "<Unknown Error>"}}`
      );
      processedToken = undefined;
    }
    if (Utils.isNullOrUndefined(processedToken)) {
      // Nothing — no built-in, no callback — ever resolved this token.
      throw new Error(`Unsupported token [${StringUtils.splitRemaining(token, this._delimiter, 2)[0]}]`);
    } else {
      return processedToken as string;
    }
  }

  private static doSettingToken(tokenBody: string, options: Detokeniser.DoOptions = {}): string | undefined {

    ////////////////////////////////////////////////////
    //
    // Resolves a `[[setting|...]]` token: the token body is bare `name: value` pairs (not
    // wrapped in braces, e.g. `processEnvName: "MY_VAR"`), so it's wrapped into a JSON object
    // literal, validated, parsed, then handed to Utils.getSetting — which does the actual
    // process-env → npm-config → context-parameter → default resolution — and the resolved
    // value is stringified for substitution back into the token's surrounding text.

    // Wrap the bare 'name: value, ...' body into a proper JSON object literal.
    const bodyJSON = `{${tokenBody}}`;
    // Validate it actually parses as JSON before attempting to use it — gives a much clearer,
    // setting-specific error than whatever JsonUtils.parse itself would throw.
    if (!JsonUtils.isJson(bodyJSON, true)) {
      const errText = `Token 'Setting'.\nExpected: parameters in name: value format (IE. ${this._startTokenChar}setting;processEnvName: "MY_SETTING"${this._endTokenChar}\nToken was: ${this._startTokenChar}setting;${tokenBody}${this._endTokenChar}\n\nValid Setting parameters include;\n  processEnvName - Name of process env variable\n  npmPackageConfigName - Name of NPM config var\n  profileParameterName - Name of Cucumber profile parameter\n  defaultValue - default value if cannot be found`;
      Log.logErrorAndThrow(errText);
    }
    // Resolve the setting — process env, then npm config, then context parameters (if any
    // were supplied via options.contextParameters), then the parsed object's own defaultValue.
    const { value } = Utils.getSetting(
      LogLevels.TestInformation,
      "From Detokeniser",
      JsonUtils.parse(bodyJSON, true),
      options.contextParameters ? { parameters: options.contextParameters } : undefined
    );
    if (Utils.isNullOrUndefined(value)) {
      // Nothing resolved (and no default was given) — pass the missing value straight
      // through rather than coercing it into the string "undefined"/"null".
      return value as undefined;
    } else {
      // Objects are stringified as JSON; everything else is coerced to its plain string form.
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }

  /**
   * Base64-encodes or decodes a string.
   *
   * This is the underlying handler for `[[base64|encode|...]]` and `[[base64|decode|...]]` tokens
   * but is also exposed for direct use.
   *
   * @param original - The string to encode or decode
   * @param direction - `"encode"` to base64-encode; `"decode"` to base64-decode
   * @returns The encoded or decoded string
   * @throws If the conversion fails (e.g. invalid base64 input for decode)
   *
   * @example
   * Detokeniser.doBase64('Hello World', 'encode');      // → 'SGVsbG8gV29ybGQ='
   * Detokeniser.doBase64('SGVsbG8gV29ybGQ=', 'decode'); // → 'Hello World'
   */
  public static doBase64(original: string, direction: "encode" | "decode"): string {
    // original must actually be a string — fail fast and clearly if not.
    Utils.assertType(original, "string", "Detokeniser.doBase64", "original");
    // direction must be exactly one of the two recognised literals.
    if (direction !== "encode" && direction !== "decode") {
      const errText = `Cannot Detokeniser.doBase64 as [direction] must be 'encode' or 'decode'. Is [${Utils.describeValue(direction)}]`;
      Log.logErrorAndThrow(errText);
    }
    try {
      // Encode: treat original as UTF-8 text, output base64. Decode: treat original as
      // base64, output the UTF-8 text it represents.
      return direction == "encode" ? Buffer.from(original).toString("base64") : Buffer.from(original, "base64").toString();
    } catch (err) {
      // E.g. malformed base64 input on decode — wrap with context and throw.
      const errText = `Converting:\n[${original}]\n  ${direction == "encode" ? "to" : "from"} base64:\n {${Utils.errorMessage(err)}}`;
      Log.logErrorAndThrow(errText);
    }
  }

  //
  //  So, this has been created quickly with little/no checking/testing.  Lots and lots of error handling needs adding or testers will get
  //  errors/fails they have no idea how to fix!!!!
  //
  private static doJWTToken(tokenBody: string): string {

    ////////////////////////////////////////////////////
    //
    // Resolves a `[[jwt|payload[|signature[|options]]]]` token: splits into up to 3 parts
    // (payload, signature, options) on the delimiter, and calls Utils.createJWT with
    // whichever of those were actually supplied — signature defaults to a dummy placeholder
    // if omitted entirely.

    Log.writeLine(LogLevels.TestDebug, `JWT token [${tokenBody}]`);
    const typeAndLengthOrFormat: string[] = StringUtils.splitRemaining(tokenBody, this._delimiter, 3);
    if (typeAndLengthOrFormat.length == 3) {
      // payload, signature, and options were all given.
      return Utils.createJWT(typeAndLengthOrFormat[0], typeAndLengthOrFormat[1], typeAndLengthOrFormat[2]);
    } else if (typeAndLengthOrFormat.length == 2) {
      // payload and signature given, no options.
      return Utils.createJWT(typeAndLengthOrFormat[0], typeAndLengthOrFormat[1]);
    } else {
      // Only the payload was given — sign with a fixed placeholder signature.
      return Utils.createJWT(typeAndLengthOrFormat[0], "DummySignature");
    }
  }

  private static doMockRequests(jsonPath: string): string {
    //
    // NOTE.  This is MockUtils only at the moment.  When playwright is brought in to the library this MUST be made generic so user can harvest from Mock intercepts,
    // whether MSW OR Playwright.
    //

    // Nothing to harvest from if no requests have been intercepted at all.
    if (!MockUtils.interceptedRequests || MockUtils.interceptedRequests.length <= 0) {
      const errMessage = "No Mock Intercepted requests to harvest from!?";
      Log.logErrorAndThrow(errMessage);
    }

    // Find whatever node(s) the JSONPath expression matches across all intercepted requests.
    const jsonProperties = JsonUtils.getPropertiesMatchingPath(MockUtils.interceptedRequests, jsonPath);
    if (jsonProperties.length != 1) {
      // Deliberately strict: a token must resolve to exactly one value — zero or multiple
      // matches are both treated as an error rather than guessing which one was meant.
      throw new Error(`Expected path (${jsonPath}) to match exactly one JSON node.  However, path matched ${jsonProperties.length} nodes!`);
    } else {
      return jsonProperties[0].value as string;
    }
  }

  /**
   * Extracts the content inside the first set of parentheses in `input`, respecting the escape char.
   * An escaped `)` (i.e. `/)`) is treated as a literal `)` and does not end the content.
   * @example parseParenContent("from(abc/))") → "abc)"
   * @example parseParenContent("from(xyz/[[)") → "xyz[["  (with default escape char `/`)
   */
  private static parseParenContent(input: string): string {
    // No opening paren at all — nothing to extract.
    const openParen = input.indexOf("(");
    if (openParen === -1) return "";
    let result = "";
    // Start scanning right after the opening paren.
    let i = openParen + 1;
    while (i < input.length) {
      if (input[i] === this.EscapeChar && i + 1 < input.length) {
        // Escaped character — take the character that follows the escape char literally
        // (e.g. `/)` → literal `)`) and skip both; it never ends the content.
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

  private static doRandomToken(tokenBody: string): string {

    ////////////////////////////////////////////////////
    //
    // Resolves a `[[random|<verb>|<lengthOrFormat>]]` token. The verb selects one of three
    // distinct shapes: date(fromEpoch,toEpoch) → a random epoch formatted per the second
    // part; float(min,max) → a random float truncated/formatted to N decimal places; or one
    // of the character-set verbs (letters/digits/etc, or from(<chars>)) → a random string of
    // the given length built by repeatedly picking a random character from that set.

    const typeAndLengthOrFormat: string[] = StringUtils.splitRemaining(tokenBody, this._delimiter, 2);
    let result = "";
    let select = "";
    const verb: string = typeAndLengthOrFormat[0].toLowerCase().trim();

    if (verb.startsWith("date(")) {
      // date(fromEpoch,toEpoch) — generate a random epoch in that range, then format it
      // per the second part (or leave it as a raw epoch string if the format is "epoch").
      const randomDate = this.doRandomDate(verb.substring(verb.indexOf("(") + 1, verb.indexOf(")")));

      result = typeAndLengthOrFormat[1].toLowerCase() === "epoch" ? "" + randomDate : format(randomDate, typeAndLengthOrFormat[1]);
    } else if (verb.startsWith("float(")) {
      // float(min,max) — the second part is the number of decimal places, not a date format.
      // ToDo: Current format is only for number of decimals.  However in future could be precision,decimals if needed (IE. {random,float(4000,8000),3,4} precision 3 decimals 4...), defaulting
      //       to decimal places if only a single number given (then change would be non-breaking)....
      if (isNaN(parseInt(typeAndLengthOrFormat[1])))
        throw `Invalid Float format. Expect {{random.float(min;max),<number of decimals>}}. Format was: [${typeAndLengthOrFormat[1]}]`;
      const numberOfDecimalPlaces = parseInt(typeAndLengthOrFormat[1]);
      const powerDPs = Math.pow(10, numberOfDecimalPlaces);
      // Truncate (not round) to the requested number of decimal places, then format with
      // exactly that many digits — guarantees a fixed-width decimal part, not a varying one.
      result = (Math.trunc(this.doRandomFloat(verb.substring(verb.indexOf("(") + 1, verb.indexOf(")"))) * powerDPs) / powerDPs).toFixed(numberOfDecimalPlaces);
    } else {
      // Character-set verbs: either a custom from(<chars>) set, or one of the fixed named
      // sets below. Either way, 'select' ends up holding the pool of characters to pick from.
      if (verb.startsWith("from(")) {
        select = this.parseParenContent(typeAndLengthOrFormat[0]);
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
            throw `Unrecognised random Type [${typeAndLengthOrFormat[0]}] - Expect letters, lowercaseletters, uppercaseletters digits or alphanumerics`;
        }
      }
      // Second part must be a valid non-negative integer length, regardless of which
      // character set was selected above.
      if (isNaN(parseInt(typeAndLengthOrFormat[1])) || parseInt(typeAndLengthOrFormat[1]) < 0)
        throw `Invalid length part in Random token {{random;<type>;<length>}}. Length was: [${typeAndLengthOrFormat[1]}]`;
      // Build the result by picking `length` characters from the pool, independently at
      // random each time (so repeats within the result are allowed).
      for (let count = 0; count < parseInt(typeAndLengthOrFormat[1]); count++) {
        result += select[Utils.getRandomInt(0, select.length - 1)];
      }
    }
    return result;
  }

  private static doDateTokenPreamble(date: number, tokenBody: string): DoTokenPreambleReturn {

    ////////////////////////////////////////////////////
    //
    // Setup for doDateToken: splits tokenBody into its offset/verb part, its format part,
    // and an optional 3rd raw-IANA-zone part; validates that zone (if given) against the
    // runtime's own timezone database; extracts the verb name and its parenthesised params
    // (if any) from the offset part; and bundles up every verb-specific error message string
    // up front so each calling branch can just reference the one it needs rather than
    // building it inline.

    // Split into [offsetExpression, format, ianaZone?] — e.g. ["addDays(5)", "dd-MM-yyyy"] or
    // ["addDays(5)", "dd-MM-yyyy", "Europe/London"]. The zone is genuinely optional — omitting
    // it means "format in local time", same as before this token supported zones at all.
    const parts = StringUtils.splitRemaining(tokenBody, this._delimiter, 3);
    const offsetAndFormat = [parts[0], parts[1]];
    const ianaZone = parts[2];

    // Must have both an offset expression and a format — the 3rd (zone) part is optional.
    if (parts.length < 2) throw "Date token does not have a format parameter; example: {date;today;dd-MM-yyyy}";
    // A zone was actually supplied — validate it now, up front, rather than letting a typo
    // surface later as a confusing date-fns formatting error.
    if (ianaZone) this.assertValidIANAZone(ianaZone, "Date token's timezone");

    Log.writeLine(LogLevels.TestDebug, `Time now is [${date}] (Epoch) and we are in [${ianaZone ?? "<local time>"}]`);

    return {
      offsetAndFormat: offsetAndFormat,
      // verb is the offset expression's name only — if it has parens (e.g. "addDays(5)"),
      // strip everything from "(" onward; otherwise the whole offset expression is the verb
      // (e.g. "today").
      verb: (offsetAndFormat[0].includes("(") && offsetAndFormat[0].endsWith(")") ? offsetAndFormat[0].split("(")[0] : offsetAndFormat[0]).toLowerCase().trim(),
      // params is whatever's between the parens (e.g. "5" from "addDays(5)"), or undefined
      // if the offset expression has no parens at all (e.g. "today").
      params:
        offsetAndFormat[0].includes("(") && offsetAndFormat[0].endsWith(")")
          ? ((x: string) => {
            // Drop the trailing ")" that split("(")[1] leaves behind.
            return x.substring(0, x.length - 1);
          })(offsetAndFormat[0].split("(")[1])
          : undefined,

      // Pre-built, verb-specific error messages — each referencing offsetAndFormat[0] so the
      // message always reflects what was actually typed, computed once here rather than
      // separately at each call site below.
      errParseDateOffset: "Invalid Active Date offset.  Expect AddYears(n) AddMonths(n) or AddDays(n)",
      errInvalidEpoch: "Invalid Epoch offset.  Expect number of milliseconds since 1/1/1970",
      errRandomParams: `Invalid Random params ([${offsetAndFormat[0]}]).  Expect Random(<start date>,<end date>).  Example: {date;random(1708990784000,1701360784000);yyy-MM-dd}`,
      errFollowingDayParams: `FollowingDay requires epoch and day name.  IE. FollowingDay(123456,wednesday)  Got ${offsetAndFormat[0]}`,
      errInvalidDateVerb: `Invalid date verb [${offsetAndFormat[0]}].  Need: Random, Today, Now, Yesterday, Tomorrow, AddYears(n) etc... EG {date;AddDays(5);yyyy-MM-dd}`,
      ianaZone: ianaZone,
    };
  }

  private static doDateTokenPostamble(offsetAndFormat: string[], date: number, ianaZone: string | undefined): string {

    ////////////////////////////////////////////////////
    //
    // Final-formatting step for doDateToken, once the offset-resolved epoch (date) is known:
    // the format part is either the special "epoch"/"second-epoch" values (returning the raw
    // epoch, not a formatted string), or a real date-fns format string — formatted in the
    // given IANA zone if one was given, otherwise formatted in local time.

    // Special case: caller wants the raw millisecond epoch, not a formatted date string.
    if (offsetAndFormat[1].toLowerCase() === "epoch") {
      return date.toString();
    }

    // Special case: caller wants the epoch in whole seconds, not milliseconds.
    if (offsetAndFormat[1].toLowerCase() === "second-epoch") {
      return Math.floor(date / 1000).toString();
    }

    try {
      // Format in the given zone if one was supplied, otherwise local time.
      const processedDate = ianaZone ? formatInTimeZone(date, ianaZone, offsetAndFormat[1]) : format(date, offsetAndFormat[1]);
      Log.writeLine(LogLevels.TestDebug, `Formatted [${offsetAndFormat[0]}] date [${date}] (Epoch) with [${offsetAndFormat[1]}] to: [${processedDate}]`);
      return processedDate;
    } catch (err) {
      // date-fns format() throws on a malformed format string — wrap with the date/format
      // that caused it for context, including the original stack trace.
      const errorText = `Error formatting date [${date}] with format string[${offsetAndFormat[1]}]: ${(err as Error)?.message ?? "<Unknown error>"}}`;
      throw new Error(errorText + "/r" + ((err as Error)?.stack ?? ""));
    }
  }

  private static doDateTokenVerb(date: number, dateTokenPrep: DoTokenPreambleReturn): number {

    ////////////////////////////////////////////////////
    //
    // Resolves every date-offset verb this token supports — the whole thing is fully
    // synchronous now that business-day/public-holiday-aware verbs have been removed (that
    // kind of date math needs an external holiday calendar, which belongs in a consumer's own
    // callback, not baked into this built-in).

    let returnDate: number = date;
    switch (dateTokenPrep.verb) {
      case "random": {
        // random(fromEpoch,toEpoch) — pick a random epoch within that inclusive range.
        if (Utils.isNullOrUndefined(dateTokenPrep.params)) {
          throw new Error(dateTokenPrep.errRandomParams);
        } else {
          returnDate = this.doRandomDate(dateTokenPrep.params as string);
        }
        break;
      }
      case "today":
      case "now":
        // No offset at all — use the current date/time passed in as-is.
        break;
      case "yesterday":
        returnDate = addDays(date, -1).getTime();
        break;
      case "tomorrow":
        returnDate = addDays(date, 1).getTime();
        break;
      case "addyears":
        returnDate = addYears(date, this.getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
        break;
      case "addmonths":
        returnDate = addMonths(date, this.getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
        break;
      case "adddays":
        returnDate = addDays(date, this.getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
        break;
      case "addhours":
        returnDate = addHours(date, this.getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
        break;
      case "addminutes":
        returnDate = addMinutes(date, this.getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
        break;
      case "followingday": {
        // followingDay(epoch,dayName) — find the next occurrence of the named weekday on or
        // after the given epoch (no weekend/public-holiday skipping — that's the async-only
        // followingWorkingDay variant instead).
        if (Utils.isNullOrUndefined(dateTokenPrep.params)) {
          throw new Error(dateTokenPrep.errFollowingDayParams);
        } else {
          const currentAndDay = (dateTokenPrep.params as string).split(",");
          if (currentAndDay.length != 2) throw new Error(dateTokenPrep.errFollowingDayParams);
          returnDate = this.getFollowingDay(
            this.getParsedDateOffset(currentAndDay[0], dateTokenPrep.errInvalidEpoch),
            currentAndDay[1].toLowerCase(),
            dateTokenPrep.errFollowingDayParams
          ).getTime();
        }
        break;
      }
      default:
        // Not one of the named verbs above — check if it's a fixed "yyyy-MM-dd" literal date
        // instead (e.g. the verb itself IS the date, with no offset applied at all).
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(dateTokenPrep.verb)) {
          // we have a fixed date.  User must be wanted to just format a date....
          const date = dateTokenPrep.verb.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          // Pull year/month/day out of the regex match; month is 0-indexed for Date.UTC.
          const year = Number((date as Array<string>)[1]) ?? 0;
          const month = (Number((date as Array<string>)[2]) ?? 0) - 1;
          const day = Number((date as Array<string>)[3]) ?? 0;
          Log.writeLine(LogLevels.TestDebug, `Date got fixed date:- >>${year}<<>>${month}<<>>${day}<<`);
          // Construct as midnight UTC on that date.
          const fullEpoch = new Date(Date.UTC(year, month, day, 0, 0, 0));
          Log.writeLine(LogLevels.TestDebug, `... which is:- >>${fullEpoch}<<`);

          returnDate = fullEpoch.getTime();
        } else {
          // Neither a recognised verb nor a fixed-date literal — genuinely invalid.
          throw dateTokenPrep.errInvalidDateVerb;
        }
    }
    return returnDate;
  }

  private static doDateToken(tokenBody: string): string {

    ////////////////////////////////////////////////////
    //
    // Resolver for `[[date|...]]` tokens: starts from the current time, resolves the verb's
    // offset via the preamble/verb helpers, then formats the result. Fully synchronous — no
    // verb this token supports needs to await anything external.

    let date = new Date().getTime();
    const dateTokenPrep = this.doDateTokenPreamble(date, tokenBody);
    date = this.doDateTokenVerb(date, dateTokenPrep);
    return this.doDateTokenPostamble(dateTokenPrep.offsetAndFormat, date, dateTokenPrep.ianaZone);
  }

  private static getFollowingDay(currentDateEpoch: number, requiredDayOfTheWeek: string, errorString: string): Date {
    const dayName = requiredDayOfTheWeek.toLowerCase();
    // Resolve the requested day name to an index 0 (Monday) .. 6 (Sunday).
    const requiredDayOfWeek = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].findIndex((item) => {
      if (item == dayName) return true;
      return false;
    });
    // Day name didn't match any of the 7 recognised names at all.
    if (requiredDayOfWeek == -1) throw new Error(errorString);
    // getUTCDay() returns 0 (Sunday) .. 6 (Saturday); subtracting 1 re-bases it to the same
    // Monday-first 0..6 scale used by requiredDayOfWeek above (Sunday wraps to -1 here,
    // which the "actualDayOfWeek < requiredDayOfWeek" branch below still handles correctly
    // since -1 is less than every requiredDayOfWeek value 0..6).
    const actualDayOfWeek = new Date(currentDateEpoch).getUTCDay() - 1;
    if (actualDayOfWeek < requiredDayOfWeek) {
      // Target day hasn't happened yet this week — just add the difference.
      return addDays(currentDateEpoch, requiredDayOfWeek - actualDayOfWeek);
    } else {
      // Target day already passed (or is today) this week — wrap to next week.
      return addDays(currentDateEpoch, requiredDayOfWeek + 7 - actualDayOfWeek);
    }
  }

  private static getParsedDateOffset(numString: string | undefined, errorMessage: string): number {
    // No params string supplied at all (e.g. a verb like "addDays" with no parens/number).
    if (Utils.isNullOrUndefined(numString)) {
      throw `${errorMessage} Got [No Params!]`;
    } else {
      // Trim whitespace, then require it to parse as a whole number.
      const offsetValue = parseInt(numString?.trim() as string);
      if (isNaN(offsetValue)) throw `${errorMessage} Got [${numString?.trim() as string}]`;
      return offsetValue;
    }
  }

  private static doRandomDate(maxAndMinDates: string): number {
    // Expect exactly two comma-separated epoch numbers: "fromEpoch,toEpoch".
    const maxAndMin: string[] = maxAndMinDates.split(",");

    if (maxAndMin.length != 2 || Number.isNaN(+maxAndMin[0]) || Number.isNaN(+maxAndMin[1]))
      throw new Error(`Invalid Maximum and Minimum dates. Expect {random;date(fromEpoch,toEpoch);<format>}. Max/min was: [${maxAndMinDates}]`);
    const minDate = Number(maxAndMin[0]);
    const maxDate = Number(maxAndMin[1]);
    if (minDate > maxDate) throw new Error(`Minimum date greater than maximum!! Max/min was: [${maxAndMinDates}]`);
    // Pick a random whole number of days within the inclusive range and add that many days
    // (in milliseconds) onto minDate.
    return minDate + Math.abs(Utils.getRandomInt(0, this.numberOfDays(minDate, maxDate) - 1)) * 1000 * 60 * 60 * 24;
  }

  /**
   * Throws a clear, actionable error if `zone` is not a real, recognised IANA timezone name.
   * Shared validation for the `timezone`/`diff` tokens and the `date` token's optional 3rd
   * (zone) part — every one of them accepts a raw IANA zone string, whether typed directly or
   * produced by nesting `[[timezone|...]]]`, so they all validate it identically.
   *
   * Deliberately validated by attempting to construct an `Intl.DateTimeFormat` with the given
   * zone, rather than checking membership in `Intl.supportedValuesOf("timeZone")` — the latter
   * only lists ICU's *canonical* zone names, which excludes plenty of names testers would
   * reasonably expect to work (e.g. "UTC" itself, or "Asia/Kathmandu" — ICU's canonical name
   * for the same zone is "Asia/Katmandu"). `Intl.DateTimeFormat` resolves the full alias table
   * the runtime actually understands, matching what every other `Intl`/date-fns-tz call in
   * this file will do with the same string anyway.
   * @param zone - Candidate IANA zone name, e.g. "Europe/London"
   * @param context - Short description of which token/argument is being validated, prefixed
   *   onto the error message so a tester can tell exactly where the bad zone name was typed.
   * @throws If `zone` is not a timezone name/alias the runtime recognises
   */
  private static assertValidIANAZone(zone: string, context: string): void {
    try {
      // Constructing this throws synchronously on an unrecognised zone — the formatter
      // instance itself is discarded, this call's only job is the validation side effect.
      new Intl.DateTimeFormat(undefined, { timeZone: zone });
    } catch {
      throw new Error(`${context}: [${zone}] is not a recognised IANA timezone name (e.g. "Europe/London", "Africa/Lusaka", "UTC").`);
    }
  }

  private static doTimezoneToken(tokenBody: string): string {

    ////////////////////////////////////////////////////
    //
    // Resolves a `[[timezone|<IANAZoneName>]]` token: just validates the given zone name and
    // returns it unchanged — the "standard form" other tokens (date's zone part, diff) expect
    // is simply the validated IANA zone string itself, so this doubles as both a validator and
    // a pass-through, nestable directly inside those other tokens' own argument lists.

    const zone = tokenBody.trim();
    this.assertValidIANAZone(zone, "Timezone token");
    return zone;
  }

  private static doDiffToken(tokenBody: string): string {

    ////////////////////////////////////////////////////
    //
    // Resolves a `[[diff|<zoneA>|<zoneB>]]` token: validates both zone names, looks up each
    // one's current UTC offset (DST-aware, since it's resolved "now" rather than from a fixed
    // per-zone constant), and returns zoneA's offset minus zoneB's, in hours, as a plain
    // decimal number string. "UTC" is itself a valid zone, so a single zone's offset from UTC
    // is just this same token with "UTC" as the other side.

    const [zoneA, zoneB] = StringUtils.splitRemaining(tokenBody, this._delimiter, 2);
    // Both zones are mandatory — there's no meaningful "diff" with only one side given.
    if (!zoneA || !zoneB) throw new Error(`Diff token needs 2 IANA zone names (IE. {{diff;<zoneA>;<zoneB>}}). Got [${tokenBody}]`);
    this.assertValidIANAZone(zoneA, "Diff token's first zone");
    this.assertValidIANAZone(zoneB, "Diff token's second zone");

    // Compute each zone's offset from UTC, in milliseconds, at the current moment.
    const now = Date.now();
    const offsetA = getTimezoneOffset(zoneA, now);
    const offsetB = getTimezoneOffset(zoneB, now);
    // zoneA's offset minus zoneB's, converted to hours — this gives "how many hours ahead of
    // zoneB is zoneA", matching the argument order the tester typed.
    const diffHours = (offsetA - offsetB) / (1000 * 60 * 60);
    // Round to 2 decimal places (covers every real-world zone, including 15/45-minute-offset
    // ones) and let Number→String drop any trailing zeros, so whole-hour diffs read as plain
    // integers ("5", not "5.00") rather than always carrying two decimal places.
    const roundedDiffHours = Math.round(diffHours * 100) / 100;
    Log.writeLine(LogLevels.TestDebug, `Diff between [${zoneA}] and [${zoneB}] is [${roundedDiffHours}] hours`);
    return String(roundedDiffHours);
  }

  private static numberOfDays(minDate: number, maxDate: number): number {
    Log.writeLine(LogLevels.TestDebug, `Min date [${minDate}], Max date[${maxDate}]`);
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    // Inclusive day count between the two epochs (order-independent, via Math.abs) — +1 so
    // the range includes both endpoints as valid days, not just the days strictly between.
    const numberOfDays = Math.floor(Math.abs((minDate - maxDate) / MS_PER_DAY)) + 1;
    Log.writeLine(LogLevels.TestDebug, `Min date [${minDate}], Max date[${maxDate}].  Number of days [${numberOfDays}]`);
    return numberOfDays;
  }

  private static doRandomFloat(limits: string): number {
    // Expect exactly two comma-separated numbers: "min,max".
    const minimumAndMaximum: string[] = limits.split(",");

    if (minimumAndMaximum.length != 2)
      throw new Error(`Invalid Maximum and Minimum floats. Expect {{random.float(min;max),<format>}}. Max/min was: [${limits}]`);
    const min = parseFloat(minimumAndMaximum[0]);
    const max = parseFloat(minimumAndMaximum[1]);

    // Validate min and max separately so the error pinpoints which one is actually invalid.
    if (isNaN(min)) throw new Error(`Invalid Minimum float. Expect {{random.float(min;max),<format>}}. Max/min was: [${limits}]`);
    if (isNaN(max)) throw new Error(`Invalid Maximum float. Expect {{random.float(min;max),<format>}}. Max/min was: [${limits}]`);

    return Utils.getRandomFloat(min, max);
  }
}

class InnermostToken {
  private tokenPreamble: string;
  private tokenPostamble: string;
  private _childToken: string;
  private foundToken: boolean;
  private escapeChar: string;

  constructor(inputString: string, StartTokenChar: string, EndTokenChar: string, EscapeChar: string) {

    ////////////////////////////////////////////////////
    //
    // Locates exactly one token boundary pair within inputString — the innermost one if
    // tokens are nested — by finding the FIRST (leftmost) non-escaped `]]`, then scanning
    // backward from there for the nearest non-escaped `[[`. Searching for the end sequence
    // first and the start sequence second (rather than the more obvious start-first) is what
    // makes this naturally resolve the innermost token: an outer `[[` further to the left
    // would only be found if there were no closer, more-nested `[[` between it and this `]]`.

    let startIndex = -1;
    let endIndex = -1;

    this.escapeChar = EscapeChar;
    // Find the first (leftmost) non-escaped end token sequence. Because we search left-to-right this naturally
    // gives us the innermost token when tokens are nested.
    for (let index = 0; index <= inputString.length - EndTokenChar.length; index++) {
      if (inputString.startsWith(EndTokenChar, index) && !this.isEscaped(inputString, index)) {
        endIndex = index;
        break;
      }
    }

    // Now scan right-to-left from just before the end sequence to find the matching non-escaped start sequence.
    if (endIndex !== -1) {
      for (let index = endIndex - 1; index >= 0; index--) {
        if (inputString.startsWith(StartTokenChar, index) && !this.isEscaped(inputString, index)) {
          startIndex = index;
          break;
        }
      }
    }

    if (startIndex !== -1 && endIndex !== -1) {
      // Found a complete, matched token — split the string into the three parts around it.
      this.tokenPreamble = inputString.substring(0, startIndex);
      this.tokenPostamble = inputString.substring(endIndex + EndTokenChar.length);
      this._childToken = inputString.substring(startIndex, endIndex); // includes StartTokenChar, excludes EndTokenChar
    } else {
      // No complete token found at all (no `]]`, or a `]]` with no matching `[[` before it)
      // — treat the whole input as preamble, with no token and no postamble.
      this.tokenPreamble = inputString;
      this.tokenPostamble = "";
      this._childToken = "";
    }
    this.foundToken = startIndex !== -1 && endIndex !== -1;
  }

  public get preamble(): string {
    return this.tokenPreamble;
  }

  public get postamble(): string {
    return this.tokenPostamble;
  }

  public get childToken(): string {
    return this._childToken;
  }

  public get hasToken(): boolean {
    return this.foundToken;
  }

  private isEscaped(fullString: string, positionToTest: number): boolean {

    ////////////////////////////////////////////////////
    //
    // Determines whether the boundary sequence starting at positionToTest is escaped, by
    // counting the run of consecutive escape characters immediately before it: an odd count
    // means the boundary itself is escaped (one escape char "consumed" by it, the rest
    // pairing off), an even count means it's not (the run is just literal escaped-escape-char
    // pairs with nothing left over to escape the boundary).

    let index: number;
    let escapeCharCount = 0;
    let returnIsEscaped = false;

    // Nothing can precede position 0, so it can never be escaped.
    if (positionToTest > 0) {
      index = positionToTest;
      // Walk backward counting consecutive escape chars, stopping at the first non-escape
      // char (or the start of the string).
      while (!(--index < 0)) {
        if (fullString[index] == this.escapeChar) {
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
 * Signature for a custom token handler registered via {@link Detokeniser.addCallback}.
 *
 * May be synchronous or asynchronous — {@link Detokeniser.doAsync}, the only entry point,
 * always awaits the result either way.
 *
 * @param token - Full token body without `[[` / `]]` endstops, e.g. `"mytype|arg1|arg2"` (delimiter is always `|`)
 * @returns The replacement string, a Promise resolving to it, or `undefined` to pass to the next handler
 */
export interface Detokeniser_Callback {
  (token: string): string | undefined | Promise<string | undefined>;
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
  export type DoOptions = Detokeniser_DoOptions;
}
