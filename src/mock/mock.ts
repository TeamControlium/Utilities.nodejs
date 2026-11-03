import { STATUS_CODES } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Utils } from '../utils/utils.js';
import { JsonUtils, Log, Logger, LogLevels } from '../index.js';

/**
 * Static HTTP request interception and mocking utility for test suites.
 *
 * `Mock` is designed to sit between a test framework's network interceptor
 * (e.g. Playwright's `page.route`) and the application under test. Every
 * outgoing request from the AUT must be forwarded to {@link Mock.processInterceptedRequest}, which
 * decides how to handle it based on the registered listeners.
 *
 * **Default-deny**: any request that does not match a listener is blocked and
 * recorded as an `unmatched` transaction. The test suite has full control —
 * nothing reaches the network unless explicitly permitted.
 *
 * **All transactions are stored** regardless of outcome, so test steps can
 * later inspect real and mocked traffic via {@link Mock.getTransactions}.
 *
 * All methods are static — no instantiation is required. Call {@link Mock.reset}
 * in `beforeEach` / `afterEach` hooks to start each test with a clean slate.
 *
 * ---
 *
 * ### Local mode (default)
 *
 * `Mock` runs in the same process as the test framework. When a `passthrough`
 * listener matches, `Mock` fetches the real response itself and returns it
 * directly. {@link Mock.processInterceptedRequest} always resolves to a {@link Mock.InterceptResult}
 * with `action: 'fulfill'` or `action: 'block'`.
 *
 * ### Delegate mode
 *
 * Enable with `Mock.delegateMode = true` when `Mock` is hosted in a remote
 * server (e.g. a mock proxy) and the caller — not `Mock` — is better placed
 * to perform the real network fetch. In this mode, when a `passthrough`
 * listener matches, {@link Mock.processInterceptedRequest} returns `action: 'passthrough'`
 * plus a `correlationId`. The caller fetches the real response and reports it
 * back via {@link Mock.completePassthrough}, allowing `Mock` to record the
 * full transaction. Use {@link Mock.getPendingTransactions} to detect
 * passthrough calls that were never completed.
 *
 * @example
 * ```typescript
 * // Local mode — Playwright adapter
 * Mock.reset();
 * Mock.addListener('get-users',
 *   ['$[?(@.url =~ /api\\/users/)]', '$[?(@.method == "GET")]'],
 *   { status: 200, body: [{ id: 1, name: 'Alice' }] }
 * );
 *
 * await page.route('**\/*', async (route) => {
 *   const result = await Mock.intercept({
 *     url: route.request().url(),
 *     method: route.request().method(),
 *     headers: await route.request().allHeaders(),
 *   });
 *   if (result.action === 'fulfill') {
 *     await route.fulfill({ status: result.response.status });
 *   } else {
 *     await route.abort();
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Delegate mode — remote mock server
 * Mock.delegateMode = true;
 *
 * // In the interceptor callback:
 * const result = await Mock.intercept(request);
 * if (result.action === 'passthrough') {
 *   const real = await myFetch(request);
 *   Mock.completePassthrough(result.correlationId, real);
 *   return real;
 * }
 * ```
 */
export class Mock {
  private static listeners = new Map<string, Mock.Listener>();
  private static transactions: Mock.Transaction[] = [];
  private static transactionCounter = 0;
  private static pendingTransactions = new Map<string, Mock.PendingTransaction>();
  private static _delegateMode = false;

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * When `true`, passthrough requests are delegated to the caller rather than
   * fetched by `Mock` itself. {@link Mock.processInterceptedRequest} returns
   * `action: 'passthrough'` with a `correlationId` for the caller to use when
   * reporting the real response back via {@link Mock.completePassthrough}.
   *
   * Defaults to `false` (local mode — `Mock` fetches passthroughs itself).
   *
   * @example
   * Mock.delegateMode = true;
   */
  static set delegateMode(value: boolean) {
    // value must actually be a boolean — fail fast and clearly if not.
    Utils.assertType(value, 'boolean', 'delegateMode', 'value');
    // Record the mode change in the log before applying it, so the log shows exactly when
    // (and to what) delegate mode changed.
    Log.writeLine(LogLevels.TestInformation, `Mock: delegate mode ${value ? 'enabled' : 'disabled'}`);
    // Store the new mode on the private backing field.
    Mock._delegateMode = value;
  }

  static get delegateMode(): boolean {
    return Mock._delegateMode;
  }

  // ── Listener management ────────────────────────────────────────────────────

  /**
   * Registers a named listener that matches intercepted requests and defines
   * how `Mock` should respond to them.
   *
   * Listeners are evaluated in registration order. The first listener whose
   * every matcher returns a result wins. If a listener with the same `name`
   * already exists it is replaced and a warning is logged.
   *
   * @param name - Unique name for this listener. Used as the key in the
   *   listener store and appears in transaction records and log output.
   *   Must be a non-empty string.
   *
   * @param matchers - One or more JSONPath expressions evaluated against the
   *   {@link Mock.Request} object. All expressions must return at least one
   *   result for the listener to match (AND logic). Each expression is
   *   validated for syntactic correctness at registration time — an invalid
   *   expression throws immediately rather than silently failing at intercept
   *   time. Must be a non-empty array of non-empty strings.
   *
   * @param action - What to do when this listener matches:
   *   - `'block'` — abort the request and return `action: 'block'` to the caller.
   *   - `'passthrough'` — forward the request to the real endpoint (or delegate
   *     to the caller in {@link Mock.delegateMode}) and return the real response.
   *   - {@link Mock.Response} — return the supplied response object directly
   *     without touching the network. `status` must be a valid HTTP status
   *     code (100–599).
   *
   * @param delayMs - Optional delay in milliseconds applied before the
   *   response is returned, whether mocked, real, or blocked. Useful for
   *   simulating slow networks. Must be a non-negative finite number.
   *   Defaults to `0` (no delay).
   *
   * @throws {Error} If any argument fails validation.
   *
   * @example
   * // Block all requests to an analytics endpoint
   * Mock.addListener('block-analytics', ['$[?(@.url =~ /analytics/)]'], 'block');
   *
   * @example
   * // Return a mock response with a 2-second simulated delay
   * Mock.addListener('slow-login',
   *   ['$[?(@.url =~ /api\\/login/)]'],
   *   { status: 200, headers: { 'content-type': 'application/json' }, body: { token: 'abc' } },
   *   2000
   * );
   */
  static addListener(name: string, matchers: string[], action: Mock.ListenerAction, delayMs = 0): void {

    ////////////////////////////////////////////////////
    //
    // Validates every argument up front (name, matchers, action, delayMs) — throwing on the
    // first problem found rather than registering a half-valid listener — then logs and
    // stores the listener, replacing any existing one with the same name.

    // name must be a non-empty string.
    Utils.assertType(name, 'string', 'addListener', 'name');
    if (name.trim().length === 0) Mock.throwError('addListener', '[name] must not be empty');

    // matchers must be a non-empty array.
    if (!Array.isArray(matchers)) {
      Mock.throwError('addListener', `[matchers] must be a string array, got [${typeof matchers}]`);
    }
    if (matchers.length === 0) {
      Mock.throwError('addListener', '[matchers] array must not be empty');
    }
    // Check every matcher individually: must be a non-empty string, and must be syntactically
    // valid JSONPath — validated here, at registration time, by actually running it against an
    // empty object, so a malformed expression throws immediately rather than silently failing
    // (or always "not matching") every time a request is later intercepted.
    matchers.forEach((matcher, index) => {
      if (typeof matcher !== 'string') {
        Mock.throwError('addListener', `[matchers[${index}]] must be a string, got [${typeof matcher}]`);
      }
      if (matcher.trim().length === 0) {
        Mock.throwError('addListener', `[matchers[${index}]] must not be empty`);
      }
      try {
        JsonUtils.getMatchingJSONPropertyCount({}, matcher);
      } catch (e) {
        Mock.throwError('addListener', `Matcher item [${index}] is not valid JSONPath syntax: "${matcher}". ${Utils.errorMessage(e)}`);
      }
    });

    // action is either one of the two literal strings 'block'/'passthrough' (nothing further
    // to validate), or it must be a genuine Mock.Response object — validate that shape here.
    if (action !== 'block' && action !== 'passthrough') {
      // Must be a plain, non-null, non-array object to even be a candidate Response.
      if (action === null || typeof action !== 'object' || Array.isArray(action)) {
        Mock.throwError('addListener', `[action] must be 'block', 'passthrough', or a Mock.Response object, got [${action === null ? 'null' : typeof action}]`);
      }
      const response = action as Mock.Response;
      // status must be a valid HTTP status code.
      if (typeof response.status !== 'number' || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        Mock.throwError('addListener', `[action.status] must be a valid HTTP status code (100-599), got [${response.status}]`);
      }
      // headers, if given at all, must be a plain object (not null, not an array).
      if (response.headers !== undefined && (typeof response.headers !== 'object' || response.headers === null || Array.isArray(response.headers))) {
        Mock.throwError('addListener', `[action.headers] must be a plain object if provided`);
      }
      // statusText wasn't supplied by the caller — default it from Node's own HTTP status-code
      // table. '_undefined' is a deliberate escape hatch letting a caller force statusText to
      // actually be undefined (rather than defaulted), since plain `undefined` can't be
      // distinguished from "not supplied" once it's sitting on the object.
      if (Utils.isUndefined(action.statusText))
        action.statusText = STATUS_CODES[action.status] ?? undefined;
      else if (action.statusText === '_undefined') action.statusText = undefined;
    }

    // delayMs must be a non-negative finite number.
    Utils.assertType(delayMs, 'number', 'addListener', 'delayMs');
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      Mock.throwError('addListener', `[delayMs] must be a non-negative finite number, got [${delayMs}]`);
    }

    // Warn (but don't fail) if this name already has a listener registered — it's about to be
    // silently replaced below.
    if (Mock.listeners.has(name)) {
      Log.writeLine(LogLevels.Warning, `Mock.addListener: replacing existing listener <${name}>`);
    }

    // Build a human-readable description of the action for the log line below: the two literal
    // actions get a short label, while an actual Response object gets pretty-printed in full.
    const isBlockOrPassthrough = action === 'block' || action === 'passthrough';
    const actionText = (() => {
      if (action === 'block') return 'Block';
      if (action === 'passthrough') return 'Passthrough';
      return JSON.stringify(action, null, 2);
    })();
    // Log the full listener registration — name, delay (if any), every matcher, and the
    // resolved action — before actually storing it.
    Log.writeLine(LogLevels.TestInformation, `Add mock listener <${name}${delayMs > 0 ? ` (Delay by ${delayMs}mS)` : ''}>:\nMatcher: ${matchers.join('\nMatcher: ')}\nAction:${isBlockOrPassthrough ? ` ${actionText}` : `\n${actionText}`}`, { suppressMultilinePreamble: true });
    // Store (or replace) the listener, keyed by name.
    Mock.listeners.set(name, { name, matchers, action, delayMs });
  }

  /**
   * Removes a previously registered listener by name.
   *
   * If no listener with the given name exists, a warning is logged and the
   * call is a no-op.
   *
   * @param name - Name of the listener to remove. Must be a non-empty string.
   * @throws {Error} If `name` is not a non-empty string.
   *
   * @example
   * Mock.removeListener('get-users');
   */
  static removeListener(name: string): void {
    // name must be a non-empty string.
    Utils.assertType(name, 'string', 'removeListener', 'name');
    if (name.trim().length === 0) Mock.throwError('removeListener', '[name] must not be empty');
    // No listener registered under this name — warn and return without touching anything.
    if (!Mock.listeners.has(name)) {
      Log.writeLine(LogLevels.Warning, `Mock.removeListener: no listener named <${name}> exists — nothing removed`);
      return;
    }
    // Listener exists — log the removal, then actually delete it.
    Log.writeLine(LogLevels.TestInformation, `Mock: Remove listener <${name}>`);
    Mock.listeners.delete(name);
  }

  /**
   * Removes all registered listeners.
   *
   * Transaction history and pending transactions are unaffected. Use
   * {@link Mock.reset} to clear everything in a single call.
   */
  static clearListeners(): void {
    Log.writeLine(LogLevels.TestInformation, `Mock: Clear all listeners (${Mock.listeners.size} removed)`);
    Mock.listeners.clear();
  }

  // ── Intercept ──────────────────────────────────────────────────────────────

  /**
   * Processes an intercepted HTTP request and returns a {@link Mock.InterceptResult}
   * describing what the caller should do.
   *
   * Listeners are evaluated in registration order; the first full match wins.
   * Every request — matched or not — is recorded in the transaction history.
   * If the matching listener has a `delayMs`, the delay is applied before the
   * result is returned.
   *
   * | Situation | `action` returned | Transaction type |
   * |---|---|---|
   * | Matched → mock response | `'fulfill'` | `'mocked'` |
   * | Matched → passthrough, local mode | `'fulfill'` | `'passthrough'` |
   * | Matched → passthrough, delegate mode | `'passthrough'` | pending until {@link Mock.completePassthrough} |
   * | Matched → block | `'block'` | `'blocked'` |
   * | No listener matched | `'block'` | `'unmatched'` |
   *
   * @param interceptedRequest - The intercepted request. Must be a non-null object with
   *   non-empty `url` and `method` string properties.
   *
   * @returns A promise resolving to a {@link Mock.InterceptResult}.
   *
   * @throws {Error} If `request` fails validation.
   *
   * @example
   * const result = await Mock.intercept(request);
   * if (result.action === 'fulfill') {
   *   respondWith(result.response);
   * } else if (result.action === 'passthrough') {
   *   // delegate mode only
   *   const real = await fetch(request.url);
   *   Mock.completePassthrough(result.correlationId, real);
   *   respondWith(real);
   * } else {
   *   abortRequest();
   * }
   */
  static async processInterceptedRequest(interceptedRequest: Mock.Request): Promise<Mock.InterceptResult> {

    ////////////////////////////////////////////////////
    //
    // Validates the intercepted request, finds the first listener (if any) whose matchers all
    // match it, then dispatches on that listener's action — block / passthrough (local or
    // delegate mode) / mocked response — applying any configured delay, recording the outcome
    // as a transaction, and returning the InterceptResult the caller should act on. No listener
    // matching is itself a result (default-deny): it's recorded and blocked exactly like an
    // explicit 'block' action.

    // request must be a non-null, non-array object.
    if (interceptedRequest === null || interceptedRequest === undefined || typeof interceptedRequest !== 'object' || Array.isArray(interceptedRequest)) {
      Mock.throwError('intercept', `[request] must be a non-null object, got [${interceptedRequest === null ? 'null' : typeof interceptedRequest}]`);
    }
    // request.url must be a non-empty string.
    if (typeof interceptedRequest.url !== 'string' || interceptedRequest.url.trim().length === 0) {
      Mock.throwError('intercept', `[request.url] must be a non-empty string, got [${typeof interceptedRequest.url}]`);
    }
    // request.method must be a non-empty string.
    if (typeof interceptedRequest.method !== 'string' || interceptedRequest.method.trim().length === 0) {
      Mock.throwError('intercept', `[request.method] must be a non-empty string, got [${typeof interceptedRequest.method}]`);
    }
    // request.headers, if given at all, must be a plain object.
    if (interceptedRequest.headers !== undefined && interceptedRequest.headers !== null && (typeof interceptedRequest.headers !== 'object' || Array.isArray(interceptedRequest.headers))) {
      Mock.throwError('intercept', `[request.headers] must be a plain object if provided`);
    }

    Log.writeLine(LogLevels.TestDebug, `Mock.intercept: ${interceptedRequest.method} ${interceptedRequest.url}`);

    // Find the first registered listener (in registration order) whose every matcher matches
    // this request.
    const listener = Mock.findMatch(interceptedRequest);

    // No listener matched — default-deny: record as unmatched and block.
    if (!listener) {
      Log.writeLine(LogLevels.TestInformation, `Mock.intercept: no listener matched — blocking`);
      Mock.record({ type: 'unmatched', request: interceptedRequest });
      return { action: 'block' };
    }

    Log.writeLine(LogLevels.TestDebug, `Mock.intercept: matched listener <${listener.name}>`);

    // Apply the listener's configured delay (if any) before doing anything else — this
    // simulates network latency regardless of which action branch runs next.
    if (listener.delayMs > 0) {
      Log.writeLine(LogLevels.TestDebug, `Mock.intercept: delaying ${listener.delayMs}ms`);
      await Utils.sleep(listener.delayMs);
    }

    // Listener explicitly blocks — record as blocked and abort.
    if (listener.action === 'block') {
      Log.writeLine(LogLevels.TestInformation, `Mock.intercept: blocking request`);
      Mock.record({ type: 'blocked', listenerName: listener.name, request: interceptedRequest });
      return { action: 'block' };
    }

    // Listener wants the request forwarded to the real endpoint.
    if (listener.action === 'passthrough') {
      if (Mock._delegateMode) {
        // Delegate mode — Mock itself doesn't fetch the real response; it hands back a
        // correlationId and stashes a pending transaction, to be completed later by the
        // caller via completePassthrough once it has fetched the real response itself.
        const correlationId = randomUUID();
        Log.writeLine(LogLevels.TestInformation, `Mock.intercept: delegating passthrough (correlationId: ${correlationId})`);
        Mock.pendingTransactions.set(correlationId, {
          correlationId,
          timestamp: new Date(),
          listenerName: listener.name,
          request: interceptedRequest,
        });
        return { action: 'passthrough', correlationId };
      }
      // Local mode — Mock fetches the real response itself, records the full transaction
      // immediately, and returns it ready to fulfil.
      Log.writeLine(LogLevels.TestInformation, `Mock.intercept: passing through to real endpoint`);
      const response = await Mock.fetchReal(interceptedRequest);
      Mock.record({ type: 'passthrough', listenerName: listener.name, request: interceptedRequest, response });
      return { action: 'fulfill', response };
    }

    // Remaining case: the listener's action is a literal Mock.Response object — return it
    // directly as a mocked response, without touching the network.
    const response = listener.action as Mock.Response;
    Log.writeLine(LogLevels.TestInformation, `Mock.intercept: returning mocked response (status ${response.status})`);
    Mock.record({ type: 'mocked', listenerName: listener.name, request: interceptedRequest, response });
    return { action: 'fulfill', response };
  }

  /**
   * Completes a delegated passthrough by supplying the real response the caller
   * fetched. Records the full transaction and removes the pending entry.
   *
   * Only relevant when {@link Mock.delegateMode} is `true`. The `correlationId`
   * must match one previously returned by {@link Mock.processInterceptedRequest}.
   *
   * @param correlationId - The UUID returned in the `action: 'passthrough'`
   *   result from {@link Mock.processInterceptedRequest}. Must be a non-empty string that
   *   matches a pending transaction.
   *
   * @param response - The real response the caller received from the endpoint.
   *   Must be a valid {@link Mock.Response} with a status code of 100–599.
   *
   * @throws {Error} If `correlationId` is invalid, unknown, or already completed.
   * @throws {Error} If `response` fails validation.
   *
   * @example
   * const result = await Mock.intercept(request);
   * if (result.action === 'passthrough') {
   *   const real = await myFetch(request);
   *   Mock.completePassthrough(result.correlationId, real);
   * }
   */
  static completePassthrough(correlationId: string, response: Mock.Response): void {
    // correlationId must be a non-empty string.
    Utils.assertType(correlationId, 'string', 'completePassthrough', 'correlationId');
    if (correlationId.trim().length === 0) {
      Mock.throwError('completePassthrough', '[correlationId] must not be empty');
    }
    // It must actually correspond to a passthrough still awaiting completion — not unknown,
    // not already completed, not cleared by a reset() in between.
    if (!Mock.pendingTransactions.has(correlationId)) {
      Mock.throwError('completePassthrough', `[correlationId] "${correlationId}" does not match any pending passthrough — it may be unknown, already completed, or cleared by reset()`);
    }

    // response must be a non-null, non-array object.
    if (response === null || response === undefined || typeof response !== 'object' || Array.isArray(response)) {
      Mock.throwError('completePassthrough', `[response] must be a non-null object, got [${response === null ? 'null' : typeof response}]`);
    }
    // response.status must be a valid HTTP status code.
    if (typeof response.status !== 'number' || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      Mock.throwError('completePassthrough', `[response.status] must be a valid HTTP status code (100-599), got [${response.status}]`);
    }
    // response.headers, if given at all, must be a plain object.
    if (response.headers !== undefined && (typeof response.headers !== 'object' || response.headers === null || Array.isArray(response.headers))) {
      Mock.throwError('completePassthrough', `[response.headers] must be a plain object if provided`);
    }

    // Look up the pending transaction's original request/listener details (stashed when the
    // passthrough was first delegated), log completion, remove it from the pending set, then
    // record it as a completed passthrough transaction alongside everything else.
    const pending = Mock.pendingTransactions.get(correlationId)!;
    Log.writeLine(LogLevels.TestInformation, `Mock.completePassthrough: completing passthrough for correlationId ${correlationId} (status ${response.status})`);
    Mock.pendingTransactions.delete(correlationId);
    Mock.record({ type: 'passthrough', listenerName: pending.listenerName, request: pending.request, response });
  }

  // ── Transaction history ────────────────────────────────────────────────────

  /**
   * Returns all completed transactions in chronological order.
   *
   * Includes mocked, passthrough (completed), blocked, and unmatched entries.
   * Delegated passthroughs awaiting {@link Mock.completePassthrough} appear in
   * {@link Mock.getPendingTransactions} instead.
   *
   * @returns A read-only array of {@link Mock.Transaction} objects.
   *
   * @example
   * const blocked = Mock.getTransactions().filter(t => t.type === 'blocked');
   */
  static getTransactions(): readonly Mock.Transaction[] {
    return Mock.transactions;
  }

  /**
   * Clears all completed transactions and resets the transaction counter.
   *
   * Pending passthrough transactions and registered listeners are unaffected.
   * Use {@link Mock.reset} to clear everything in a single call.
   */
  static clearTransactions(): void {
    // Log how many transactions are about to be discarded before actually clearing them.
    Log.writeLine(LogLevels.TestInformation, `Mock: Clear transaction history (${Mock.transactions.length} removed)`);
    // Empty the transaction list and reset the id counter so the next transaction starts
    // again from 'txn-1'.
    Mock.transactions = [];
    Mock.transactionCounter = 0;
  }

  /**
   * Returns all delegated passthrough transactions that have not yet been
   * completed via {@link Mock.completePassthrough}.
   *
   * Use this in test assertions to verify no passthrough calls were abandoned,
   * or to diagnose remote fetch failures.
   *
   * Only populated when {@link Mock.delegateMode} is `true`.
   *
   * @returns A read-only array of {@link Mock.PendingTransaction} objects.
   *
   * @example
   * // Assert no orphaned passthroughs after a test
   * expect(Mock.getPendingTransactions()).toHaveLength(0);
   */
  static getPendingTransactions(): readonly Mock.PendingTransaction[] {
    return [...Mock.pendingTransactions.values()];
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /**
   * Clears all listeners, completed transactions, pending transactions, and
   * resets delegate mode to `false`.
   *
   * Call this in `beforeEach` or `afterEach` hooks to guarantee a clean slate
   * between tests.
   *
   * @example
   * beforeEach(() => {
   *   Mock.reset();
   *   Mock.addListener('static-assets', [...], 'passthrough');
   * });
   */
  static reset(): void {
    // Log the counts of everything about to be cleared before actually clearing any of it.
    Log.writeLine(LogLevels.TestInformation, `Mock: Reset (${Mock.listeners.size} listeners, ${Mock.transactions.length} transactions, ${Mock.pendingTransactions.size} pending cleared)`);
    // Clear registered listeners.
    Mock.listeners.clear();
    // Clear completed transaction history and reset its id counter.
    Mock.transactions = [];
    Mock.transactionCounter = 0;
    // Clear any passthroughs still awaiting completion.
    Mock.pendingTransactions.clear();
    // Reset delegate mode back to its default (local mode).
    Mock._delegateMode = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private static throwError(funcName: string, message: string): never {
    const errorText = `Mock.${funcName}: ${message}`;
    Log.logErrorAndThrow(errorText, { stackOffset: 1 });
  }

  private static findMatch(request: Mock.Request): Mock.Listener | undefined {

    ////////////////////////////////////////////////////
    //
    // Walks every registered listener in registration order, returning the first one whose
    // every matcher matches the request (AND logic across matchers). A JSONPath evaluation
    // error on a single matcher — or any other unexpected error while evaluating a whole
    // listener — is treated as a non-match for that matcher/listener rather than aborting the
    // whole search, so one bad listener can't stop every other listener from being considered.

    Logger.writeLine(LogLevels.FrameworkInformation, `Checking if any listeners for [${request.url} (${request.method})]`);
    for (const listener of Mock.listeners.values()) {
      try {
        // A listener matches only if every one of its matchers matches (AND, not OR).
        const allMatch = listener.matchers.every((matcher) => {
          try {
            // Log the request being tested, for diagnostic visibility.
            const x = JSON.stringify(request, null, 2);
            Logger.writeLine(LogLevels.TestInformation, x);
            // Wrap the request in a single-element array since JsonUtils' JSONPath matching
            // expects an array-shaped root to query against; a non-zero match count means
            // this matcher matched.
            const matched = JsonUtils.getMatchingJSONPropertyCount([request] as unknown as object, matcher) > 0;
            if (matched) {
              Logger.writeLine(LogLevels.FrameworkDebug, `Matched on [${matcher}]`);
              return true;
            }
            return false;
          } catch (e) {
            // A single matcher throwing (e.g. a runtime JSONPath evaluation error) doesn't
            // abort the listener — treat it as that matcher simply not matching.
            Log.writeLine(LogLevels.Warning, `Mock: JSONPath evaluation error in listener <${listener.name}> for path "${matcher}": ${Utils.errorMessage(e)} — treating as non-match`);
            return false;
          }
        });

        // All matchers matched — this listener wins; stop searching and return it.
        if (allMatch) return listener;
        else {
          Logger.writeLine(LogLevels.FrameworkDebug, 'No matches');
        }
      } catch (e) {
        // Something unexpected went wrong evaluating this listener as a whole — log it and
        // move on to the next listener rather than letting one bad listener abort the search.
        Log.writeLine(LogLevels.Warning, `Mock: Unexpected error evaluating listener <${listener.name}>: ${Utils.errorMessage(e)} — skipping`);
      }
    }
    // No listener matched.
    return undefined;
  }

  private static async fetchReal(request: Mock.Request): Promise<Mock.Response> {

    ////////////////////////////////////////////////////
    //
    // Performs the actual real-network fetch for a local-mode passthrough, converting the
    // response into a Mock.Response shape. Any network-level failure (DNS, connection refused,
    // timeout, etc.) is caught and turned into a synthetic 502 response rather than letting the
    // exception propagate — a passthrough failure should surface to the test as a bad response,
    // not as an unhandled rejection crashing the interceptor.

    Log.writeLine(LogLevels.TestDebug, `Mock.fetchReal: ${request.method} ${request.url}`);
    try {
      // Issue the real request, serialising a non-null body to JSON (fetch itself doesn't do
      // this automatically).
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body != null ? JSON.stringify(request.body) : undefined,
      });

      // Read the response body as text first, then opportunistically try to parse it as JSON
      // — falling back to the raw text if it isn't valid JSON, since a response body isn't
      // guaranteed to be JSON at all.
      const body = await response.text().then((text) => {
        try { return JSON.parse(text); } catch { return text; }
      });

      // Flatten the Headers object into a plain key/value record, matching Mock.Response's
      // shape.
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });

      Log.writeLine(LogLevels.TestDebug, `Mock.fetchReal: received ${response.status} from ${request.url}`);
      return { status: response.status, headers, body };
    } catch (e) {
      // The fetch itself failed (not an HTTP error status — an actual network-level failure)
      // — report it as a synthetic 502 Bad Gateway response rather than throwing, so the
      // caller still gets a well-formed Mock.Response to work with.
      const message = Utils.errorMessage(e);
      Log.writeLine(LogLevels.Error, `Mock.fetchReal: network error fetching ${request.url}: ${message}`);
      return { status: 502, headers: {}, body: `Mock passthrough network error: ${message}` };
    }
  }

  private static record(entry: Omit<Mock.Transaction, 'id' | 'timestamp'>): void {
    Mock.transactions.push({
      id: `txn-${++Mock.transactionCounter}`,
      timestamp: new Date(),
      ...entry,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Mock {
  /**
   * Represents an HTTP request as seen by the interceptor.
   *
   * The `url`, `method`, and `headers` fields are required. Additional
   * properties (e.g. framework-specific metadata) may be included and are
   * available to JSONPath matchers.
   */
  export interface Request {
    /** The fully-qualified request URL. */
    url: string;
    /** HTTP method in uppercase, e.g. `'GET'`, `'POST'`. */
    method: string;
    /** Request headers as a plain key/value object. */
    headers: Record<string, string>;
    /** Parsed request body, if present. */
    body?: unknown;
    /** Any additional properties provided by the framework adapter. */
    [key: string]: unknown;
  }

  /**
   * Represents an HTTP response returned to the AUT, whether real or mocked.
   */
  export interface Response {
    /** HTTP status code, e.g. `200`, `404`. Must be 100–599. */
    status: number;
    /** HTTP status text, eg. 'ok' or 'Internal Server Error' etc */
    statusText?: string;
    /** Response headers as a plain key/value object. */
    headers?: Record<string, string>;
    /** Response body. Objects are serialised to JSON by the framework adapter. */
    body?: unknown;
  }

  /**
   * Defines what a listener does when it matches a request.
   *
   * - `'block'` — abort the request; the AUT receives no response.
   * - `'passthrough'` — forward to the real endpoint (or delegate to the caller
   *   in {@link Mock.delegateMode}) and return the actual response.
   * - {@link Response} — return the supplied mock response without hitting the network.
   */
  export type ListenerAction = 'block' | 'passthrough' | Response;

  /**
   * The result returned by {@link Mock.processInterceptedRequest} to the framework adapter.
   *
   * - `action: 'fulfill'` — return `response` to the AUT.
   * - `action: 'block'` — abort the request; the AUT receives nothing.
   * - `action: 'passthrough'` — only in {@link Mock.delegateMode}. Fetch the
   *   real response using `request` details and report it back via
   *   {@link Mock.completePassthrough} using the supplied `correlationId`.
   */
  export type InterceptResult =
    | { action: 'fulfill'; response: Response }
    | { action: 'block' }
    | { action: 'passthrough'; correlationId: string };

  /**
   * Describes the outcome of a single completed intercepted request.
   *
   * - `'mocked'` — a mock {@link Response} was returned.
   * - `'passthrough'` — the request was forwarded and the real response returned.
   * - `'blocked'` — the request was explicitly blocked by a listener.
   * - `'unmatched'` — no listener matched; the request was blocked by default.
   */
  export type TransactionType = 'mocked' | 'passthrough' | 'blocked' | 'unmatched';

  /**
   * A record of a single completed intercepted request and its outcome.
   *
   * Delegated passthroughs awaiting completion appear in
   * {@link Mock.getPendingTransactions} as {@link PendingTransaction} until
   * {@link Mock.completePassthrough} is called.
   */
  export interface Transaction {
    /** Auto-incremented identifier, e.g. `'txn-1'`. Resets on {@link Mock.reset}. */
    id: string;
    /** Wall-clock time at which the request was intercepted. */
    timestamp: Date;
    /** Name of the listener that matched, if any. Absent for `'unmatched'` transactions. */
    listenerName?: string;
    /** How the request was handled. */
    type: TransactionType;
    /** The intercepted request. */
    request: Request;
    /** The response returned to the AUT. Absent for `'blocked'` and `'unmatched'` transactions. */
    response?: Response;
  }

  /**
   * A delegated passthrough that has been issued by {@link Mock.processInterceptedRequest} but
   * not yet completed via {@link Mock.completePassthrough}.
   *
   * Only created when {@link Mock.delegateMode} is `true`.
   */
  export interface PendingTransaction {
    /** The UUID issued by {@link Mock.processInterceptedRequest} to identify this passthrough. */
    correlationId: string;
    /** Wall-clock time at which the passthrough was issued. */
    timestamp: Date;
    /** Name of the listener that triggered the passthrough. */
    listenerName: string;
    /** The original intercepted request. */
    request: Request;
  }

  /** @internal */
  export interface Listener {
    name: string;
    matchers: string[];
    action: ListenerAction;
    delayMs: number;
  }
}
