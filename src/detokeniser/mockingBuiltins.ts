import { JsonUtils, Log, StringUtils } from "../index.js";
import type { Detokeniser } from "./detokeniser.js";

// ─── MockUtils stub ───────────────────────────────────────────────────────────
// TODO: Replace with real import when MockUtils is brought into the package
const MockUtils = {
  interceptedRequests: undefined as object[] | undefined,
};

/**
 * The `mockintercepts` built-in verb — harvests a value from intercepted mock requests. Not
 * part of this package's public API — only imported by `detokeniser.ts` to register it as a
 * built-in handler.
 *
 * ```
 * [[mockintercepts|$.requests[0].body.userId]]
 * ```
 */

export function builtinMockRequests(context: Detokeniser.CallbackContext): string {
  // 'mockintercepts' needs a JSONPath expression to harvest from intercepted requests.
  if (StringUtils.isBlank(context.args)) throw new Error(`Request token [${context.rawVerb}] needs 2 parts {{mockintercepts;JSONPath}}`);
  return doMockRequests(context.args);
}

function doMockRequests(jsonPath: string): string {
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
