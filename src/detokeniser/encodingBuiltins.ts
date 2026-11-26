import { Log, LogLevels, StringUtils, Utils } from "../index.js";
import type { Detokeniser } from "./detokeniser.js";

/**
 * Encoding-related built-in verbs: `base64`, `jwt`. Not part of this package's public API —
 * only imported by `detokeniser.ts` to register these as built-in handlers.
 *
 * ### `base64` — encode or decode
 * ```
 * <%base64|encode|Hello World%>        →  SGVsbG8gV29ybGQ=
 * <%base64|decode|SGVsbG8gV29ybGQ=%>   →  Hello World
 * ```
 * The actual encode/decode logic lives in {@link Utils.base64} — generic, not
 * Detokeniser-specific, and also directly callable by test code without going through a
 * token at all.
 *
 * ### `jwt` — generate a signed JWT
 * ```
 * <%jwt|{"sub":"1234","name":"Test"}|MySecret%>
 * <%jwt|{"sub":"1234"}|MySecret|{"algorithm":"HS256"}%>
 * ```
 */

export function builtinBase64(context: Detokeniser.VerbContext): string {
  // 'base64' needs three parts: the verb (already matched), then a direction
  // ('encode'/'decode'), then the value to convert. Split off the direction from the
  // value — quote-aware, so a value containing a literal '|' can be quoted to protect it
  // — and only proceed if the direction is actually one of those two literals. The split
  // happens on marker-safe text (args may still contain an unresolved nested-token marker);
  // only once `value` is isolated as its own piece is it safe to resolve markers in it.
  if (!StringUtils.isBlank(context.args)) {
    const [direction, value] = StringUtils.splitRemainingQuoted(context.args, context.delimiter, 2);
    if (direction == "encode" || direction == "decode") {
      return Utils.base64(context.resolveMarkers(value), direction);
    }
  }
  // Either no args at all, or a direction other than encode/decode — malformed.
  throw new Error(
    `BASE64 token [${context.rawVerb}] needs 3 parts (IE. ${context.tokenStart}base64${context.delimiter}encode|decode${context.delimiter}value${context.tokenEnd})`
  );
}

export function builtinJWT(context: Detokeniser.VerbContext): string {
  // 'jwt' needs at least a payload (signature/options are optional, see doJWTToken).
  if (StringUtils.isBlank(context.args))
    throw new Error(
      `JWT token [${context.rawVerb}] needs at least 2 parts (IE. ${context.tokenStart}jwt${context.delimiter}payload[${context.delimiter}signature[${context.delimiter}options]]${context.tokenEnd} etc.)`
    );
  return doJWTToken(context.args, context.delimiter, context.resolveMarkers);
}

function doJWTToken(tokenBody: string, delimiter: string, resolveMarkers: (text: string) => string): string {

  ////////////////////////////////////////////////////
  //
  // Resolves a `<%jwt|payload[|signature[|options]]%>` token: splits into up to 3 parts
  // (payload, signature, options) on the delimiter, and calls Utils.createJWT with
  // whichever of those were actually supplied — signature defaults to a dummy placeholder
  // if omitted entirely. Utils.createJWT itself already validates and reports signing
  // failures with full context (payload/options shown via safeStringify, signature content
  // never logged at all — see its own doc comment), so this handler doesn't need to
  // duplicate that; it only needs to check tokenBody's own type before splitting it.

  // tokenBody must actually be a string — fail fast and clearly if not, rather than letting
  // StringUtils.splitRemainingQuoted fail on it with a less specific error.
  Utils.assertType(tokenBody, "string", "doJWTToken", "tokenBody");
  Log.writeLine(LogLevels.TestDebug, `JWT token [${tokenBody}]`);
  // Quote-aware: payload and signature can each be wrapped in '...'/"..." to carry a
  // literal delimiter character (e.g. a JSON payload value that happens to contain one) —
  // see StringUtils.splitRemainingQuoted's own doc comment for the quoting rules. The split
  // happens on marker-safe text first; each extracted piece is resolved to its real content
  // only afterward, right before Utils.createJWT uses it.
  const typeAndLengthOrFormat: string[] = StringUtils.splitRemainingQuoted(tokenBody, delimiter, 3).map(resolveMarkers);
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
