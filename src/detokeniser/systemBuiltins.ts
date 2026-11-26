import { JsonUtils, Log, LogLevels, StringUtils, Utils } from "../index.js";
import type { Detokeniser } from "./detokeniser.js";

/**
 * The `setting` built-in verb — reads a configured value. Not part of this package's public
 * API — only imported by `detokeniser.ts` to register it as a built-in handler.
 *
 * Parameters are given as JSON key/value pairs after the delimiter. Resolution order:
 * process env → npm config → context parameters → default value.
 * ```
 * <%setting|processEnvName: "MY_VAR"%>
 * <%setting|processEnvName: "MY_VAR", defaultValue: "fallback"%>
 * <%setting|npmPackageConfigName: "myconfig"%>
 * <%setting|profileParameterName: "myParam", defaultValue: "none"%>
 * ```
 */

export function builtinSetting(context: Detokeniser.VerbContext): string | undefined {
  // 'setting' needs its JSON-ish parameter block (processEnvName/etc). args is never split any
  // further by this verb — the whole block is parsed as one JSON object — so it's safe to
  // resolve markers in it immediately, before use, rather than after some further split.
  if (StringUtils.isBlank(context.args))
    throw new Error(
      `Setting token [${context.rawVerb}] needs at least 2 parts (IE. ${context.tokenStart}setting${context.delimiter}processEnvName: "TEST_LOG_TO_CONSOLE"${context.tokenEnd})`
    );
  return doSettingToken(context);
}

function doSettingToken(context: Detokeniser.VerbContext): string | undefined {
  const { rawVerb, delimiter, options, tokenStart, tokenEnd } = context;
  const tokenBody = context.resolveMarkers(context.args);

  ////////////////////////////////////////////////////
  //
  // Resolves a `<%setting|...%>` token: the token body is bare `name: value` pairs (not
  // wrapped in braces, e.g. `processEnvName: "MY_VAR"`), so it's wrapped into a JSON object
  // literal, validated, parsed, then handed to Utils.getSetting — which does the actual
  // process-env → npm-config → context-parameter → default resolution — and the resolved
  // value is stringified for substitution back into the token's surrounding text.

  // Wrap the bare 'name: value, ...' body into a proper JSON object literal.
  const bodyJSON = `{${tokenBody}}`;
  // Validate it actually parses as JSON before attempting to use it — gives a much clearer,
  // setting-specific error than whatever JsonUtils.parse itself would throw.
  if (!JsonUtils.isJson(bodyJSON, true)) {
    const errText = `Token 'Setting'.\nExpected: parameters in name: value format (IE. ${tokenStart}setting${delimiter}processEnvName: "MY_SETTING"${tokenEnd})\nToken was: ${tokenStart}${rawVerb}${delimiter}${tokenBody}${tokenEnd}\n\nValid Setting parameters include;\n  processEnvName - Name of process env variable\n  npmPackageConfigName - Name of NPM config var\n  profileParameterName - JSONPath into the current context's parameters object\n  defaultValue - default value if cannot be found`;
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
