import { JsonUtils, Log, LogLevels, StringUtils, Utils } from "../index.js";

/**
 * A single named comparison behaviour, combinable with others as a `Set`. Ported from
 * TeamControlium's legacy `EATest.CompareTypes` vocabulary (`~/repos/ea-e2e-utils`), kept
 * deliberately identical so anyone with prior exposure to it already knows what each flag
 * does — with two deliberate fixes along the way (not a bit-for-bit port): `trim` actually
 * trims now (legacy declared it but never implemented it), and `silent`'s logging gate is
 * consistent across every comparison this module does (legacy had one inconsistent branch).
 *
 * - `count` — compare the *number* of candidates found, not their content.
 * - `any` — pass if *any one* candidate satisfies the comparison (short-circuits on first
 *   success); without this, only the first candidate is ever compared.
 * - `casesensitive` — opt-in: absence of this flag means case-*insensitive* comparison.
 * - `trim` — ignore leading/trailing whitespace on both sides before comparing.
 * - `startswith` / `endswith` / `contains` — combinable with each other (not with `equals`/
 *   `regexp`); verify the actual value starts with/ends with/contains the expected text.
 * - `equals` — exact match. The default whenever no other mode flag is present.
 * - `not` — invert the result of whichever mode above was used.
 * - `regexp` — treat the expected text as a regular expression, mutually exclusive with
 *   every other mode flag.
 * - `noassert` — return the boolean result instead of throwing on failure.
 * - `silent` — downgrades the summary log line to {@link LogLevels.TestDebug} instead of
 *   {@link LogLevels.TestInformation}, independently of `noassert` — a failing, `silent`,
 *   non-`noassert` comparison still throws; only the level its own detail message is logged
 *   at changes.
 */

/**
 * The `CompareType` flags every validation method in this module understands, regardless
 * of what it's comparing — control flags only, never a comparison-mode/behaviour flag:
 * `noassert`/`silent` don't change *what* "equal"/"matches"/etc. means for a given method,
 * only whether a failure throws and which level its own detail message logs at.
 */
export type CompareTypesCommon =
  | "noassert"
  | "silent"
  | "not";

/**
 * {@link CompareTypesCommon} plus the text-comparison mode/behaviour flags {@link
 * Validate.text} understands — `equals`/`contains`/`startswith`/`endswith`/`regexp` select
 * *how* `expected` is matched against `actual`; `casesensitive`/`trim`/`not` modify that
 * match.
 */
export type CompareTypesText =
  | CompareTypesCommon
  | "casesensitive"
  | "trim"
  | "startswith"
  | "endswith"
  | "contains"
  | "equals"
  | "regexp";

/**
 * {@link CompareTypesCommon} plus the number-comparison flags {@link Validate.number}
 * understands. Two independent families:
 * - A **comparator** — `<`/`lessthan`, `<=`/`lessthanorequalto`/`lessthanorequal`,
 *   `>`/`greaterthan`, `>=`/`greaterthanorequalto`/`greaterthanorequal`,
 *   `=`/`equalto`/`equal`, or `divisibleby` — symbol and worded spellings are equivalent
 *   (normalised the same whitespace-stripped, lowercased way every other flag is; the `to`
 *   in "...or equal to" is a genuinely separate registered spelling, not something
 *   whitespace-stripping removes, so both forms are listed). At most one comparator may be
 *   given; when one is, `expected` must be a single number token (see {@link
 *   parseNumberToken}), used as the threshold (`divisibleby`'s "threshold" is its divisor,
 *   which must itself be a non-zero integer).
 * - `integer` — only meaningful alongside a comparator; additionally requires `actual` be a
 *   whole number (`divisibleby` already implies this on its own).
 * - `excludelower`/`excludeupper` — only meaningful *without* a comparator (i.e. in the
 *   default list/range mode); make every range in `expected` exclusive at that end, instead
 *   of the default inclusive.
 */
export type CompareTypesNumber =
  | CompareTypesCommon
  | "<" | "lessthan"
  | "<=" | "lessthanorequalto" | "lessthanorequal"
  | ">" | "greaterthan"
  | ">=" | "greaterthanorequalto" | "greaterthanorequal"
  | "=" | "equalto" | "equal"
  | "divisibleby"
  | "integer"
  | "excludelower"
  | "excludeupper";

/**
 * {@link CompareTypesCommon} plus nothing else — {@link Validate.boolean} has no mode flag
 * to select between (there is only ever one way to compare two booleans: equality, which
 * `not` can invert). Named separately from {@link CompareTypesCommon} itself, rather than
 * reusing it directly as `Validate.boolean`'s own parameter type, so {@link
 * normalizeCompareTypes}'s per-context vocabulary check still rejects a text/number/json
 * flag (e.g. `casesensitive`) passed to a boolean comparison.
 */
export type CompareTypesBoolean = CompareTypesCommon;

/**
 * {@link CompareTypesCommon} plus nothing else — {@link Validate.type} has no mode flag to
 * select between (it either is, or isn't, the given {@link TypeName}; `not` can invert
 * that). Named separately from {@link CompareTypesCommon} itself for the same reason {@link
 * CompareTypesBoolean} is — so an unrelated flag is still rejected for this context.
 */
export type CompareTypesType = CompareTypesCommon;

/**
 * {@link CompareTypesCommon} plus two independent flags {@link Validate.jsonObject}
 * understands:
 * - `contains` — `expected` only needs to be *contained in* `actual`, not equal to it: every
 *   property `expected` has, `actual` must have too (recursively — `actual` may carry extra
 *   properties at any depth), and every element `expected`'s array has, `actual`'s
 *   corresponding array must have *somewhere* (`actual` may carry extra elements there too).
 *   Without it, `expected` and `actual` must have exactly the same properties/elements —
 *   nothing missing, nothing extra.
 * - `unorderedarrays` — named to say exactly what it affects (not "unordered", which could
 *   read as "don't care about property order" too — object key order is *never* compared,
 *   with or without this flag, since JSON object keys carry no ordering meaning at all;
 *   only array element order does). Array elements may appear in any arrangement instead of
 *   the default exact position; still the same multiset (nothing missing, nothing extra —
 *   `contains` is what relaxes "nothing extra").
 *
 * Both apply uniformly to the whole structure, at every depth — there's no per-array/
 * per-property opt-in, since that would need an extra parameter, breaking this method's
 * otherwise-identical shape to {@link Validate.text}/{@link Validate.number}.
 */
export type CompareTypesJson =
  | CompareTypesCommon
  | "contains"
  | "unorderedarrays";

/**
 * {@link CompareTypesCommon} plus the three flags {@link Validate.array} understands:
 * - `unordered` — position no longer matters; `actual` must carry the same *multiset* of
 *   elements as `expected` (duplicates included — see {@link Validate.array}'s own doc
 *   comment). Without it, element `i` of `expected` must match element `i` of `actual`.
 * - `casesensitive` — opt-in, only affects string-vs-string element pairs; absence means
 *   case-*insensitive*, same default as {@link Validate.text}.
 * - `equivalent` — a primitive element pair (string/number/boolean/bigint/`null`/
 *   `undefined`) only needs to match once both sides are stringified; without it,
 *   `typeof` must match too. Never affects an object/array element pair, which always
 *   falls back to exact structural equality regardless of this flag.
 */
export type CompareTypesArray =
  | CompareTypesCommon
  | "unordered"
  | "casesensitive"
  | "equivalent";

/**
 * The full union every other `CompareTypes*` vocabulary contributes, plus three new
 * orchestration-only flags that select *which* match(es) {@link Validate.jsonProperty}
 * uses — never forwarded to whichever {@link Validate.text}/{@link Validate.number}/{@link
 * Validate.boolean}/{@link Validate.jsonObject} call ends up actually comparing a value,
 * since none of those methods understand them:
 * - `exists` — ignore `expected`/content entirely; pass if the path matched one or more
 *   properties (`not` inverts to "matched none").
 * - `count` — ignore match *content* entirely; compare the match *count* against `expected`
 *   via {@link Validate.number} (so `expected` must be a valid number spec in this mode —
 *   a plain count, a range, or a comparator). Strictly more precise than `exists` (can
 *   express "exactly N" or "zero", which `exists` can't) — if both are given, `count`
 *   governs. Mutually exclusive with `any` (contradictory strategies for multiple matches).
 * - `any` — try every match's value against `expected`, passing if any one does (each probed
 *   with its own comparison forced `noassert`/`silent` so one failing match doesn't abort
 *   the search, and doesn't double-log).
 *
 * Every other flag here (from the text/number/json vocabularies) is a comparison-*mode*
 * flag, meaningless to `jsonProperty` itself — it's simply forwarded, unmodified, to
 * whichever delegate ends up handling the matched value, based on that value's own runtime
 * type. A flag that doesn't fit what was actually found (e.g. `unorderedarrays` forwarded to
 * a plain string match) is still rejected — by the delegate's own narrower vocabulary check,
 * not by `jsonProperty` itself.
 */
export type CompareTypesJsonProperty =
  | CompareTypesText
  | CompareTypesNumber
  | CompareTypesJson
  | "exists"
  | "count"
  | "any";

/** One parsed item from {@link Validate.number}'s default (no comparator) list/range grammar — either a single exact value, or a range with its own real-vs-integer granularity. Lives outside the class only because TypeScript doesn't allow a `type` alias inside a class body. */
type NumberListItem =
  | { kind: "value"; value: number }
  | { kind: "range"; min: number; max: number; integerOnly: boolean };

/**
 * The type names {@link Validate.type} recognises for its `expected` parameter. Deliberately
 * its own vocabulary rather than a bare `typeof` result, since raw `typeof` can't
 * distinguish `null` from an ordinary object (`typeof null === "object"`), or an array from
 * a plain object (`typeof [] === "object"`) — both distinctions test code regularly cares
 * about. `"nullish"` is included as the genuinely useful collective check (`null` OR
 * `undefined`) alongside — not instead of — checking each individually, since callers
 * elsewhere in this ecosystem (e.g. the `_null`/`_undefined` sentinel convention in {@link
 * JsonUtils}) already treat `null` and `undefined` as meaningfully distinct, not
 * interchangeable.
 */
type TypeName =
  | "null"
  | "undefined"
  | "nullish"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "function"
  | "object"
  | "array";

/**
 * Comparison primitives for validation code — a named, combinable `CompareType` flag
 * set (see {@link CompareType}) applied to text, numbers, deep-structural values, and
 * multi-candidate lookups (a JSONPath/XPath/regex/header lookup can all legitimately return
 * more than one match). All methods are static — no instantiation required.
 */
export class Validate {

  /** The full {@link CompareTypesCommon} vocabulary — shared by every context-specific vocabulary below, so `noassert`/`silent`/`not` are spelled once, not re-typed into each one. */
  private static readonly ALL_COMPARE_TYPES_COMMON: ReadonlySet<CompareTypesCommon> = new Set([
    "noassert", "silent", "not",
  ]);

  /** The full {@link CompareTypesText} vocabulary — what {@link Validate.text} accepts, and nothing else (e.g. not `casesensitive`-only-makes-sense-for-text flags being silently tolerated by a number comparison). */
  private static readonly ALL_COMPARE_TYPES_TEXT: ReadonlySet<CompareTypesText> = new Set([
    ...Validate.ALL_COMPARE_TYPES_COMMON, "casesensitive", "trim", "startswith", "endswith", "contains", "equals", "regexp",
  ]);

  /** The full {@link CompareTypesNumber} vocabulary — what {@link Validate.number} accepts, and nothing else. */
  private static readonly ALL_COMPARE_TYPES_NUMBER: ReadonlySet<CompareTypesNumber> = new Set([
    ...Validate.ALL_COMPARE_TYPES_COMMON,
    "<", "lessthan",
    "<=", "lessthanorequalto", "lessthanorequal",
    ">", "greaterthan",
    ">=", "greaterthanorequalto", "greaterthanorequal",
    "=", "equalto", "equal",
    "divisibleby",
    "integer",
    "excludelower",
    "excludeupper",
  ]);

  /** The full {@link CompareTypesBoolean} vocabulary — what {@link Validate.boolean} accepts, and nothing else. */
  private static readonly ALL_COMPARE_TYPES_BOOLEAN: ReadonlySet<CompareTypesBoolean> = new Set([
    ...Validate.ALL_COMPARE_TYPES_COMMON,
  ]);

  /** The full {@link CompareTypesJson} vocabulary — what {@link Validate.jsonObject} accepts, and nothing else. */
  private static readonly ALL_COMPARE_TYPES_JSON: ReadonlySet<CompareTypesJson> = new Set([
    ...Validate.ALL_COMPARE_TYPES_COMMON, "contains", "unorderedarrays",
  ]);

  /** The full {@link CompareTypesArray} vocabulary — what {@link Validate.array} accepts, and nothing else. */
  private static readonly ALL_COMPARE_TYPES_ARRAY: ReadonlySet<CompareTypesArray> = new Set([
    ...Validate.ALL_COMPARE_TYPES_COMMON, "unordered", "casesensitive", "equivalent",
  ]);

  /** The full {@link CompareTypesType} vocabulary — what {@link Validate.type} accepts, and nothing else. */
  private static readonly ALL_COMPARE_TYPES_TYPE: ReadonlySet<CompareTypesType> = new Set([
    ...Validate.ALL_COMPARE_TYPES_COMMON,
  ]);

  /** The full {@link CompareTypesJsonProperty} vocabulary — what {@link Validate.jsonProperty} accepts: everything every other context accepts, plus `exists`/`count`/`any`. */
  private static readonly ALL_COMPARE_TYPES_JSONPROPERTY: ReadonlySet<CompareTypesJsonProperty> = new Set([
    ...Validate.ALL_COMPARE_TYPES_TEXT,
    ...Validate.ALL_COMPARE_TYPES_NUMBER,
    ...Validate.ALL_COMPARE_TYPES_JSON,
    "exists", "count", "any",
  ]);

  /** Orchestration-only {@link Validate.jsonProperty} flags — consumed entirely at that level, never forwarded to whichever delegate ends up comparing a matched value. */
  private static readonly JSONPROPERTY_ORCHESTRATION_FLAGS: ReadonlySet<string> = new Set([
    "exists", "count", "any", "noassert", "silent", "not",
  ]);

  /** The full {@link TypeName} vocabulary {@link Validate.type}'s own `expected` parameter accepts — checked explicitly since, unlike a `compareTypes` flag, a bad `expected` here isn't caught by {@link normalizeCompareTypes} at all. */
  private static readonly ALL_TYPE_NAMES: ReadonlySet<TypeName> = new Set([
    "null", "undefined", "nullish", "string", "number", "boolean", "bigint", "symbol", "function", "object", "array",
  ]);

  /** Canonical symbol each recognised comparator spelling resolves to — `compareTypes` is already whitespace-stripped/lowercased by {@link Validate.normalizeCompareTypes} by the time this is consulted, so e.g. `"LessThanOrEqualTo"` has already become the exact key `"lessthanorequalto"`. */
  private static readonly NUMBER_COMPARATOR_ALIASES: ReadonlyMap<string, "<" | "<=" | ">" | ">=" | "=" | "divisibleby"> = new Map([
    ["<", "<"], ["lessthan", "<"],
    ["<=", "<="], ["lessthanorequalto", "<="], ["lessthanorequal", "<="],
    [">", ">"], ["greaterthan", ">"],
    [">=", ">="], ["greaterthanorequalto", ">="], ["greaterthanorequal", ">="],
    ["=", "="], ["equalto", "="], ["equal", "="],
    ["divisibleby", "divisibleby"],
  ]);

  /** Matches the signed-infinity keyword — `infinity`/`+infinity`/`-infinity`, case-insensitive, same as everywhere else in {@link Validate.number}'s grammar — as an alternative to an ordinary numeric literal wherever a single number token is expected. */
  private static readonly INFINITY_TOKEN_PATTERN = /^([+-]?)infinity$/i;

  /**
   * Parses one token as a number — an ordinary JS numeric literal (via `Number()`, so
   * scientific notation, a leading `+`, and bare `.5`/`5.` forms are all accepted, same as
   * `Number()` itself accepts them) or the signed-infinity keyword — returning `undefined` if
   * it's neither. The one shared recogniser {@link Validate.number} uses everywhere it needs
   * to decide "is this text a valid number" — a bare list item, a range bound, or the single
   * `expected` value in comparator mode — so `INFINITY`/`-INFINITY` behave identically in all
   * three, rather than being wired into just one of them.
   */
  private static parseNumberToken(token: string): number | undefined {
    const trimmed = token.trim();
    if (trimmed.length === 0) return undefined;
    const infinityMatch = trimmed.match(Validate.INFINITY_TOKEN_PATTERN);
    if (infinityMatch) {
      return infinityMatch[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
  }

  /**
   * Tries to split `item` into a `{ min, max }` bound pair around every occurrence of
   * `separator` (`-` for a real range, `..` for an integer range) — a position is kept only if
   * {@link Validate.parseNumberToken} accepts *both* resulting sides as a complete number on
   * their own, so a `-` that's actually a number's own sign (or an exponent's sign) never
   * survives as a false split: the side it'd leave behind is never a complete valid token.
   * Returns `undefined` if no position survives (not this kind of range at all); throws if
   * more than one does — genuinely ambiguous, not reachable by any case found while designing
   * this, but guarded rather than assumed impossible.
   */
  private static trySplitNumberRange(item: string, separator: "-" | ".."): { min: number; max: number } | undefined {
    const positions: number[] = [];
    if (separator === "-") {
      for (let i = 0; i < item.length; i++) {
        if (item[i] === "-") positions.push(i);
      }
    } else {
      for (let i = item.indexOf(".."); i !== -1; i = item.indexOf("..", i + 2)) {
        positions.push(i);
      }
    }

    const candidates: { min: number; max: number }[] = [];
    for (const position of positions) {
      const min = Validate.parseNumberToken(item.slice(0, position));
      const max = Validate.parseNumberToken(item.slice(position + separator.length));
      if (min !== undefined && max !== undefined) {
        candidates.push({ min, max });
      }
    }

    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      Log.logErrorAndThrow(`[${item}] is ambiguous — more than one way to read it as a range`);
    }
    return candidates[0];
  }

  /**
   * Validates a parsed range's bounds are sensible — thrown, not silently tolerated, since
   * none of these are "a legitimately always-failing test" the way e.g. `"2-2"` with both ends
   * excluded is: they're caller mistakes with nothing meaningful on the other side.
   *
   * @throws {Error} If the upper bound is `-Infinity` (an upper bound can never sensibly be
   *   the smallest possible value), the lower bound is `+Infinity` (same, mirrored), or
   *   `min > max` (a backwards range — nothing can ever satisfy it).
   */
  private static validateNumberRangeBounds(min: number, max: number, item: string): void {
    if (max === Number.NEGATIVE_INFINITY) {
      Log.logErrorAndThrow(`[${item}] is invalid — a range's upper bound can never be -Infinity`);
    }
    if (min === Number.POSITIVE_INFINITY) {
      Log.logErrorAndThrow(`[${item}] is invalid — a range's lower bound can never be +Infinity`);
    }
    if (min > max) {
      Log.logErrorAndThrow(`[${item}] is a backwards range — lower bound (${min}) is greater than upper bound (${max})`);
    }
  }

  /**
   * Classifies one comma-separated item from {@link Validate.number}'s default grammar: an
   * integer range (`min..max`), a real range (`min-max`), or a plain value — tried in that
   * order (order doesn't actually change the result, since each kind's own separator can
   * never be mistaken for another's — `..` literally can't appear inside an ordinary number).
   *
   * @throws {Error} If `item` doesn't parse as any of the three — see {@link
   *   Validate.validateNumberRangeBounds} for additional range-specific rejections.
   */
  private static parseNumberListItem(rawItem: string): NumberListItem {
    const item = rawItem.trim();

    const integerRange = Validate.trySplitNumberRange(item, "..");
    if (integerRange !== undefined) {
      Validate.validateNumberRangeBounds(integerRange.min, integerRange.max, item);
      return { kind: "range", min: integerRange.min, max: integerRange.max, integerOnly: true };
    }

    const realRange = Validate.trySplitNumberRange(item, "-");
    if (realRange !== undefined) {
      Validate.validateNumberRangeBounds(realRange.min, realRange.max, item);
      return { kind: "range", min: realRange.min, max: realRange.max, integerOnly: false };
    }

    const value = Validate.parseNumberToken(item);
    if (value !== undefined) {
      return { kind: "value", value };
    }

    Log.logErrorAndThrow(`[${item}] is not a valid number, a range (min-max), or an integer range (min..max)`);
  }

  /**
   * Structural comparison — object keys always compared order-independently (JSON object
   * keys carry no ordering meaning at all, so this is never conditional); array elements
   * compared order-sensitively unless `unorderedArrays` says otherwise. Hand-rolled rather
   * than taking on lodash's `isEqual` as a dependency (this codebase stays deliberately
   * dependency-minimal, and deep-equality over plain JSON-shaped data is a small, fully
   * self-contained algorithm) — extended from a plain equality check into also supporting
   * `containsMode` (`expected` only needs to be contained in `actual`, not equal to it,
   * recursively) at every level of nesting, not just the top one. `NaN` is treated as equal
   * to itself (via `Object.is`, not `===`).
   */
  private static deepEqual(expected: unknown, actual: unknown, containsMode: boolean, unorderedArrays: boolean): boolean {
    if (Object.is(expected, actual)) return true;
    if (typeof expected !== typeof actual) return false;
    if (expected === null || actual === null) return false;

    if (Array.isArray(expected) || Array.isArray(actual)) {
      if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
      return Validate.arraysMatch(expected, actual, containsMode, unorderedArrays);
    }

    if (typeof expected === "object" && typeof actual === "object") {
      const expectedKeys = Object.keys(expected);
      const actualKeys = Object.keys(actual);
      // containsMode: actual may carry extra keys expected never mentions — only checked the
      // other way around (every expected key must exist in actual), below. Without it, the
      // two key sets must be exactly the same size (checked here) as well as the same
      // members (checked via hasOwnProperty below) — nothing missing, nothing extra.
      if (!containsMode && expectedKeys.length !== actualKeys.length) return false;
      return expectedKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(actual, key)
          && Validate.deepEqual((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], containsMode, unorderedArrays)
      );
    }

    // Primitives of the same type that weren't caught by Object.is above are genuinely
    // unequal (e.g. different strings/numbers/booleans).
    return false;
  }

  /**
   * Matches `expected`'s array against `actual`'s, per {@link deepEqual}'s own
   * `containsMode`/`unorderedArrays` flags:
   * - Neither flag: exact positional match, same length.
   * - `unorderedArrays` alone: same length, same multiset of elements, any arrangement —
   *   every expected element must be matched to a *distinct* actual element (so two equal
   *   expected entries can't both be satisfied by the one actual entry that happens to equal
   *   them), but position doesn't matter.
   * - `containsMode` (with or without `unorderedArrays` — once searching for each expected
   *   element rather than requiring it at a fixed index, position is already irrelevant, so
   *   `unorderedArrays` adds nothing further): every expected element must be matched to a
   *   distinct actual element *somewhere*; `actual` may have additional, unmatched elements.
   */
  private static arraysMatch(expected: unknown[], actual: unknown[], containsMode: boolean, unorderedArrays: boolean): boolean {
    if (!containsMode && expected.length !== actual.length) return false;

    if (!containsMode && !unorderedArrays) {
      return expected.every((item, index) => Validate.deepEqual(item, actual[index], containsMode, unorderedArrays));
    }

    // Multiset containment/equality — each expected element consumes one not-yet-matched
    // actual element, so duplicate expected entries each need their own distinct actual
    // match rather than all being satisfied by the same single actual entry.
    const remainingActual = [...actual];
    return expected.every((expectedItem) => {
      const index = remainingActual.findIndex((actualItem) => Validate.deepEqual(expectedItem, actualItem, containsMode, unorderedArrays));
      if (index === -1) return false;
      remainingActual.splice(index, 1);
      return true;
    });
  }


  /** `true` for every value {@link arrayElementsMatch} is willing to stringify under `equivalent` mode — `string`/`number`/`boolean`/`bigint`/`null`/`undefined`. An object/array is never "primitive-ish", regardless of `equivalent` — see {@link Validate.array}'s own doc comment for why. */
  private static isComparablePrimitive(value: unknown): boolean {
    return value === null || value === undefined
      || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint";
  }

  /** Stringifies one {@link isComparablePrimitive} value for `equivalent`-mode comparison — `null`/`undefined` become the same placeholders {@link Validate.text} already uses for a missing `actual`, so e.g. `null` and the literal text `'null'` are (deliberately) equivalent too. */
  private static primitiveToComparableText(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "<UNDEFINED>";
    return String(value);
  }

  /**
   * Matches one `expected`/`actual` element pair for {@link Validate.array} — three cases,
   * tried in order:
   * 1. `equivalentMode` and both sides are {@link isComparablePrimitive}: compare their
   *    stringified forms (case rule from `caseSensitive` applies here too), so `true`
   *    matches `'true'`, `1` matches `'1'`, etc., regardless of `typeof`.
   * 2. Both sides are plain strings (whether or not `equivalentMode` is set): compare
   *    text directly, respecting `caseSensitive` — same default (case-insensitive) as
   *    {@link Validate.text}.
   * 3. Anything else — including one primitive paired with one object/array, or two
   *    objects/arrays, with or without `equivalentMode` — falls back to {@link deepEqual}'s
   *    exact structural equality. `equivalentMode` only ever relaxes *type*, never
   *    *structure*; two differently-shaped structures have no sensible "equivalent" reading.
   */
  private static arrayElementsMatch(expected: unknown, actual: unknown, caseSensitive: boolean, equivalentMode: boolean): boolean {
    if (equivalentMode && Validate.isComparablePrimitive(expected) && Validate.isComparablePrimitive(actual)) {
      const expectedText = Validate.primitiveToComparableText(expected);
      const actualText = Validate.primitiveToComparableText(actual);
      return caseSensitive ? expectedText === actualText : expectedText.toLowerCase() === actualText.toLowerCase();
    }

    if (typeof expected === "string" && typeof actual === "string") {
      return caseSensitive ? expected === actual : expected.toLowerCase() === actual.toLowerCase();
    }

    return Validate.deepEqual(expected, actual, false, false);
  }

  /**
   * Matches `expected`'s whole array against `actual`'s for {@link Validate.array}, per
   * `unordered`:
   * - Unset (default): same length, element `i` of `expected` matches element `i` of
   *   `actual` via {@link arrayElementsMatch}, for every `i`.
   * - Set: same length, same *multiset* of elements, any arrangement — every expected
   *   element must be matched to a *distinct*, not-yet-matched actual element, so three
   *   expected `false`s need three distinct actual `false`s, not one actual `false`
   *   satisfying all three (same consume-as-you-match approach {@link arraysMatch} already
   *   uses for `jsonObject`'s own `unorderedarrays`).
   */
  private static arraySequencesMatch(expected: unknown[], actual: unknown[], unordered: boolean, caseSensitive: boolean, equivalentMode: boolean): boolean {
    if (expected.length !== actual.length) return false;

    if (!unordered) {
      return expected.every((item, index) => Validate.arrayElementsMatch(item, actual[index], caseSensitive, equivalentMode));
    }

    const remainingActual = [...actual];
    return expected.every((expectedItem) => {
      const index = remainingActual.findIndex((actualItem) => Validate.arrayElementsMatch(expectedItem, actualItem, caseSensitive, equivalentMode));
      if (index === -1) return false;
      remainingActual.splice(index, 1);
      return true;
    });
  }

  /**
   * Resolves raw `Compare Types` text — however the caller sourced it (a config value, a
   * literal string, a table cell, ...) — or an already-built `Set`, into a validated `Set`
   * — comma-separated, whitespace-insensitive, case-insensitive. `undefined`/empty resolves
   * to an empty `Set` (the "no flags given" case every comparison method below already
   * knows how to default from).
   *
   * Validated against `validTypes` — the caller's own context-specific vocabulary (e.g.
   * {@link Validate.ALL_COMPARE_TYPES_TEXT} from {@link text}, {@link Validate.ALL_COMPARE_TYPES_NUMBER} from
   * {@link number}) — not some single vocabulary shared by every validation method. A flag
   * that's real but meaningless for the calling context (e.g. `casesensitive` passed to a
   * number comparison) is exactly as invalid here as a flag that doesn't exist at all.
   *
   * @throws {Error} If any comma-separated item isn't in `validTypes`.
   */
  public static normalizeCompareTypes<T extends string>(raw: string | Iterable<T> | undefined, validTypes: ReadonlySet<T>): Set<T> {

    ////////////////////////////////////////////////////
    //
    // Resolves whatever shape of 'compareTypes' flags a caller handed in (undefined, a raw
    // comma-separated string, or an already-built Set/other iterable) into one validated,
    // freshly-allocated Set — every item checked against this call's own context-specific
    // vocabulary (validTypes), regardless of which of those three shapes it arrived as. An
    // already-built Set is NOT trusted just because it's already a Set — per this package's
    // "never trust the caller" rule, it may have been hand-built from unchecked strings
    // somewhere upstream, so every one of its items is validated exactly the same way a
    // string's comma-separated items are, below.

    // undefined (caller passed no flags at all) is simply "no flags".
    if (Utils.isUndefined(raw)) return new Set();

    // A string needs splitting into its comma-separated items first; anything else (a Set,
    // an array, any other iterable) is already item-shaped and can go straight into the
    // shared validation loop below.
    const candidateItems: string[] = typeof raw === "string"
      ? (() => {
        const trimmed = raw.trim();
        // Blank/whitespace-only string — also simply "no flags".
        return trimmed.length === 0 ? [] : StringUtils.removeWhitespace(trimmed).toLowerCase().split(",");
      })()
      : [...raw];

    // Validate every candidate item against the calling context's own valid vocabulary,
    // failing loudly and immediately on the first unrecognised (or merely out-of-context)
    // one, rather than silently ignoring it or letting it through unchecked.
    const result = new Set<T>();
    for (const item of candidateItems) {
      if (!validTypes.has(item as T)) {
        Log.logErrorAndThrow(
          `[${item}] is not a recognised compare type for this validation — expected one of: ${[...validTypes].join(", ")}`
        );
      }
      result.add(item as T);
    }
    return result;
  }

  /**
   * Compares `actual` against `expected` text using the given {@link CompareTypesText}
   * flags — `equals` (default), `contains`/`startswith`/`endswith` (combinable with each
   * other), or `regexp`, each optionally inverted (`not`), case-sensitive or not
   * (`casesensitive`, opt-in — absence means case-*insensitive*), and whitespace-trimmed or
   * not (`trim`).
   *
   * @param expected - The expected text (or, with `regexp` set, the regular expression
   *   source text).
   * @param actual - The actual text. `undefined` is treated as the literal text
   *   `'<UNDEFINED>'` so a missing value still produces a readable failure message rather
   *   than a confusing crash.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link CompareTypesText}.
   *   Accepts a raw comma-separated string (see {@link normalizeCompareTypes}) or an
   *   already-built `Set`.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} If `regexp` is combined with any other mode flag, or `equals` is
   *   combined with `startswith`/`endswith`/`contains` (each group is mutually exclusive);
   *   or, without `noassert`, if the comparison fails.
   */
  public static text(
    expected: string,
    actual: string | undefined,
    description: string,
    compareTypes?: Set<CompareTypesText> | string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // Normalises the compare-type flags, enforces the mutual-exclusivity rules, defaults to
    // 'equals' when no mode flag is present at all, then dispatches to whichever of the
    // three comparison shapes (regexp / equals / startswith-endswith-contains) the flags
    // selected — each building its own regex under the hood, since 'contains'/'startswith'/
    // 'endswith' are themselves implemented as anchored/unanchored regex matches, not
    // String.prototype calls, so they can share the same case-sensitivity/trim/not handling
    // as the other two shapes.

    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_TEXT);

    const hasRegexp = options.has("regexp");
    const hasEquals = options.has("equals");
    const hasStartsWith = options.has("startswith");
    const hasEndsWith = options.has("endswith");
    const hasContains = options.has("contains");

    if (hasRegexp && (hasEquals || hasStartsWith || hasEndsWith || hasContains)) {
      Log.logErrorAndThrow("'regexp' cannot be combined with any other compare mode — it is mutually exclusive");
    }
    if (hasEquals && (hasStartsWith || hasEndsWith || hasContains)) {
      Log.logErrorAndThrow("'equals' cannot be combined with 'startswith'/'endswith'/'contains' — it is mutually exclusive");
    }

    // No mode flag at all (just e.g. 'not'/'casesensitive'/'noassert' alone, or nothing) —
    // 'equals' is the structural default.
    const hasAnyMode = hasRegexp || hasEquals || hasStartsWith || hasEndsWith || hasContains;
    const modes = hasAnyMode ? options : new Set<CompareTypesText>([...options, "equals"]);

    const caseSensitive = modes.has("casesensitive");
    const trimValues = modes.has("trim");
    const invert = modes.has("not");
    const noAssert = modes.has("noassert");
    const silent = modes.has("silent");

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...modes].join(", ")}] — caseSensitive=${caseSensitive}, trim=${trimValues}, not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );

    let actualText = actual ?? "<UNDEFINED>";
    let expectedText = expected;
    if (trimValues) {
      actualText = actualText.trim();
      expectedText = expectedText.trim();
    }

    let result: boolean;
    let expectedDescription: string;

    if (modes.has("regexp")) {
      const regex = new RegExp(expectedText, caseSensitive ? undefined : "i");
      Log.writeLine(LogLevels.FrameworkDebug, `using regular expression /${regex.source}/${regex.flags}`);
      result = regex.test(actualText);
      expectedDescription = `matches regular expression ${regex.source}`;
    } else if (modes.has("equals")) {
      Log.writeLine(LogLevels.FrameworkDebug, `using exact equality (${caseSensitive ? "case-sensitive" : "case-insensitive"})`);
      result = caseSensitive ? actualText === expectedText : actualText.toLowerCase() === expectedText.toLowerCase();
      expectedDescription = `[${StringUtils.truncateIfNeeded(expectedText, 512)}]`;
    } else {
      // startswith/endswith/contains — combinable with each other. Escape the expected text
      // for regex-special characters, then anchor it however the active flags call for;
      // 'contains' alone is the unanchored case.
      const escaped = expectedText.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const pattern = hasStartsWith && hasEndsWith
        ? `^${escaped}(.*)${escaped}$`
        : hasStartsWith
          ? `^${escaped}`
          : hasEndsWith
            ? `${escaped}$`
            : escaped;
      const regex = new RegExp(pattern, caseSensitive ? undefined : "i");
      Log.writeLine(
        LogLevels.FrameworkDebug,
        `using pattern /${regex.source}/${regex.flags} (startswith=${hasStartsWith}, endswith=${hasEndsWith}, contains=${hasContains})`
      );
      result = regex.test(actualText);
      const modeWords = [hasStartsWith && "starts with", hasEndsWith && "ends with", hasContains && "contains"].filter(Boolean);
      expectedDescription = `${modeWords.join(" and ")} [${StringUtils.truncateIfNeeded(expectedText, 512)}]`;
    }

    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    // Expected + Actual + Result, combined in one message, logged at TestInformation unless
    // 'silent' downgrades it to TestDebug — so a normal run always sees all three together,
    // never just a bare pass/fail.
    const detailMessage = `${description}:\nExpected ${expectedDescription} (${caseSensitive ? "Case" : "Not case"} sensitive)\n  Actual [${StringUtils.truncateIfNeeded(actualText, 512)}]\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage);

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

  /**
   * Compares `actual` against an `expected` number specification using the given {@link
   * CompareTypesNumber} flags.
   *
   * **Comparator mode** — one of `<`/`<=`/`>`/`>=`/`=`/`divisibleby` is present: `expected`
   * must be a single number token (an ordinary literal, or the signed-infinity keyword —
   * see {@link Validate.parseNumberToken}), used as the threshold (`divisibleby`'s threshold is its
   * divisor, which must itself be a non-zero integer). `integer` may additionally require
   * `actual` itself be a whole number (`divisibleby` always implies this on its own).
   * Exactly one comparator may be given; `excludelower`/`excludeupper` are invalid here.
   *
   * **Default mode** — no comparator: `expected` is a comma-separated list of plain numbers
   * and/or ranges (`min-max` real, `min..max` integer-only; either bound may be the
   * signed-infinity keyword), freely mixed — passes if `actual` equals any plain value or
   * falls inclusively within any range. `excludelower`/`excludeupper` make every range's
   * lower/upper bound exclusive instead, uniformly across the whole call (not per-range);
   * `integer` is invalid here (granularity is already per-range, via `-` vs `..`).
   *
   * `not` inverts the final result either way — a plain logical negation (e.g. `not` with a
   * range is that range's full complement, unbounded on both sides — not "make the bounds
   * exclusive"; that's what `excludelower`/`excludeupper` are for).
   *
   * @param expected - The expected number specification — see the two modes above.
   * @param actual - The actual value. Must be a real `number`, never `NaN` — both throw.
   *   `Infinity`/`-Infinity` are legitimate, testable values.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link CompareTypesNumber}.
   *   Accepts a raw comma-separated string (see {@link normalizeCompareTypes}) or an
   *   already-built `Set`.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} If `actual` isn't a real, non-`NaN` number; if `expected` isn't a
   *   `number`/`string`; if more than one comparator flag is given; if a comparator (or
   *   `integer`) is given alongside a list/range-shaped `expected`; if `divisibleby`'s
   *   divisor isn't a non-zero integer; if `integer` is given with no comparator; if
   *   `excludelower`/`excludeupper` are given alongside a comparator, or with no range
   *   present in `expected`; if any list item is malformed, a range is backwards, or a
   *   range's upper/lower bound is `-Infinity`/`+Infinity` respectively; or, without
   *   `noassert`, if the comparison fails.
   */
  public static number(
    expected: number | string,
    actual: number,
    description: string,
    compareTypes?: Set<CompareTypesNumber> | string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // actual's own shape is validated independently of compareTypes/expected: it must
    // genuinely be a number (never trust the caller, even though the type system already
    // promises this) and never NaN (every comparison involving NaN is always false
    // regardless of operator, so there is no sensible way to validate "for" it) — but it MAY
    // now be Infinity/-Infinity, a real, testable value, not rejected here.

    Utils.assertType(actual, "number", "Validate.number", "actual");
    if (Number.isNaN(actual)) {
      Log.logErrorAndThrow("[actual] is NaN — NaN can never be validated against (every comparison involving it is always false), so this is always a caller/upstream error, never a legitimate test outcome");
    }
    if (typeof expected !== "number" && typeof expected !== "string") {
      Log.logErrorAndThrow(`[expected] must be a number or string — received ${Utils.describeValue(expected)}`);
    }

    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_NUMBER);
    const noAssert = options.has("noassert");
    const silent = options.has("silent");
    const invert = options.has("not");
    const hasIntegerFlag = options.has("integer");
    const hasExcludeLower = options.has("excludelower");
    const hasExcludeUpper = options.has("excludeupper");

    const comparatorFlags = [...options].filter((item) => Validate.NUMBER_COMPARATOR_ALIASES.has(item));
    if (comparatorFlags.length > 1) {
      Log.logErrorAndThrow(`more than one comparator flag given [${comparatorFlags.join(", ")}] — only one is allowed at a time`);
    }
    const comparator = comparatorFlags.length === 1 ? Validate.NUMBER_COMPARATOR_ALIASES.get(comparatorFlags[0]) : undefined;

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...options].join(", ")}] — comparator=${comparator ?? "(none)"}, integer=${hasIntegerFlag}, excludeLower=${hasExcludeLower}, excludeUpper=${hasExcludeUpper}, not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );

    const expectedText = String(expected).trim();
    let result: boolean;
    let expectedDescription: string;

    if (comparator !== undefined) {
      if (hasExcludeLower || hasExcludeUpper) {
        Log.logErrorAndThrow(`'excludelower'/'excludeupper' cannot be combined with a comparator ('${comparator}') — they only apply to the default list/range mode`);
      }
      const threshold = Validate.parseNumberToken(expectedText);
      if (threshold === undefined) {
        Log.logErrorAndThrow(`a comparator flag ('${comparator}') requires [expected] to be a single number — [${expectedText}] is not`);
      }

      if (comparator === "divisibleby") {
        if (!Number.isInteger(threshold)) {
          Log.logErrorAndThrow(`'divisibleby's divisor must be an integer — [${expectedText}] is not`);
        }
        if (threshold === 0) {
          Log.logErrorAndThrow("'divisibleby' cannot use a divisor of 0 — division by zero is undefined");
        }
        Log.writeLine(LogLevels.FrameworkDebug, `using 'divisibleby' (divisor ${threshold})`);
        result = Number.isInteger(actual) && actual % threshold === 0;
        expectedDescription = `is divisible by [${threshold}]`;
      } else {
        const comparatorWords: Record<string, string> = {
          "<": "less than", "<=": "less than or equal to",
          ">": "greater than", ">=": "greater than or equal to",
          "=": "equal to",
        };
        Log.writeLine(LogLevels.FrameworkDebug, `using comparator '${comparator}' (threshold ${threshold})${hasIntegerFlag ? ", integer-only" : ""}`);
        switch (comparator) {
          case "<": result = actual < threshold; break;
          case "<=": result = actual <= threshold; break;
          case ">": result = actual > threshold; break;
          case ">=": result = actual >= threshold; break;
          case "=": result = actual === threshold; break;
          default:
            Log.logErrorAndThrow(`internal error — unrecognised comparator [${comparator}]. This should be unreachable.`);
        }
        if (hasIntegerFlag) {
          result = result && Number.isInteger(actual);
        }
        expectedDescription = `is ${comparatorWords[comparator]} [${threshold}]${hasIntegerFlag ? " (integer only)" : ""}`;
      }
    } else {
      if (hasIntegerFlag) {
        Log.logErrorAndThrow("'integer' requires a comparator flag ('<'/'<='/'>'/'>='/'='/'divisibleby') to modify — there is none here");
      }

      const items = expectedText.split(",").map((rawItem) => Validate.parseNumberListItem(rawItem));
      const rangeItemCount = items.filter((item) => item.kind === "range").length;
      if ((hasExcludeLower || hasExcludeUpper) && rangeItemCount === 0) {
        Log.logErrorAndThrow(`'excludelower'/'excludeupper' require [expected] to contain at least one range — [${expectedText}] has none`);
      }

      Log.writeLine(
        LogLevels.FrameworkDebug,
        `using default list/range matching (${items.length} item(s), ${rangeItemCount} range(s)${hasExcludeLower || hasExcludeUpper ? `, excludeLower=${hasExcludeLower}, excludeUpper=${hasExcludeUpper}` : ""})`
      );

      result = items.some((item) => {
        if (item.kind === "value") return actual === item.value;
        const lowerOk = hasExcludeLower ? actual > item.min : actual >= item.min;
        const upperOk = hasExcludeUpper ? actual < item.max : actual <= item.max;
        return lowerOk && upperOk && (!item.integerOnly || Number.isInteger(actual));
      });
      expectedDescription = `matches [${expectedText}]`;
    }

    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    const detailMessage = `${description}:\nExpected [${expectedDescription}]\n  Actual [${actual}]\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage);

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

  /**
   * Compares `actual` against an `expected` boolean. There is only ever one comparison mode
   * — equality (`not` inverts it) — so, unlike {@link text}/{@link number}, there are no
   * mode flags to select between; {@link CompareTypesBoolean} only ever supplies
   * `noassert`/`silent`/`not`.
   *
   * Exists, rather than leaving callers to stringify a boolean and go through {@link text},
   * so `actual` gets the same genuine-type enforcement {@link number} already gives its own
   * `actual` — a caller handing in the string `"true"` or the number `1` is a caller/
   * upstream error, not a legitimate boolean to validate against, and is rejected here
   * rather than silently treated as truthy text.
   *
   * @param expected - The expected value — a real `boolean`, or text resolved via {@link
   *   Utils.isTrue} (`"true"`/`"y"`/`"1"`/`"yes"`/`"positive"`, case-insensitive, all
   *   resolve to `true`; anything else resolves to `false` — so a Cucumber DataTable/
   *   feature-file cell, which can only ever hold a string, can express one without the
   *   caller parsing it first).
   * @param actual - The actual value. Must be a real `boolean` — never a string/number
   *   standing in for one; that always throws, regardless of `noassert`.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link
   *   CompareTypesBoolean}. Accepts a raw comma-separated string (see {@link
   *   normalizeCompareTypes}) or an already-built `Set`.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} If `actual` isn't a real `boolean`; or, without `noassert`, if the
   *   comparison fails.
   */
  public static boolean(
    expected: boolean | string,
    actual: boolean,
    description: string,
    compareTypes?: Set<CompareTypesBoolean> | string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // actual's own shape is validated independently of compareTypes/expected: it must
    // genuinely be a boolean (never trust the caller, even though the type system already
    // promises this). expected is parsed from "true"/"false" text if given as a string,
    // since a DataTable/feature-file cell can only ever hold a string.

    Utils.assertType(actual, "boolean", "Validate.boolean", "actual");

    // Resolve expected (a real boolean, or Cucumber-table-friendly text) and the
    // noassert/silent/not control flags — boolean has no comparison-mode flag of its own to
    // resolve, since equality is the only comparison a boolean can ever have.
    const expectedBoolean = Utils.isTrue(expected);
    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_BOOLEAN);
    const noAssert = options.has("noassert");
    const silent = options.has("silent");
    const invert = options.has("not");

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...options].join(", ")}] — not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );
    Log.writeLine(LogLevels.FrameworkDebug, "using exact equality — the only comparison mode a boolean has");

    // The one and only comparison this method ever makes.
    let result = actual === expectedBoolean;

    // 'not' flips the result after the comparison itself, never changing how the comparison
    // was made.
    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    const detailMessage = `${description}:\nExpected [${expectedBoolean}]\n  Actual [${actual}]\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage);

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

  /**
   * Compares `actual` against an `expected` array, element by element, using the given
   * {@link CompareTypesArray} flags — same shape as {@link text}/{@link number}/{@link
   * boolean}, just over a list instead of one scalar.
   *
   * - Default: `actual` must be the same length as `expected`, with element `i` of
   *   `expected` matching element `i` of `actual`, in both type and value (a string
   *   element compares case-insensitively unless `casesensitive` is set — same default as
   *   {@link text} — every other type compares via {@link deepEqual}'s exact structural
   *   equality).
   * - `unordered`: position no longer matters — `actual` must carry the same *multiset* of
   *   elements as `expected`. Duplicates are still counted: an `expected` of `[false, true,
   *   false]` only matches an `actual` of `[true, false, false]` (two `false`s, one `true`,
   *   on both sides) — one `actual` entry can never satisfy more than one `expected` entry.
   * - `casesensitive`: opt-in — absence means case-*insensitive*, only ever affecting a
   *   string-vs-string element pair (unaffected either way by every other element type).
   * - `equivalent`: a primitive element pair (string/number/boolean/bigint/`null`/
   *   `undefined`) only needs to match once both sides are stringified (respecting
   *   `casesensitive`) — so an `expected` of `[true, false]` matches an `actual` of
   *   `['TRUE', 'False']` case-insensitively. Without it, `typeof` must match too (`true`
   *   and `'true'` are not the same element). Never relaxes an object/array element pair —
   *   those always compare via {@link deepEqual}'s exact structural equality regardless.
   *
   * @param expected - The expected array.
   * @param actual - The actual array.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link CompareTypesArray}.
   *   Accepts a raw comma-separated string (see {@link normalizeCompareTypes}) or an
   *   already-built `Set`.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} If `expected` or `actual` isn't genuinely an array; or, without
   *   `noassert`, if the comparison fails.
   */
  public static array(
    expected: unknown[],
    actual: unknown[],
    description: string,
    compareTypes?: Set<CompareTypesArray> | string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // Both expected and actual must genuinely be arrays — never trusted just because
    // TypeScript's own parameter types already say so, same "never trust the caller" rule
    // every other method here already applies to its own actual (e.g. Validate.number's
    // NaN/typeof checks).

    if (!Array.isArray(expected)) {
      Log.logErrorAndThrow(`[expected] must be an array — received ${Utils.describeValue(expected)}`);
    }
    if (!Array.isArray(actual)) {
      Log.logErrorAndThrow(`[actual] must be an array — received ${Utils.describeValue(actual)}`);
    }

    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_ARRAY);
    const noAssert = options.has("noassert");
    const silent = options.has("silent");
    const invert = options.has("not");
    const unordered = options.has("unordered");
    const caseSensitive = options.has("casesensitive");
    const equivalentMode = options.has("equivalent");

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...options].join(", ")}] — unordered=${unordered}, caseSensitive=${caseSensitive}, equivalent=${equivalentMode}, not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );
    Log.writeLine(LogLevels.FrameworkDebug, `comparing ${expected.length} expected element(s) against ${actual.length} actual element(s)`);

    // The one and only comparison this method ever makes — delegated entirely to
    // arraySequencesMatch/arrayElementsMatch.
    let result = Validate.arraySequencesMatch(expected, actual, unordered, caseSensitive, equivalentMode);

    // 'not' flips the result after the comparison itself, never changing how the comparison
    // was made.
    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    const detailMessage = `${description}:\nExpected${unordered ? " (unordered)" : ""}:\n${Utils.safeStringify(expected, { maxLength: 4000 })}\nActual:\n${Utils.safeStringify(actual, { maxLength: 4000 })}\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage, { maxLines: 1024 });

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

  /**
   * Checks `actual`'s own runtime type against an `expected` {@link TypeName} — for
   * validating the *shape* of a value from any source (a header, a DOM attribute, a plain
   * variable, a JSON leaf), independently of its content. There is only ever one comparison
   * mode — "is it this type" (`not` inverts it) — so, like {@link boolean}, {@link
   * CompareTypesType} only ever supplies `noassert`/`silent`/`not`.
   *
   * Deliberately does not delegate to {@link text} (stringifying `actual`'s type name and
   * comparing text would drag in `casesensitive`/`trim`-flavoured logging that has no
   * meaning for a type check) — this is its own small, self-contained comparison.
   *
   * @param expected - The type `actual` is expected to be — see {@link TypeName} for the
   *   full vocabulary, including `"nullish"` (`null` OR `undefined`), `"object"` (non-null,
   *   non-array), and `"array"` (distinguished from `"object"` despite both being
   *   `typeof "object"`).
   * @param actual - The value to check. Can genuinely be anything — that's the point.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link CompareTypesType}.
   *   Accepts a raw comma-separated string (see {@link normalizeCompareTypes}) or an
   *   already-built `Set`.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} If `expected` isn't a recognised {@link TypeName}; or, without
   *   `noassert`, if the comparison fails.
   */
  public static type(
    expected: TypeName,
    actual: unknown,
    description: string,
    compareTypes?: Set<CompareTypesType> | string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // expected is checked against ALL_TYPE_NAMES explicitly — unlike a bad compareTypes
    // flag, a bad expected here is never caught by normalizeCompareTypes at all, since it's
    // an entirely separate parameter.

    if (!Validate.ALL_TYPE_NAMES.has(expected)) {
      Log.logErrorAndThrow(`[expected] must be one of ${[...Validate.ALL_TYPE_NAMES].join(", ")} — received ${Utils.describeValue(expected)}`);
    }

    // type has no comparison-mode flag of its own — only the common noassert/silent/not
    // control flags apply.
    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_TYPE);
    const noAssert = options.has("noassert");
    const silent = options.has("silent");
    const invert = options.has("not");

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...options].join(", ")}] — not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );
    Log.writeLine(LogLevels.FrameworkDebug, `checking actual is of type [${expected}]`);

    // The actual type check — four cases need their own explicit logic (typeof alone can't
    // tell null/array apart from a plain object, and 'nullish' is its own OR of two of
    // these), everything else (string/number/boolean/bigint/symbol/function) is exactly
    // what typeof already reports.
    let result: boolean;
    switch (expected) {
      case "null": result = actual === null; break;
      case "undefined": result = actual === undefined; break;
      case "nullish": result = actual === null || actual === undefined; break;
      case "array": result = Array.isArray(actual); break;
      case "object": result = typeof actual === "object" && actual !== null && !Array.isArray(actual); break;
      default: result = typeof actual === expected; break;
    }

    // 'not' flips the result after the comparison itself, never changing how the comparison
    // was made.
    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    const detailMessage = `${description}:\nExpected [type ${expected}]\n  Actual [${Utils.describeValue(actual)}]\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage);

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

  /**
   * Compares `actual` against `expected` using structural deep-equality — object keys
   * compared order-independently, array elements order-sensitively (same semantics as
   * lodash's `isEqual` for these shapes, via {@link deepEqual} — see its own doc comment for
   * why this is hand-rolled rather than taking on that dependency). There is no mode flag to
   * select between, unlike {@link text}/{@link number} — the comparison is always structural
   * equality; {@link CompareTypesJson} only ever supplies `noassert`/`silent`/`not`.
   *
   * @param expected - The expected value — a plain object, array, or primitive.
   * @param actual - The actual value — same shape as `expected`.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link CompareTypesJson}.
   *   Accepts a raw comma-separated string (see {@link normalizeCompareTypes}) or an
   *   already-built `Set`.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} Without `noassert`, if the comparison fails.
   */
  public static jsonObject(
    expected: unknown,
    actual: unknown,
    description: string,
    compareTypes?: Set<CompareTypesJson> | string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // jsonObject has one comparison mode only — structural deep-equality — so there's
    // nothing to dispatch between; containsMode/unorderedArrays only adjust how strict that
    // one comparison is, not which comparison runs.

    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_JSON);
    const noAssert = options.has("noassert");
    const silent = options.has("silent");
    const invert = options.has("not");
    const containsMode = options.has("contains");
    const unorderedArrays = options.has("unorderedarrays");

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...options].join(", ")}] — contains=${containsMode}, unorderedArrays=${unorderedArrays}, not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );
    Log.writeLine(
      LogLevels.FrameworkDebug,
      `using structural ${containsMode ? "containment (expected must be a subset of actual)" : "equality"} — object keys always order-independent, array elements ${containsMode || unorderedArrays ? "order-independent" : "order-sensitive"}`
    );

    // The one and only comparison this method ever makes — recursive structural comparison,
    // delegated entirely to deepEqual/arraysMatch.
    let result = Validate.deepEqual(expected, actual, containsMode, unorderedArrays);

    // 'not' flips the result after the comparison itself, never changing how the comparison
    // was made.
    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    // Expected/Actual are already length-bounded (safeStringify's own maxLength) — the whole
    // point of this method is comparing the whole structure, so Expected/Actual *is* the
    // full picture here, shown at the same level as the result, not split into separate
    // "specific value vs surrounding context" tiers the way jsonProperty's multi-match modes
    // need to be.
    const detailMessage = `${description}:\nExpected:\n${Utils.safeStringify(expected, { maxLength: 4000 })}\nActual:\n${Utils.safeStringify(actual, { maxLength: 4000 })}\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage, { maxLines: 1024 });

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

  /**
   * Dispatches a single matched JSON value to whichever comparison primitive actually fits
   * its own runtime type — the one piece every {@link Validate.jsonProperty} match-handling
   * path (`any`, or the plain default/index pick) shares. `expected === {@link
   * JsonUtils.SENTINEL_NULL}` is checked first, uniformly, regardless of `actual`'s type —
   * it means "assert this is a real null" wherever it's used, not "compare against the
   * literal text". `compareTypes` is forwarded as a raw string so each delegate re-validates
   * it against its own narrower vocabulary — a mode flag that doesn't fit what was actually
   * found here is still rejected, just by the delegate rather than by `jsonProperty` itself.
   */
  private static compareJsonPropertyValue(expected: unknown, actual: unknown, description: string, compareTypes: string): boolean {
    // Sentinel check always comes first, regardless of actual's own type — expected being
    // this sentinel means "actual must genuinely be null", not "compare actual against this
    // sentinel's own text".
    if (expected === JsonUtils.SENTINEL_NULL) {
      return Validate.type("null", actual, description, compareTypes);
    }
    // actual is a non-null object or array — structural comparison.
    if (typeof actual === "object" && actual !== null) {
      return Validate.jsonObject(expected, actual, description, compareTypes);
    }
    // actual is a real boolean.
    if (typeof actual === "boolean") {
      return Validate.boolean(expected as boolean | string, actual, description, compareTypes);
    }
    // actual is a real number.
    if (typeof actual === "number") {
      return Validate.number(expected as number | string, actual, description, compareTypes);
    }
    // Everything else (string, null, undefined) falls through to text comparison — null/
    // undefined become the same '<UNDEFINED>' placeholder Validate.text already gives any
    // other missing actual value.
    return Validate.text(String(expected), actual === null || actual === undefined ? undefined : String(actual), description, compareTypes);
  }

  /**
   * Validates a JSON object's property, addressed by JSONPath, against an `expected` value
   * — the JSONPath-addressed sibling of {@link text}/{@link number}/{@link boolean}/{@link
   * jsonObject}, ported from legacy `EATest.jsonProperty` (folding its separate
   * `JSONPropertyExistance` method in as the `exists` flag, rather than keeping it
   * standalone).
   *
   * `expected`'s meaning, and which flags apply, depends entirely on which mode is active —
   * see {@link CompareTypesJsonProperty} for the full flag vocabulary. In precedence order:
   *
   * 1. **Sentinel override** — `expected === {@link JsonUtils.SENTINEL_UNDEFINED}` (and
   *    `count` is *not* set): passes if the path matched *zero* properties, full stop.
   *    `count` combined with this sentinel is not specially handled — it falls through to
   *    mode 2, where `expected` fails {@link number}'s own parsing (it isn't a number spec),
   *    so it throws there, naturally.
   * 2. **`count`** — ignores match content; compares the match *count* against `expected`
   *    via {@link number} (so `expected` must be a valid number spec here — a comparator can
   *    express "more than zero", etc.). Mutually exclusive with `any`.
   * 3. **`exists`** (and not `count`) — ignores `expected`/content; passes if one or more
   *    properties matched.
   * 4. **`any`** — tries every match's value against `expected` (via {@link
   *    compareJsonPropertyValue}), passing if any one does. Zero matches is a plain fail.
   * 5. **Default** (none of the above) — zero matches is a plain fail (never a throw); one or
   *    more matches uses `index` (default `0`) to pick exactly one (throwing, unconditionally,
   *    if `index` is out of range — a caller mistake, not a test outcome), then dispatches
   *    that single value via {@link compareJsonPropertyValue} (which itself checks `expected
   *    === {@link JsonUtils.SENTINEL_NULL}` first).
   *
   * `not` inverts whatever boolean mode 1-5 produced — applied exactly once, here, never
   * forwarded into a delegate call.
   *
   * @param jsonObject - The object (or JSON string) to query — see {@link
   *   JsonUtils.getPropertiesMatchingPath}.
   * @param pathToJSONProperty - A valid JSONPath expression identifying the property/
   *   properties to validate.
   * @param expected - The expected value, or one of the two {@link JsonUtils} sentinels —
   *   meaning depends on the active mode; see above.
   * @param description - Used in every log line and the thrown error, so a failure is
   *   traceable back to the call that caused it.
   * @param compareTypes - Flags controlling the comparison — see {@link
   *   CompareTypesJsonProperty}. Accepts a raw comma-separated string (see {@link
   *   normalizeCompareTypes}) or an already-built `Set`.
   * @param index - Zero-based index selecting which match to use in default mode, when more
   *   than one property matched `pathToJSONProperty`. Ignored in every other mode.
   * @returns The comparison result — only actually returned to the caller (rather than
   *   thrown on failure) when `noassert` is set.
   * @throws {Error} If `any` and `count` are both set; if `count` is set and `expected`
   *   isn't a valid number spec; if `index` is out of range for the matches found; or,
   *   without `noassert`, if the comparison fails.
   */
  public static jsonProperty(
    jsonObject: unknown,
    pathToJSONProperty: string,
    expected: unknown,
    description: string,
    compareTypes?: Set<CompareTypesJsonProperty> | string,
    index = 0
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // Resolves the orchestration flags (count/exists/any — which pick the comparison
    // STRATEGY below) separately from every other flag (which pick a comparison MODE that
    // some other delegate method understands, not this one) — the latter get forwarded on,
    // unmodified, to whichever delegate ends up handling a matched value.

    const options = Validate.normalizeCompareTypes(compareTypes, Validate.ALL_COMPARE_TYPES_JSONPROPERTY);
    const noAssert = options.has("noassert");
    const silent = options.has("silent");
    const invert = options.has("not");
    const hasCount = options.has("count");
    const hasExists = options.has("exists");
    const hasAny = options.has("any");

    if (hasAny && hasCount) {
      Log.logErrorAndThrow("'any' and 'count' cannot be combined — 'count' ignores match content entirely, which 'any' exists specifically to probe");
    }

    // Build the flag string every delegate call below will be given: every mode flag this
    // method itself doesn't consume, plus noassert+silent forced on regardless of what the
    // caller actually asked for — so a delegate never throws or double-logs on our behalf;
    // this method alone decides whether the overall result throws, and at what level it
    // logs, once all matches have been tried.
    const forwardedFlags = [...options].filter((item) => !Validate.JSONPROPERTY_ORCHESTRATION_FLAGS.has(item));
    const forwardedCompareTypes = [...forwardedFlags, "noassert", "silent"].join(",");

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `resolved compare types [${[...options].join(", ")}] — count=${hasCount}, exists=${hasExists}, any=${hasAny}, not=${invert}, noAssert=${noAssert}, silent=${silent}`
    );

    // Find every property the path addresses before deciding which strategy applies —
    // every strategy below needs to know how many matches there were, even "exists"/"count"
    // which never look at any match's actual value.
    const matches = JsonUtils.getPropertiesMatchingPath(jsonObject as object | string, pathToJSONProperty);
    Log.writeLine(LogLevels.FrameworkDebug, `path [${pathToJSONProperty}] matched ${matches.length} node(s)`);

    let result: boolean;
    let mode: string;
    let expectedDescription: string;
    let actualDescription: string;

    if (expected === JsonUtils.SENTINEL_UNDEFINED && !hasCount) {
      // Strategy 1 — sentinel override: expected content doesn't matter at all here, only
      // whether the path matched anything.
      mode = "sentinel (_undefined)";
      result = matches.length === 0;
      expectedDescription = "no matching property (sentinel _undefined)";
      actualDescription = `${matches.length} match(es) found`;
    } else if (hasCount) {
      // Strategy 2 — count: match content is ignored entirely too; only the number of
      // matches is compared, via Validate.number so expected can itself be a comparator/
      // range, not just a plain count.
      mode = "count";
      result = Validate.number(String(expected), matches.length, `${description} (count of matches at [${pathToJSONProperty}])`, forwardedCompareTypes);
      expectedDescription = `match count satisfies [${String(expected)}]`;
      actualDescription = `${matches.length} match(es) found`;
    } else if (hasExists) {
      // Strategy 3 — exists: coarser than count (can't express "exactly N"), just "one or
      // more" vs "none".
      mode = "exists";
      result = matches.length >= 1;
      expectedDescription = "at least one matching property";
      actualDescription = `${matches.length} match(es) found`;
    } else if (hasAny) {
      // Strategy 4 — any: try every match's own value in turn, passing as soon as one
      // satisfies expected (short-circuits via Array.some); zero matches is a plain fail,
      // never a throw.
      mode = "any";
      if (matches.length === 0) {
        result = false;
        actualDescription = "no matching property found";
      } else {
        result = matches.some((match) => Validate.compareJsonPropertyValue(expected, match.value, `${description} (any match at [${pathToJSONProperty}])`, forwardedCompareTypes));
        actualDescription = `${matches.length} match(es) tried`;
      }
      expectedDescription = `any match satisfies [${Utils.describeValue(expected)}]`;
    } else {
      // Strategy 5 — default: pick exactly one match by index (0 unless the caller said
      // otherwise) and compare only that one value; zero matches is a plain fail, but an
      // out-of-range index against one-or-more matches is a caller mistake, so that throws
      // unconditionally, even under noassert.
      mode = `index ${index}`;
      if (matches.length === 0) {
        result = false;
        actualDescription = "no matching property found";
      } else {
        if (index < 0 || index >= matches.length) {
          Log.logErrorAndThrow(`[index] (${index}) is out of range — path [${pathToJSONProperty}] matched only ${matches.length} node(s)`);
        }
        const matchedValue = matches[index].value;
        result = Validate.compareJsonPropertyValue(expected, matchedValue, `${description} (match[${index}] at [${pathToJSONProperty}])`, forwardedCompareTypes);
        actualDescription = Utils.describeValue(matchedValue);
      }
      expectedDescription = expected === JsonUtils.SENTINEL_NULL ? "a real null (sentinel _null)" : `matched property satisfies [${Utils.describeValue(expected)}]`;
    }

    // 'not' inverts whichever strategy's result above was computed — applied exactly once,
    // here, never forwarded into a delegate call (forwardedCompareTypes never includes it).
    if (invert) {
      Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, "Compare types include 'not' — inverting result");
      result = !result;
    }

    const detailMessage = `${description}:\nPath [${pathToJSONProperty}] (mode=${mode})\nExpected [${expectedDescription}]\n  Actual [${actualDescription}]\nResult: ${result ? 'PASS' : 'FAIL'}`;
    Log.writeLine(silent ? LogLevels.TestDebug : LogLevels.TestInformation, detailMessage);

    // Only a failing, non-noAssert comparison actually throws — noAssert always returns the
    // boolean result below instead, win or lose.
    if (!noAssert && !result) {
      throw new Error(detailMessage);
    }
    return result;
  }

}
