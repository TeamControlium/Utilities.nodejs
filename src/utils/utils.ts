import { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio, exec, spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { decodeHTML } from "entities";
import { createRequire } from 'module';
const { sign: jwtSign, decode: jwtDecode } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
import treeKill from "tree-kill";
import picomatch from "picomatch";

// import { Detokeniser } from "./Detokeniser"; Claude, just masking this out for now...
import { JsonUtils } from "../index.js";
import { Log, LogLevel, LogLevels } from "../index.js";
import { StringUtils } from "../index.js";

// ─── Module-level constants ───────────────────────────────────────────────────

/** Milliseconds in one second. */
const MS_PER_SECOND = 1_000;

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/**
 * Prefix used when storing the original value of a modified environment variable.
 * Allows {@link Utils.resetProcessEnvs} to restore variables to their pre-test values.
 */
const ENV_VAR_ORIGINAL_PREAMBLE = "test_old_";

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * What action to perform if a file already exists when {@link Utils.writeTextToFile} is called.
 */
export enum ExistingFileWriteActions {
    /** Overwrite existing file */
    Overwrite,
    /** Create a new file using an incrementing index in the file name */
    AddIndex,
    /** Append data to the existing file contents */
    Append,
    /** Throw an error indicating the file already exists */
    ThrowError,
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Maps `typeof` string literals to their corresponding TypeScript types.
 * Used by {@link Utils.assertType} to provide type narrowing after assertion.
 */
export interface AssertTypeMap {
    string: string;
    number: number;
    boolean: boolean;
    object: object;
    bigint: bigint;
    symbol: symbol;
    function: (...args: unknown[]) => unknown;
}

/**
 * Maps named shape/range constraints to their corresponding TypeScript types.
 * Used by {@link Utils.assertShape} to provide type narrowing after assertion.
 *
 * Deliberately a separate map from {@link AssertTypeMap} rather than folded into it —
 * `assertType`'s key selects a raw `typeof` result; these keys select a *constraint*
 * layered on top of a type (non-emptiness, range, non-null-ness). Mixing the two concerns
 * into one map would make `assertType`'s single parameter do two jobs at once.
 */
export interface AssertShapeMap {
    /** Non-null, non-array object — safe to spread or read named properties off. */
    nonNullObject: object;
    /** Non-empty string (`length > 0`). */
    nonEmptyString: string;
    /** Finite number greater than zero. */
    positiveNumber: number;
    /** Integer in the valid TCP port range (1–65535). */
    port: number;
}

/**
 * Result of {@link Utils.getSetting} — the resolved value alongside a human-readable
 * description of where it came from (e.g. `"Env var 'API_URL'"`, `"World 'eaTest.apiUrl'"`,
 * `"Default value"`, `"Not found"`).
 */
export interface SettingResult<T> {
    value: T | undefined;
    source: string;
}

/**
 * Context {@link Utils.getSetting} resolves a `profileParameterName` JSONPath against.
 * `parameters` is the actual object to query (e.g. a Cucumber World); `sourceName` is a
 * cosmetic label for what `parameters` *is*, shown in the returned `source` description
 * in place of the generic default `"Profile"` — it has no effect on resolution itself.
 */
export interface SettingsContext {
    sourceName?: string;
    /**
     * The actual object to query with `profileParameterName` — e.g. a Cucumber World
     * instance. Deliberately typed `object`, not `Record<string, unknown>` — a real class
     * instance (any class, not just a World) doesn't satisfy an index-signature type like
     * `Record<string, unknown>` even though every property on it is individually compatible
     * with `unknown`; TypeScript requires the source to have its own index signature, which
     * ordinary classes don't. `object` matches what {@link JsonUtils.getPropertiesMatchingPath}/
     * {@link JsonUtils.getMatchingJSONPropertyCount} already accept underneath this.
     */
    parameters: object;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

/**
 * General testing-related utilities. All methods are static — no instantiation required.
 */
export class Utils {

    // ── Private state ────────────────────────────────────────────────────────

    private static _promiseCount = 0;
    private static _defaultPromiseTimeout = 0;

    // ── Promise tracking ─────────────────────────────────────────────────────

    /**
     * Number of currently outstanding promises wrapped by {@link timeoutPromise}.
     * Check this at the end of a test to verify all promises have settled.
     * @see {@link resetPromiseCount}
     */
    static get promiseCount(): number {
        return Utils._promiseCount;
    }

    /**
     * Resets the outstanding promise count to zero.
     * @see {@link promiseCount}
     */
    static resetPromiseCount() {
        Utils._promiseCount = 0;
    }

    /**
     * Sets the default timeout in milliseconds applied by {@link timeoutPromise}
     * when no per-call `timeoutMS` is supplied.
     * @param timeoutMs - Timeout in milliseconds. Must be greater than zero.
     */
    static set defaultPromiseTimeout(timeoutMs: number) {
        Utils._defaultPromiseTimeout = timeoutMs;
    }

    // ── Type checking ─────────────────────────────────────────────────────────

    /**
     * Asserts that a value is of the expected type, throwing a logged error if not.
     * After a successful call, TypeScript narrows `value` to the corresponding type.
     *
     * @param value - Value to check.
     * @param expectedType - Expected `typeof` string (e.g. `"string"`, `"number"`).
     * @param funcName - Name of the calling function, used in the error message.
     * @param paramName - Name of the parameter being checked, used in the error message.
     * @throws {Error} If `typeof value` does not match `expectedType`.
     *
     * @example
     * Utils.assertType(name, "string", "greet", "name");
     * // name is now narrowed to string
     */
    public static assertType<K extends keyof AssertTypeMap>(value: unknown, expectedType: K, funcName: string, paramName: string): asserts value is AssertTypeMap[K] {
        if (typeof value !== expectedType) {
            const errorText = `Cannot ${funcName} as [${paramName}] not '${expectedType}' type. Is [${Utils.describeValue(value)}]`;
            // stackOffset: 1 — assertType is a generic helper called from dozens of sites;
            // its own location is never useful, only the caller whose check actually failed.
            Log.logErrorAndThrow(errorText, { stackOffset: 1 });
        }
    }

    /**
     * Asserts that a value matches a named shape/range constraint, throwing a logged error if
     * not. After a successful call, TypeScript narrows `value` to the corresponding type.
     * Sibling to {@link assertType} for checks that need more than a raw `typeof` match —
     * see {@link AssertShapeMap} for why this is a separate function rather than folded into
     * `assertType`'s map.
     *
     * @param value - Value to check.
     * @param expectedShape - Named constraint to check against (e.g. `"nonEmptyString"`, `"port"`).
     * @param funcName - Name of the calling function, used in the error message.
     * @param paramName - Name of the parameter being checked, used in the error message.
     * @throws {Error} If `value` does not satisfy `expectedShape`.
     *
     * @example
     * Utils.assertShape(port, "port", "connect", "port");
     * // port is now narrowed to number, and guaranteed 1-65535
     */
    public static assertShape<K extends keyof AssertShapeMap>(value: unknown, expectedShape: K, funcName: string, paramName: string): asserts value is AssertShapeMap[K] {
        if (!Utils.matchesShape(value, expectedShape)) {
            const errorText = `Cannot ${funcName} as [${paramName}] not a valid '${expectedShape}'. Is [${Utils.describeValue(value)}]`;
            // stackOffset: 1 — same generic-helper reasoning as assertType (see there).
            Log.logErrorAndThrow(errorText, { stackOffset: 1 });
        }
    }

    private static matchesShape(value: unknown, expectedShape: keyof AssertShapeMap): boolean {
        switch (expectedShape) {
            case 'nonNullObject':
                // Must be an object, not null (typeof null === 'object' in JS), and not an array —
                // callers of this shape want something they can spread/read named properties off.
                return value !== null && typeof value === 'object' && !Array.isArray(value);
            case 'nonEmptyString':
                // Must actually be a string, and have at least one character.
                return typeof value === 'string' && value.length > 0;
            case 'positiveNumber':
                // Must be a real number (not NaN/Infinity) and strictly greater than zero.
                return typeof value === 'number' && Number.isFinite(value) && value > 0;
            case 'port':
                // Must be a whole number within the valid TCP port range (1-65535 inclusive).
                return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
            default:
                // Compile-time exhaustiveness check: if AssertShapeMap gains a key without a
                // matching case above, this line fails to compile. Also the runtime fallback
                // for a JS caller passing an expectedShape value TypeScript didn't catch —
                // fail closed (treat as non-matching) rather than silently passing.
                expectedShape satisfies never;
                return false;
        }
    }

    /**
     * Safely describes an arbitrary value for inclusion in an error message. Never throws itself,
     * even for `null`, `undefined`, or hostile objects. Deliberately never includes the value's
     * own content — only its type/shape — for two reasons: content length is unbounded (a
     * `string` parameter could be megabytes), and content may be sensitive and must not be
     * leaked into logs. This applies uniformly across every type, not just objects.
     *
     * @param value - Value to describe.
     * @returns A human-readable description of the value's type/shape, e.g. `"string (length 5)"`,
     * `"object (Array)"`, or `"function (myHandler)"`. Never includes the value's own content.
     *
     * @example
     * Utils.describeValue(42); // "number"
     * Utils.describeValue(null); // "null"
     * Utils.describeValue({ a: 1 }); // "object (Object)"
     * Utils.describeValue("hello"); // "string (length 5)"
     */
    static describeValue(value: unknown): string {
        // null and undefined both report as 'object'/'undefined' from typeof in confusing ways
        // (typeof null === 'object'), so check for them explicitly first, before typeof is used.
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        const type = typeof value;
        if (type === 'function') {
            // Try to read the function's own name (e.g. a named function or arrow assigned to a
            // const) — wrapped in try/catch because this helper must never itself throw, even for
            // a hostile/proxy value whose .name getter throws.
            try {
                const name = (value as { name?: string }).name;
                return `function (${name || 'anonymous'})`;
            } catch {
                return 'function';
            }
        }
        if (type === 'object') {
            // Read the constructor name (e.g. "Array", "Date", or a custom class) to distinguish
            // plain objects from more specific object types — again guarded against a hostile
            // value whose .constructor access itself throws.
            try {
                const ctorName = (value as object).constructor?.name;
                return `object (${ctorName || 'Object'})`;
            } catch {
                return 'object';
            }
        }
        if (type === 'string') {
            // Report only the length, never the string's own content — see this function's
            // top-level doc comment for why content is deliberately never included.
            try {
                return `string (length ${(value as string).length})`;
            } catch {
                return 'string';
            }
        }
        // Every other primitive type (number, boolean, bigint, symbol) — the bare typeof result
        // is already a safe, bounded, content-free description.
        return type;
    }

    /**
     * Safely extracts a human-readable message from a caught value of unknown shape. Never
     * throws itself — in particular, a bare `(err as Error).message` cast throws a new,
     * unrelated `TypeError` when `err` is `null`/`undefined`/a non-Error throw, masking
     * whatever actually failed. Use this instead of that cast in every `catch` block.
     *
     * @param err - The caught value (from a `catch` clause, `Promise` rejection, etc.).
     * @returns `err.message` if `err` is an `Error`; `err` itself if it's a string;
     * otherwise a best-effort `JSON.stringify`/`String` rendering.
     *
     * @example
     * try { ... } catch (err) {
     *   Log.writeLine(LogLevels.Error, `Failed: ${Utils.errorMessage(err)}`);
     * }
     */
    static errorMessage(err: unknown): string {
        // The common case — a real Error (or subclass) thrown normally — just read .message.
        if (err instanceof Error) return err.message;
        // A bare string was thrown (e.g. `throw "oops"`) — it already IS the message.
        if (typeof err === 'string') return err;
        // Anything else (a thrown object, number, null, undefined, ...) — best-effort render it
        // via JSON.stringify so the shape is still visible. JSON.stringify(undefined) returns
        // `undefined` (not a string), hence the `?? String(err)` fallback. JSON.stringify can
        // also throw itself (circular reference, BigInt, ...), hence the catch -> String(err).
        try {
            return JSON.stringify(err) ?? String(err);
        } catch {
            return String(err);
        }
    }

    /**
     * Safely serializes a value to a bounded-length string for inclusion in a log/error
     * message. Never throws — a circular reference, a `BigInt`, or any other
     * `JSON.stringify` failure falls back to {@link describeValue} instead of crashing the
     * caller. Output longer than `maxLength` is truncated with a marker showing the true
     * length, so a large payload (an oversized response body, a header object with a huge
     * value, ...) can never dump unbounded content into a log — the same size-bounding
     * principle {@link describeValue} applies, extended to values that need to be shown
     * (not just described) but still can't be trusted to be small.
     *
     * @param value - Value to serialize.
     * @param options - Optional settings:
     *   - `maxLength` — Maximum length of the returned string before truncation (default: `1000`).
     *     Falls back to the default if not a positive finite number.
     * @returns A bounded-length JSON string, or a safe fallback description if serialization fails.
     *
     * @example
     * Utils.safeStringify({ a: 1 }); // '{"a":1}'
     * Utils.safeStringify(circularObj); // '<unable to stringify: ...> (object (Object))'
     * Utils.safeStringify(hugeArray, { maxLength: 200 }); // '[...]... (truncated, 48213 total chars)'
     */
    static safeStringify(value: unknown, options?: { maxLength?: number }): string {
        // Validate the caller-supplied maxLength — fall back to the default (1000) for anything
        // that isn't a genuinely usable positive finite number, rather than letting a bad option
        // (0, negative, NaN, a string) silently break the truncation logic below.
        const maxLength =
            typeof options?.maxLength === 'number' && Number.isFinite(options.maxLength) && options.maxLength > 0
                ? options.maxLength
                : 1000;
        let result: string;
        try {
            // JSON.stringify(undefined) returns `undefined` (not a string) — fall back to
            // String(value) so the result here is always a real string.
            result = JSON.stringify(value) ?? String(value);
        } catch (err) {
            // Stringification itself failed (circular reference, BigInt, ...) — never let that
            // propagate out of a "safe" helper; fall back to the type/shape description instead.
            return `<unable to stringify: ${Utils.errorMessage(err)}> (${Utils.describeValue(value)})`;
        }
        // Truncate anything over the configured bound, but keep the true original length visible
        // in the marker so a reader knows how much was cut, not just that truncation happened.
        return result.length > maxLength ? `${result.slice(0, maxLength)}... (truncated, ${result.length} total chars)` : result;
    }

    /**
     * Safely checks if a value is `null` or `undefined`.
     *
     * @param obj - Value to check.
     * @returns `true` if `null` or `undefined`, otherwise `false`.
     */
    static isNullOrUndefined(obj?: unknown): obj is null | undefined {
        try {
            return obj === null || obj === undefined;
        } catch {
            return true;
        }
    }

    /**2
     * Safely checks if a value is `null`.
     *
     * @param obj - Value to check.
     * @returns `true` if `null`, otherwise `false`.
     */
    static isNull(obj?: unknown): obj is null {
        return obj === null;
    }

    /**
     * Safely checks if a value is `undefined`.
     *
     * @param obj - Value to check.
     * @returns `true` if `undefined`, otherwise `false`.
     */
    static isUndefined(obj?: unknown): obj is undefined {
        return obj === undefined;
    }

    /**
     * Checks whether a value evaluates to `true` according to common conventions.
     *
     * Returns `true` for:
     * - A boolean `true`
     * - The strings `"y"`, `"1"`, `"yes"`, `"positive"`, or `"true"` (case-insensitive, trimmed)
     * - A number greater than zero
     *
     * @param valueToCheck - Value to evaluate.
     * @returns `true` if the value is considered truthy, otherwise `false`.
     */
    static isTrue(valueToCheck: boolean | string | number | undefined): boolean {
        switch (typeof valueToCheck) {
            case "boolean":
                // Already a boolean — nothing to interpret, return it as-is.
                return valueToCheck;
            case "string": {
                // Lowercase and trim first so callers don't need to worry about case or
                // surrounding whitespace (" Yes ", "TRUE", etc. all match).
                const normalizedValue = valueToCheck.toLowerCase().trim();
                return (
                    normalizedValue === "y" ||
                    normalizedValue === "1" ||
                    normalizedValue === "yes" ||
                    normalizedValue === "positive" ||
                    normalizedValue === "true"
                );
            }
            case "number":
                // Any positive number counts as truthy; zero and negative numbers do not.
                return valueToCheck > 0;
            default:
                // undefined (or anything else typeof could return) — treat as not true.
                return false;
        }
    }

    /**
     * Verifies whether a value is a valid `Date` object.
     *
     * @param dateToCheck - Value to validate.
     * @returns `true` if the value is a `Date` instance with a valid time, otherwise `false`.
     */
    static isValidDate(dateToCheck: unknown): dateToCheck is Date {
        try {
            return dateToCheck instanceof Date && !isNaN(dateToCheck.getTime());
        } catch {
            return false;
        }
    }

    // ── Math / string helpers ─────────────────────────────────────────────────

    /**
     * Pads a number or string with leading zeros to reach a required minimum length.
     *
     * @param num - The number or string to pad.
     * @param requiredMinimumLength - The minimum length of the returned string.
     * @returns The value as a string, left-padded with `"0"` to at least `requiredMinimumLength` characters.
     * @note If the value is already longer than `requiredMinimumLength`, no truncation occurs.
     *
     * @example
     * Utils.pad(7, 3);    // => "007"
     * Utils.pad("42", 5); // => "00042"
     */
    static pad(num: number | string, requiredMinimumLength: number): string {
        const numString = typeof num === "number" ? num.toString() : num;
        return numString.padStart(requiredMinimumLength, "0");
    }

    /**
     * Converts a millisecond duration to a `HH:MM:SS.t` formatted string,
     * where `t` is tenths of a second.
     *
     * @param milliSeconds - Duration in milliseconds.
     * @returns Time string formatted as `HH:MM:SS.t`.
     * @note Durations above 359,999,000 ms (99h 59m 59s) will give unexpected results.
     */
    static msToHMS(milliSeconds: number): string {
        // How many whole 24h days does the duration span? A plain `new Date(milliSeconds)`
        // would wrap back to 00:00:00 past 24h, losing that — so days are tracked separately.
        const wholeDays = Math.floor(milliSeconds / MS_PER_DAY);
        // Strip the whole-days portion off, leaving a remainder under 24h that a Date's own
        // UTC getters can read directly.
        const date = new Date(milliSeconds - wholeDays * MS_PER_DAY);
        // Re-add the stripped days back in as extra hours, so durations over 24h still show a
        // correct (if non-standard, e.g. "26:00:00") hour count rather than wrapping to "02:00:00".
        const hours = wholeDays * 24 + date.getUTCHours();
        // Hours is padded to at least 2 digits, but allowed to grow wider for very long
        // durations (e.g. "100" stays "100", not truncated back to 2 digits); minutes/seconds
        // are always exactly 2 digits; the fractional part is tenths of a second (ms / 100, rounded).
        return `${this.pad(hours, ("" + hours).length > 2 ? ("" + hours).length : 2)}:${this.pad(date.getUTCMinutes(), 2)}:${this.pad(date.getUTCSeconds(), 2)}.${Math.round(date.getUTCMilliseconds() / 100)}`;
    }

    /**
     * Returns a random integer between `min` and `max` inclusive.
     * If `max` is less than `min`, the values are swapped.
     *
     * @param min - Lower bound.
     * @param max - Upper bound.
     * @returns A random integer inclusively between `min` and `max`.
     */
    static getRandomInt(min: number, max: number): number {
        // Figure out which of the two arguments is actually the lower bound — if the caller
        // passed them reversed (max < min), swap them here rather than producing a nonsensical
        // (or infinite-loop-prone) range below. Also rounds each bound inward (ceil the lower
        // bound, floor the upper bound) so a fractional input can't widen the inclusive range.
        const minMax = min < max ? Math.ceil(min) : Math.ceil(max);
        const maxMin = min < max ? Math.floor(max) : Math.floor(min);
        // Standard inclusive-random-integer formula: scale Math.random()'s [0,1) output across
        // the (inclusive) range width + 1, floor it down to a whole number, then shift up by the
        // lower bound.
        return Math.floor(Math.random() * (maxMin - minMax + 1)) + minMax;
    }

    /**
     * Returns a random float between `min` and `max`.
     *
     * @param min - Lower bound.
     * @param max - Upper bound.
     * @returns A random float between `min` and `max`.
     */
    static getRandomFloat(min: number, max: number): number {
        return Math.random() * (max - min) + min;
    }

    // ── File operations ───────────────────────────────────────────────────────

    /**
     * Writes data to a file, with configurable behaviour when the file already exists.
     *
     * Data is serialised before writing:
     * - JSON strings are normalised (parsed then re-stringified).
     * - Non-JSON strings are written as-is.
     * - Objects are written as pretty-printed JSON.
     *
     * @param filePath - Directory path where the file should be created.
     * @param fileName - Name of the file to write.
     * @param data - Content to write — a string or an object.
     * @param ifExistsAction - Action to take if the file already exists (default: `AddIndex`).
     * @see {@link ExistingFileWriteActions}
     * @throws {Error} If the write fails, or if `ThrowError` is specified and the file exists.
     */
    static writeTextToFile(filePath: string, fileName: string, data: string | object, ifExistsAction = ExistingFileWriteActions.AddIndex): void {
        let fullFilename = path.join(filePath, fileName);
        try {
            // Make sure the destination directory actually exists first — `recursive: true`
            // also creates any missing parent directories along the way.
            if (!existsSync(filePath)) {
                Log.writeLine(LogLevels.TestDebug, `Folder [${filePath}] does not exist so creating`);
                mkdirSync(filePath, { recursive: true });
            }
            if (existsSync(fullFilename)) {
                // The target file already exists — what happens next depends entirely on
                // ifExistsAction.
                Log.writeLine(LogLevels.TestDebug, `File [${fullFilename}] exists so performing action [${ifExistsAction.toString()}]`);
                switch (ifExistsAction) {
                    case ExistingFileWriteActions.AddIndex: {
                        // Don't overwrite — instead find a free, incrementing index suffix and
                        // recurse with that new name until we land on one that doesn't exist yet.
                        const splitFileName = fileName.split(".");
                        fileName =
                            splitFileName.length === 1
                                // No extension at all (e.g. "hello") — just tack ".1" straight on.
                                ? fileName + ".1"
                                : ((splitFileName: string[]): string => {
                                    // If file name has 2 parts (e.g. hello.json) then add the index (e.g. hello.1.json)
                                    if (splitFileName.length === 2) {
                                        if (/^\d+$/.test(splitFileName[1])) {
                                            // The "extension" is actually already a numeric index (e.g.
                                            // "hello.1") — bump it rather than inserting a new one.
                                            return splitFileName[0] + "." + (parseInt(splitFileName[1]) + 1);
                                        } else {
                                            // A normal two-part name (base + real extension) — insert
                                            // ".1" between them.
                                            return splitFileName[0] + ".1." + splitFileName[1];
                                        }
                                    }
                                    // If file name has an index (e.g. hello.7.json or some.other.5.json) increment it
                                    if (/^\d+$/.test(splitFileName[splitFileName.length - 2])) {
                                        // Second-to-last segment is already a numeric index — increment
                                        // it in place, keeping the base name and real extension either side.
                                        return (
                                            splitFileName.slice(0, splitFileName.length - 2).join(".") +
                                            "." +
                                            (parseInt(splitFileName[splitFileName.length - 2]) + 1) +
                                            "." +
                                            splitFileName[splitFileName.length - 1]
                                        );
                                    }
                                    // 3+ part name without a numeric index (e.g. hello.addd.json) — add index (e.g. hello.addd.1.json)
                                    return splitFileName.slice(0, splitFileName.length - 1).join(".") + ".1." + splitFileName[splitFileName.length - 1];
                                })(splitFileName);
                        // Recurse with the newly-derived name — if THAT also already exists, this
                        // same AddIndex branch runs again and bumps the index further, until a
                        // genuinely free filename is found.
                        this.writeTextToFile(filePath, fileName, data, ifExistsAction);
                        break;
                    }
                    case ExistingFileWriteActions.Append: {
                        // Add a leading newline so the appended content starts on its own line,
                        // then tack the serialised data onto the end of the existing file.
                        appendFileSync(fullFilename, "\n" + Utils.serialiseFileData(data));
                        break;
                    }
                    case ExistingFileWriteActions.Overwrite: {
                        // Replace the file's entire contents with the newly serialised data.
                        writeFileSync(fullFilename, Utils.serialiseFileData(data));
                        break;
                    }
                    case ExistingFileWriteActions.ThrowError: {
                        // Caller explicitly wants a collision to be fatal — log and throw rather
                        // than silently overwriting or appending to something that already exists.
                        const errText = `File [${fullFilename}] exists and action is ThrowError!`;
                        Log.logErrorAndThrow(errText);
                        break;
                    }
                    default: {
                        // Defensive backstop — a value outside the ExistingFileWriteActions enum
                        // (e.g. passed from untyped JS) has no defined behaviour, so fail loudly
                        // rather than silently doing nothing.
                        const errText = `Cannot write to file [${fullFilename}] — unknown action [${ifExistsAction}]!`;
                        Log.logErrorAndThrow(errText);
                    }
                }
            } else {
                // The target file does NOT exist yet — no collision to resolve, but AddIndex
                // still needs special handling below because a BARE name with an existing
                // numeric "extension" (e.g. "hello.3") would otherwise get a redundant ".1"
                // inserted even though nothing actually collided.
                const splitFileName = fileName.split(".");
                if (splitFileName.length === 1) {
                    // No extension/dots at all — for AddIndex, start the numbering fresh at
                    // ".1" even on a first write, for naming consistency with files that DO
                    // eventually collide. Any other action just writes the file as given.
                    if (ifExistsAction === ExistingFileWriteActions.AddIndex) {
                        this.writeTextToFile(filePath, fileName + ".1", data, ifExistsAction);
                    } else {
                        writeFileSync(fullFilename, Utils.serialiseFileData(data));
                    }
                } else {
                    if (
                        !(splitFileName.length === 2 && /^\d+$/.test(splitFileName[splitFileName.length - 1])) &&
                        ifExistsAction === ExistingFileWriteActions.AddIndex &&
                        !/^\d+$/.test(splitFileName[splitFileName.length - 2])
                    ) {
                        // AddIndex requested, and the name isn't already numbered (neither a
                        // simple "base.N" pair nor a "base.N.ext" triple) — insert the initial
                        // ".1" index now, before the existence check below, so every AddIndex
                        // write (even the very first one) consistently carries an index.
                        fileName = splitFileName.slice(0, splitFileName.length - 1).join(".") + ".1." + splitFileName[splitFileName.length - 1];
                    }
                    fullFilename = path.join(filePath, fileName);
                    if (existsSync(fullFilename)) {
                        // Inserting the ".1" above happened to collide with an existing file
                        // after all (e.g. "hello.1.json" was already there) — recurse so the
                        // AddIndex branch above can bump the index further.
                        this.writeTextToFile(filePath, fileName, data, ifExistsAction);
                    } else {
                        // Genuinely free — write the file now.
                        writeFileSync(fullFilename, Utils.serialiseFileData(data));
                    }
                }
            }
        } catch (err) {
            // Catch-all for anything above (mkdir failure, write failure, a thrown
            // logErrorAndThrow, ...) — log it, then re-throw so the caller still sees the failure.
            Log.writeLine(LogLevels.Error, `Unable to write text to file: ${err}`);
            throw err;
        }
    }

    /**
     * Resolves a relative "test data" path against a single configured root, with no
     * mock-vs-test distinction — any test suite's own `.feature` file (or anything else)
     * that references a test data file by a relative path goes through here.
     *
     * The root resolves via {@link getSetting} — env var `CONTROLIUM_TEST_DATA_PATH`, then
     * npm package config `testDataPath`, then a default of `<cwd>/testdata`. That default
     * assumes the test command is invoked from the suite's own root — the same assumption
     * virtually every comparable Node tool makes (Jest's `rootDir`, Vitest's `root`, ESLint's
     * config resolution, etc. all default to `process.cwd()` for exactly this reason). It
     * isn't bulletproof for every possible monorepo/workspace invocation style, but that's
     * exactly why this is a configurable setting with an override, not a hardcoded path —
     * a suite in an atypical setup overrides it once via the env var or npm config.
     *
     * Purely a path-resolution function — never checks the result exists, or reads anything.
     * A nonexistent file/root surfaces naturally (and clearly) the moment something actually
     * tries to read from the resolved path, e.g. via {@link getFileContents}.
     *
     * Always relative to the configured root, never absolute — a bare filename
     * (`"hello.txt"`) resolves directly under it, and `..` segments intentionally escape
     * upward *relative to that root* (`"../otherFolder/hello.txt"`) for a test that genuinely
     * needs something outside the test-data folder. Nothing a caller passes can land at a
     * true filesystem-absolute path regardless: `path.join` glues even a leading `/` onto
     * the root rather than resetting to it (`resolveTestDataPath("/etc/passwd")` resolves to
     * `<root>/etc/passwd`, not the real `/etc/passwd`). This is test infrastructure the test
     * author themselves controls, not an untrusted-input boundary, so `..` is a deliberate
     * escape hatch, not something defended against.
     *
     * @param relativePath - Path to resolve, relative to the configured test data root.
     * @returns The resolved absolute (or root-relative, if the configured root itself is
     *   relative) path.
     * @throws {Error} If `relativePath` is not a non-empty string.
     *
     * @example
     * Utils.resolveTestDataPath("headers/authHeaders.json");
     * // => "/path/to/suite/testdata/headers/authHeaders.json"   (default root, no override)
     */
    static resolveTestDataPath(relativePath: string): string {
        Utils.assertShape(relativePath, "nonEmptyString", "Utils.resolveTestDataPath", "relativePath");
        const { value: root } = Utils.getSetting<string>(LogLevels.FrameworkInformation, "Test data path", {
            processEnvName: "CONTROLIUM_TEST_DATA_PATH",
            npmPackageConfigName: "testDataPath",
            defaultValue: path.join(process.cwd(), "testdata"),
        });
        return path.join(root as string, relativePath);
    }

    /**
     * Returns the entire contents of a file as a string.
     *
     * @param path - Path to the file.
     * @param options - Optional settings:
     *   - `encoding` — File encoding (default: `"utf-8"`).
     * @returns Contents of the file as a string. To detokenise it, pass the result
     *   through `Detokeniser.doAsync()` yourself — this stays a plain file read, no
     *   dependency on `Detokeniser` (which itself depends on this module).
     * @throws {Error} If the file cannot be read.
     */
    static getFileContents(filePath: string, options?: { encoding?: BufferEncoding }): string {
        const encoding = options?.encoding ?? "utf-8";
        try {
            // Read the raw bytes first (via getFileContentsBuffer, which has its own error
            // handling/logging), then decode them to a string using the requested encoding.
            Log.writeLine(LogLevels.TestDebug, `Load file [${filePath}] using encoding [${encoding}]`);
            const contents = this.getFileContentsBuffer(filePath).toString(encoding);
            Log.writeLine(LogLevels.FrameworkDebug, `Loaded [${contents.length}] characters`);
            return contents;
        } catch (err) {
            // Covers both a read failure bubbling up from getFileContentsBuffer and a failure
            // in .toString(encoding) itself (e.g. an invalid/unsupported encoding name).
            const errText = `Utils.getFileContents - Reading file using ${encoding} threw error: [${err}]`;
            Log.logErrorAndThrow(errText);
        }
    }

    /**
     * Returns the entire contents of a file as a `Buffer`.
     *
     * @param path - Path to the file.
     * @returns Raw file contents as a `Buffer`.
     * @throws {Error} If the file cannot be read.
     */
    static getFileContentsBuffer(filePath: string): Buffer {
        try {
            Log.writeLine(LogLevels.TestDebug, `Getting file contents from [${filePath}]`);
            return readFileSync(filePath);
        } catch (err) {
            const errText = `Utils.getFileContentsBuffer - readFileSync for path [${filePath}] threw error: [${err}]`;
            Log.logErrorAndThrow(errText);
        }
    }

    // ── Environment variables ─────────────────────────────────────────────────

    /**
     * Resolves a setting value from, in priority order:
     * 1. A process environment variable
     * 2. An npm package config variable
     * 3. A named property within `contextParameters.parameters`
     * 4. A supplied default value
     *
     * Returns both the value *and* a human-readable description of where it came from —
     * useful for a test's own diagnostic/failure output ("apiUrl came from Env var
     * 'API_URL'", say), not just the value in isolation.
     *
     * @param logLevel - Log level used when reporting where the setting was found.
     * @param settingName - Human-readable name for the setting, used in log messages.
     * @param sources - Named sources to check:
     *   - `processEnvName` — Environment variable name.
     *   - `npmPackageConfigName` — npm package config key.
     *   - `profileParameterName` — JSONPath into `contextParameters.parameters`.
     *   - `defaultValue` — Fallback if no other source resolves.
     *   - `notFoundIsExpected` — When `true`, resolving to `undefined` with no
     *     `defaultValue` is logged calmly (same `logLevel` as every other outcome) instead
     *     of at `LogLevels.Error`. Default `false` — unresolved-with-no-fallback is, for
     *     most callers, genuinely worth flagging loudly. Set this when the caller has its
     *     *own* separate fallback (e.g. an already-set value it'll just leave untouched)
     *     and "nothing configured here" is an entirely ordinary, expected outcome, not a
     *     problem — see `@controlium/framework`'s `API_AUTWrapper.loadSettings` for
     *     exactly this case.
     * @param contextParameters - Optional context used to resolve `profileParameterName`:
     *   - `parameters` — The actual object to query with `profileParameterName`.
     *   - `sourceName` — Label identifying what `parameters` *is* (e.g. `"World"` for a
     *     Cucumber World object), used in the returned `source` description in place of the
     *     generic default `"Profile"`. Purely cosmetic — doesn't affect resolution.
     * @returns `{ value, source }` — `value` is the resolved setting (or `undefined` if no
     *   source resolved); `source` always describes where it came from, even when `value`
     *   is `undefined` (`"Not found"`) or came from `defaultValue` (`"Default value"`).
     * @throws {Error} If `profileParameterName` is given but `contextParameters` is null.
     *
     * @example
     * Utils.getSetting(LogLevels.TestInformation, "apiUrl", { processEnvName: "API_URL" });
     * // => { value: "http://...", source: "Env var 'API_URL'" }
     *
     * Utils.getSetting(LogLevels.TestInformation, "apiUrl",
     *   { profileParameterName: "$.eaTest.apiUrl" },
     *   { sourceName: "World", parameters: world }
     * );
     * // => { value: "http://...", source: "World 'eaTest.apiUrl'" }
     */
    public static getSetting<returnType>(
        logLevel: LogLevel,
        settingName: string,
        sources: {
            processEnvName?: string | undefined;
            npmPackageConfigName?: string | undefined;
            profileParameterName?: string | undefined;
            defaultValue?: returnType | undefined;
            notFoundIsExpected?: boolean;
        },
        contextParameters?: SettingsContext,
    ): SettingResult<returnType> {
        // Validate all three inputs up front — a bad logLevel/settingName/sources shape would
        // otherwise surface as a confusing failure deep inside the resolution logic below.
        Utils.assertType(logLevel, "number", "Utils.getSetting", "logLevel");
        Utils.assertShape(settingName, "nonEmptyString", "Utils.getSetting", "settingName");
        Utils.assertShape(sources, "nonNullObject", "Utils.getSetting", "sources");
        const debugString = `Got setting [${settingName}] from `;

        // Highest priority — process environment variable. Only looked up at all if the
        // caller actually supplied a processEnvName; otherwise returnValue stays undefined
        // and this tier is skipped.
        let returnValue: unknown = sources.processEnvName ? process.env[sources.processEnvName] : undefined;
        if (!Utils.isUndefined(returnValue)) {
            // Found a value here — resolve immediately, without even looking at the lower-
            // priority sources below.
            Log.writeLine(logLevel, debugString + `env var [${sources.processEnvName}]. Value: <${returnValue as returnType}>`);
            return { value: returnValue as returnType, source: `Env var '${sources.processEnvName}'` };
        }

        // Next priority — npm package config variable. npm exposes these to a running script
        // as `npm_package_config_<name>` env vars, so the lookup is really just a differently-
        // prefixed env var read.
        returnValue = sources.npmPackageConfigName ? process.env["npm_package_config_" + sources.npmPackageConfigName] : undefined;
        if (!Utils.isUndefined(returnValue)) {
            Log.writeLine(logLevel, debugString + `npm package config var [${sources.npmPackageConfigName}]. Value: <${returnValue as returnType}>`);
            return { value: returnValue as returnType, source: `npm package config '${sources.npmPackageConfigName}'` };
        }

        // Neither env var nor npm config resolved anything — fall through to the profile-
        // parameter tier. Pull out the object to query and the cosmetic label used to describe
        // it in the eventual `source` string.
        const parameters = contextParameters?.parameters;
        const sourceLabel = contextParameters?.sourceName ?? "Profile";

        // How many properties does the profile path match? Only meaningful if both a path
        // and a context object were actually given.
        const matchCount = (!Utils.isUndefined(sources.profileParameterName) && parameters)
            ? JsonUtils.getMatchingJSONPropertyCount(parameters, sources.profileParameterName)
            : undefined;

        // If no profile parameter name given, or it doesn't match exactly one property, fall back to
        // default. "Matched nothing" and "matched more than one" are different problems — an ambiguous
        // path usually means the path itself is wrong, not that the setting is simply unconfigured —
        // so ambiguity gets its own distinct log message, even though both still fall back to the
        // same default/undefined result (the caller can't act differently either way, but a reader
        // debugging why a setting came back as the default needs to know which case it was).
        if (Utils.isUndefined(sources.profileParameterName) || matchCount !== 1) {
            // No usable profile match (either no path was given, nothing matched, or more than
            // one property matched) — fall through to defaultValue/undefined. Warn specifically
            // on the ambiguous (>1 match) case, since that usually means the path is wrong.
            if (typeof matchCount === "number" && matchCount > 1) {
                Log.writeLine(LogLevels.Warning, `Profile parameter [${sources.profileParameterName}] for setting [${settingName}] is ambiguous — matched ${matchCount} properties, expected exactly 1. Treating as not found.`);
            }
            returnValue = sources.defaultValue;
            if (Utils.isUndefined(returnValue)) {
                // Nothing resolved anywhere, and no default was given either — this is either a
                // normal "not configured" outcome (if the caller flagged it as expected) or a
                // genuine problem worth shouting about, depending on notFoundIsExpected.
                if (sources.notFoundIsExpected) {
                    Log.writeLine(logLevel, `Setting [${settingName}] not configured — no value to return.`);
                } else {
                    Log.writeLine(LogLevels.Error, `Unable to determine value for setting [${settingName}]. Returning: <undefined>!`);
                }
                return { value: undefined, source: "Not found" };
            } else {
                // A defaultValue was supplied and nothing higher-priority overrode it — use it.
                Log.writeLine(logLevel, debugString + `default value: <${returnValue as returnType}>`);
                return { value: returnValue as returnType, source: "Default value" };
            }
        }

        // Profile parameter name given AND exactly one match exists — use it. parameters must
        // be present here (matchCount above was only computed when it was), but double-check
        // explicitly rather than trusting that invariant silently.
        if (Utils.isNullOrUndefined(parameters)) {
            Log.logErrorAndThrow(`Settings: Caller defined Profile parameter [${sources.profileParameterName}] but contextParameters is null!`);
        }
        // Re-resolve the single matching property and read its value out.
        returnValue = JsonUtils.getPropertiesMatchingPath(parameters, sources.profileParameterName as string)[0].value as returnType;
        // Strip the JSONPath root ("$." or "$") for a human-readable path — "$.eaTest.apiUrl" -> "eaTest.apiUrl".
        const humanReadablePath = (sources.profileParameterName as string).replace(/^\$\.?/, "");
        Log.writeLine(logLevel, debugString + `profile property [${sources.profileParameterName}] value: <${returnValue as returnType}>`);
        return { value: returnValue as returnType, source: `${sourceLabel} '${humanReadablePath}'` };
    }

    /**
     * Sets a process environment variable and saves its original value for later restoration.
     *
     * The first time a variable is set, its original value is saved under a prefixed key.
     * Subsequent sets to the same variable do not overwrite the saved original.
     * Call {@link resetProcessEnvs} to restore all modified variables.
     *
     * @param varName - Name of the environment variable to set.
     * @param requiredValue - Value to assign.
     * @note If the variable did not previously exist, it is stored as `"_undefined"` so that
     *   {@link resetProcessEnvs} knows to delete it rather than restore a blank value.
     */
    public static setProcessEnv(varName: string, requiredValue: string): void {
        Log.writeLine(LogLevels.TestInformation, `Setting env var [${varName}] to '${requiredValue}'`);

        const originalValueKeyName = ENV_VAR_ORIGINAL_PREAMBLE + varName;
        if (originalValueKeyName in process.env) {
            // A saved original already exists — this isn't the first time this variable has
            // been set via setProcessEnv, so leave the saved original alone (overwriting it now
            // would lose the real pre-test value and restore the wrong thing later).
            Log.writeLine(LogLevels.TestDebug, `Env var [${varName}] has already been set (original value saved) — not overwriting saved original`);
            Log.writeLine(
                LogLevels.FrameworkInformation,
                `Original env var value is saved on first set only, to ensure the pre-test value can be restored.\nSubsequent sets do not overwrite the saved original.`
            );
        } else {
            // First time this variable is being set — capture its current value before
            // changing it, so resetProcessEnv can restore it later.
            const oldValue = process.env[varName];
            // Store "_undefined" if the var didn't previously exist, so resetProcessEnvs knows to delete it
            process.env[ENV_VAR_ORIGINAL_PREAMBLE + varName] = Utils.isUndefined(oldValue) ? "_undefined" : oldValue;
        }
        // Finally, actually set the variable to the requested value (coerced to a string, since
        // env vars are always strings).
        process.env[varName] = String(requiredValue);
    }

    /**
     * Restores a single process environment variable previously modified by {@link setProcessEnv}
     * back to its original value. Deletes it if it did not previously exist. A no-op (with a
     * debug log) if the variable was never modified via {@link setProcessEnv}.
     *
     * @param varName - Name of the environment variable to restore.
     * @see {@link setProcessEnv}
     * @throws {Error} If an error occurs while resetting the variable.
     */
    public static resetProcessEnv(varName: string): void {
        Utils.assertType(varName, "string", "Utils.resetProcessEnv", "varName");

        try {
            const originalValueKeyName = ENV_VAR_ORIGINAL_PREAMBLE + varName;
            // No saved original exists at all — this variable was never touched by
            // setProcessEnv, so there's nothing to restore. Log and bail out early.
            if (!(originalValueKeyName in process.env)) {
                Log.writeLine(
                    LogLevels.FrameworkDebug,
                    `No saved original value for env var [${varName}] (never set via setProcessEnv) — nothing to reset`
                );
                return;
            }
            const originalValue = process.env[originalValueKeyName];
            if (originalValue === "_undefined") {
                // The variable did not exist before setProcessEnv touched it — restore that
                // "didn't exist" state by deleting it, rather than setting it to the literal
                // string "_undefined".
                Log.writeLine(
                    LogLevels.FrameworkDebug,
                    `Found [${originalValueKeyName}] (Value: ${originalValue}) so deleting [${varName}] and [${originalValueKeyName}]`
                );
                delete process.env[varName];
            } else {
                // The variable had a real pre-test value — put it back exactly as it was.
                Log.writeLine(
                    LogLevels.FrameworkDebug,
                    `Found [${originalValueKeyName}] (Value: ${originalValue}) so restoring [${varName}] to [${originalValue}] and deleting [${originalValueKeyName}]`
                );
                process.env[varName] = originalValue as string;
            }
            // Either way, the saved-original bookkeeping key itself is no longer needed —
            // clean it up so a later resetProcessEnvs sweep doesn't try to process it again.
            delete process.env[originalValueKeyName];
        } catch (err) {
            const errMess = `Error resetting environment variable [${varName}]: ${Utils.errorMessage(err)}`;
            Log.logErrorAndThrow(errMess);
        }
    }

    /**
     * Restores all process environment variables that were modified by {@link setProcessEnv}
     * back to their original values. Variables that did not previously exist are deleted.
     *
     * @see {@link setProcessEnv}
     * @see {@link resetProcessEnv}
     * @throws {Error} If an error occurs while resetting variables.
     */
    public static resetProcessEnvs(): void {
        Object.keys(process.env)
            // Find every bookkeeping key setProcessEnv created (one per modified variable).
            .filter((key) => key.startsWith(ENV_VAR_ORIGINAL_PREAMBLE))
            // Strip the prefix back off to recover the real variable name each key is for.
            .map((key) => key.substring(ENV_VAR_ORIGINAL_PREAMBLE.length))
            // Restore each one individually via resetProcessEnv, which also cleans up its own
            // bookkeeping key as it goes.
            .forEach((varName) => Utils.resetProcessEnv(varName));
    }

    // ── Object / JSON ─────────────────────────────────────────────────────────

    /**
     * Returns a deep clone of an object or JSON string.
     * Uses JSON parse/stringify — only JSON-serialisable values are supported.
     *
     * @param original - The object or JSON5 string to clone.
     * @returns A deep clone of `original`.
     * @throws {Error} If `original` is not valid JSON (JSON5 allowed).
     */
    public static clone(original: object | string): object {
        // Only proceed if the value is actually (JSON5-)serialisable — this clone technique
        // works purely by round-tripping through JSON, so anything JSON can't represent
        // (functions, circular references, etc.) can't be cloned this way.
        if (JsonUtils.isJson(original, true)) {
            // If already a string, parse it directly (allowing JSON5 leniency); if it's an
            // object, first stringify it to normalise it into the same JSON text form, then
            // parse that back into a brand-new, fully independent object.
            return JsonUtils.parse(typeof original === "string" ? original : JSON.stringify(original as object), true);
        } else {
            const errText = "Object passed in is not valid JSON (JSON5 allowed) so cannot be cloned using JSON";
            Log.logErrorAndThrow(errText);
        }
    }

    /**
     * Converts a URL glob pattern to an equivalent `RegExp`. Thin, logged wrapper around
     * `picomatch` — see https://github.com/micromatch/picomatch for the full supported syntax
     * (including `*`, `**`, `?`, `{a,b}`, character classes, extglobs, and `!` negation).
     *
     * @param glob - The glob pattern to convert.
     * @param options - Optional anchoring flags:
     *   - `startOfLine` — Anchors the pattern to the start of the string (default: `true`).
     *   - `endOfLine` — Anchors the pattern to the end of the string (default: `true`).
     * @returns A `RegExp` equivalent to the given glob.
     * @throws {Error} If `glob` is not a string, or if `picomatch` cannot convert it.
     *
     * @example
     * Utils.globToRegex("src/**\/*.ts").test("src/foo/bar.ts"); // true
     */
    static globToRegex(glob: string, options?: { startOfLine: boolean; endOfLine: boolean }): RegExp {
        Utils.assertType(glob, "string", "Utils.globToRegex", "glob");
        const startOfLine = options?.startOfLine ?? true;
        const endOfLine = options?.endOfLine ?? true;

        try {
            const picomatchRegex = picomatch.makeRe(glob);
            // picomatch always anchors its output as `^...$` — strip those so we can apply
            // this function's own (asymmetric, independently-toggleable) anchoring instead.
            let corePattern = picomatchRegex.source;
            if (corePattern.startsWith("^")) corePattern = corePattern.slice(1);
            if (corePattern.endsWith("$")) corePattern = corePattern.slice(0, -1);
            const prefix = startOfLine ? "^" : "^.*";
            const suffix = endOfLine ? "$" : ".*$";
            return new RegExp(prefix + corePattern + suffix, picomatchRegex.flags);
        } catch (err) {
            const errText = `Cannot Utils.globToRegex as [glob] is not a valid glob pattern. Is [${Utils.describeValue(glob)}]: ${Utils.errorMessage(err)}`;
            Log.logErrorAndThrow(errText);
        }
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    /**
     * Decodes HTML entities in a string back to their corresponding characters.
     *
     * - Named entities (e.g. `&amp;`, `&copy;`) and numeric entities (`&#169;`, `&#x1F44D;`) are decoded.
     * - Non-breaking space characters (U+00A0) are replaced with regular spaces.
     * - Literal apostrophes (`'`) are replaced with `&apos;` before decoding for consistent handling.
     *
     * @param str - The HTML-encoded string to decode.
     * @returns The decoded string.
     * @throws {Error} If `str` is not a string.
     */
    static unescapeHTML(str: string): string {
        Utils.assertType(str, "string", "unescapeHTML", "str");
        // Literal apostrophes are re-encoded to &apos; first so decodeHTML treats them
        // consistently alongside genuine entity references, rather than leaving a raw "'"
        // character that's indistinguishable from one decodeHTML just produced.
        const preProcessed = str.replace(/'/g, "&apos;");
        // Decode all named/numeric HTML entities, then normalise non-breaking spaces (U+00A0 \u2014
        // a common entity-decode result, e.g. from &nbsp;) down to ordinary spaces.
        return decodeHTML(preProcessed).replace(/\u00A0/g, " ");
    }

    // ── JWT ───────────────────────────────────────────────────────────────────

    /**
     * Creates a signed JWT token.
     *
     * @param payloadData - The JWT payload as an object or JSON string.
     * @param signature - The signing secret or private key.
     * @param options - Signing options: either a partial options object with an optional
     *   `algorithm` (default `"HS256"`), or a raw JSON string for the JWT header.
     * @returns A signed Base64 JWT token string.
     * @throws {Error} If signing fails.
     */
    static createJWT(
        payloadData: string | object,
        signature: string,
        options?: Partial<{ algorithm?: string }> | string
    ): string {
        let payload: object | string;
        let optionsJWT: unknown;

        // `options` can be given two different ways — a raw JSON string for the JWT header
        // (quoted literal, trimmed of surrounding quotes), or a partial options object (just
        // pull its algorithm out, defaulting to HS256 if not given).
        if (typeof options === "string") {
            Log.writeLine(LogLevels.FrameworkDebug, `Options is a string: [${options}]`);
            optionsJWT = StringUtils.trimQuotes(options as string);
        } else {
            Log.writeLine(LogLevels.FrameworkDebug, `Options not a string:\n${JSON.stringify(options, null, 2)}`);
            optionsJWT = { algorithm: options?.algorithm ?? "HS256" };
        }

        // The payload may be given as either a JSON string or an already-parsed object. If it
        // looks like valid JSON (JSON5 allowed), parse a string form into a real object so
        // jwtSign always receives a consistent object shape; a string payload that ISN'T JSON
        // is logged as a (non-fatal) warning, since a test may genuinely intend a raw string
        // payload, but it's worth flagging in case it's actually a typo.
        if (JsonUtils.isJson(payloadData, true)) {
            Log.writeLine(LogLevels.FrameworkDebug, `Payload is JSON [${typeof payloadData === "string" ? "string" : "object"}]`);
            payload = typeof payloadData === "string" ? JsonUtils.parse(payloadData, true) : payloadData;
        } else {
            Log.writeLine(LogLevels.Error, `Payload is NOT JSON (may be intended by test): [${payloadData}]`);
            payload = payloadData;
        }

        // Signatures/private keys are sometimes passed with literal "\\n" sequences (e.g. from
        // an env var or a single-line config value) standing in for real newlines — normalise
        // those back to actual newline characters before use (multi-line PEM keys need real
        // newlines to parse correctly).
        const normalizedSignature = StringUtils.replaceAll(signature, '\\\\n', '\n');
        Log.writeLine(LogLevels.FrameworkDebug, `Signature: ${normalizedSignature}`);

        // When options came in as a string, it's JWT header JSON that still needs parsing and
        // wrapping in a `{ header: ... }` shape for jwtSign; when it came in as an object,
        // optionsJWT is already the full sign-options object jwtSign expects directly.
        const jwtHeader = typeof options === "string" ? { header: JsonUtils.parse(optionsJWT as string, true) } : optionsJWT as object;
        Log.writeLine(LogLevels.FrameworkDebug, `JWT Sign options:\n${JSON.stringify(jwtHeader, null, 2)}`);
        try {
            return jwtSign(payload, normalizedSignature, jwtHeader);
        } catch (err) {
            // Render the newlines back to a visible "<NEWLINE>" marker in the error message —
            // a real embedded newline would otherwise make the logged error harder to read.
            const errText = `Error creating [${typeof options === 'string' ? options : JSON.stringify(options as object)}] JWT token from [${payloadData}] (signature: [${StringUtils.replaceAll(signature, '\\\\n', '<NEWLINE>')}]): ${Utils.errorMessage(err)}`;
            Log.logErrorAndThrow(errText);
        }
    }

    /**
     * Checks whether a string is a structurally valid JWT token.
     *
     * @param jwtToken - The token string to validate.
     * @returns `true` if the token can be decoded, `false` otherwise.
     */
    static isValidJWT(jwtToken: string): boolean {
        try {
            return !Utils.isUndefined(jwtDecode(jwtToken));
        } catch {
            return false;
        }
    }

    /**
     * Decodes and returns the payload of a JWT token as an object.
     *
     * @param jwtToken - A valid JWT token string.
     * @returns The decoded payload as an object.
     * @throws {Error} If the token cannot be decoded or the payload is not an object.
     */
    static getJWTPayload(jwtToken: string): object {
        try {
            // { json: true } tells jwtDecode to parse the payload as JSON rather than return
            // the raw decoded string.
            let payload = jwtDecode(jwtToken, { json: true });
            // jwtDecode returns null for a token it can't decode at all — normalise that to an
            // empty object so callers always get a real object back (or a thrown error, never null).
            payload = Utils.isNull(payload) ? {} : payload;
            // The decoded payload should always be a JSON object — if jwtDecode somehow returned
            // some other JSON type (a bare string/number/array), that's unexpected and worth
            // failing on explicitly rather than returning a non-object silently.
            if (typeof payload !== "object") {
                throw new Error(`Not an object. Is [${typeof payload}]. Expected JSON object.`);
            }
            return payload as object;
        } catch (err) {
            const errText = `Error getting payload from JWT [${jwtToken ?? "<Undefined>"}]: ${Utils.errorMessage(err)}`;
            Log.logErrorAndThrow(errText);
        }
    }

    // ── Process management ────────────────────────────────────────────────────

    /**
     * Spawns a command as a background process.
     *
     * @param command - The command to execute.
     * @param args - Arguments to pass to the command.
     * @param options - Optional settings:
     *   - `logStdout` — Logs stdout at `TestInformation` level (default: `false`).
     *   - `logStderr` — Logs stderr and process errors at `Error` level (default: `false`).
     *   - `spawnOptions` — Additional options passed to `child_process.spawn`.
     * @returns The spawned `ChildProcess`.
     * @throws {Error} If the process fails to start (PID is `undefined`).
     */
    static spawnBackgroundProcess(command: string, args: string[], { logStdout = false, logStderr = false, spawnOptions = undefined }: { logStdout?: boolean, logStderr?: boolean, spawnOptions?: SpawnOptionsWithoutStdio } = {}): ChildProcessWithoutNullStreams {
        Log.writeLine(LogLevels.TestInformation, `Executing: ${command} ${args.join(' ')}`);
        const childProcess = spawn(command, args, spawnOptions);
        // Node sets pid to undefined if the spawn itself failed synchronously (e.g. command not
        // found on some platforms) — treat that as fatal rather than returning a broken handle.
        if (childProcess?.pid === undefined) {
            const errText = `Unable to spawn [${command}] with args [${args.join(', ')}] and options [${spawnOptions === undefined ? '' : JSON.stringify(spawnOptions)}] — spawn returned undefined PID`;
            Log.logErrorAndThrow(errText);
        }
        Log.writeLine(LogLevels.TestInformation, `Started process: PID ${childProcess.pid}`);

        // Only attach a stdout listener if the caller actually wants stdout logged — an
        // unconsumed stdout stream otherwise just buffers quietly, so this is opt-in, not free.
        if (logStdout) {
            childProcess.stdout.on('data', (data) => {
                Log.writeLine(LogLevels.TestInformation, `Background(stdout): ${data.toString()}`, { suppressAllPreamble: true });
            });
        }
        if (logStderr) {
            // Mirror stdout handling for stderr, plus also listen for a process-level 'error'
            // event (e.g. the child process failing to spawn asynchronously, or an IPC failure)
            // — these are only surfaced when the caller cares about stderr/error-level output.
            childProcess.stderr.on('data', (data) => {
                Log.writeLine(LogLevels.TestInformation, `Background(stderr): ${data.toString()}`, { suppressAllPreamble: true });
            });
            childProcess.on('error', (err) => {
                Log.writeLine(LogLevels.Error, `Background process error: ${Utils.errorMessage(err)}`, { suppressAllPreamble: true });
            });
        }
        return childProcess;
    }

    /**
     * Spawns a command as a background process and waits for it to exit, with a timeout.
     *
     * @param command - The command to execute.
     * @param args - Arguments to pass to the command.
     * @param timeoutSeconds - Maximum time in seconds to wait before forcibly terminating the process.
     * @param options - Optional settings (same as {@link spawnBackgroundProcess}).
     * @returns A promise resolving to the process exit code, or `-1` on timeout or error.
     */
    static async spawnBackgroundProcessWithTimeout(command: string, args: string[], timeoutSeconds: number, { logStdout = false, logStderr = false, spawnOptions = undefined }: { logStdout?: boolean, logStderr?: boolean, spawnOptions?: SpawnOptionsWithoutStdio } = {}): Promise<number> {
        return new Promise((resolve) => {
            const child = Utils.spawnBackgroundProcess(command, args, { logStdout, logStderr, spawnOptions });
            // Three different events (exit, error, timeout) could all try to resolve this
            // promise — `exited` ensures only the first one to fire actually does anything,
            // since a Promise can only settle once anyway but the cleanup logic (clearing the
            // timeout, logging) still needs this guard to avoid running twice.
            let exited = false;

            // Normal case — the process finished on its own before the timeout.
            child.on('exit', (code) => {
                if (!exited) {
                    Log.writeLine(LogLevels.TestInformation, `Process [${child.pid ?? 'unknown'}] exited. Code: ${code ?? 'undefined!'}`);
                    exited = true;
                    clearTimeout(timeout);
                    resolve(code ?? -1);
                }
            });

            // The process itself failed to run at all (not a normal non-zero exit code, but a
            // spawn-level failure) — treat this as a -1 result, same as a timeout.
            child.on('error', (err) => {
                if (!exited) {
                    Log.writeLine(LogLevels.Error, `Process [${child.pid ?? 'unknown'}] errored:\n${err ?? 'unknown error'}`);
                    exited = true;
                    clearTimeout(timeout);
                    resolve(-1);
                }
            });

            // If the user Ctrl+C's the test runner itself, make sure the spawned child (and its
            // own descendants) don't keep running as orphaned background processes.
            process.on('SIGINT', () => {
                Log.writeLine(LogLevels.Error, `Caught SIGINT (Ctrl+C) — terminating child process [${child.pid ?? 'unknown'}]...`);
                Utils.terminateBackgroundProcess(child, { signal: 'SIGINT' });
            });

            // The process didn't exit (or error) within the allotted time — forcibly terminate
            // it (and its descendants) and resolve with -1 to signal the timeout to the caller.
            const timeout = setTimeout(() => {
                if (!exited) {
                    const errMessage = `Timeout — child process [${child.pid ?? 'unknown'}] did not exit within ${timeoutSeconds} seconds`;
                    Log.writeLine(LogLevels.Error, errMessage);
                    exited = true;
                    Utils.terminateBackgroundProcess(child);
                    resolve(-1);
                }
            }, timeoutSeconds * MS_PER_SECOND);
        });
    }

    /**
     * Executes a shell command and returns its stdout output.
     *
     * @param command - The shell command to run.
     * @returns A promise resolving to the stdout string.
     * @throws The error or stderr string if the command fails.
     */
    static async execCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            Log.writeLine(LogLevels.TestDebug, `Exec command: >> ${command} <<`);
            exec(command, (error, stdout, stderr) => {
                // Treat either a genuine error OR any stderr output as a failure — a command
                // writing to stderr (even with a zero exit code) is usually a sign something
                // went wrong that the caller should see as a rejection, not a silent success.
                if (error || stderr) {
                    Log.writeLine(LogLevels.TestDebug, `Error thrown so rejecting (${stderr ?? ''}): \n${error?.message ?? 'No error detail!'}`);
                    reject(error || stderr);
                } else {
                    Log.writeLine(LogLevels.TestDebug, `Resolved: >> ${stdout ?? ''} <<`);
                    resolve(stdout);
                }
            });
        });
    }

    /**
     * Checks whether a process with the given PID is currently running.
     *
     * @param pid - The process ID to check.
     * @returns `true` if the process is running (or exists but cannot be signalled), `false` if it does not exist.
     * @throws Any unexpected error from `process.kill`.
     */
    static isProcessRunning(pid: number): boolean {
        try {
            // Signal 0 sends no actual signal — it's the standard POSIX trick for just checking
            // whether a process exists/can be signalled, without affecting it.
            process.kill(pid, 0);
            return true;
        } catch (err) {
            if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') {
                const error = err as NodeJS.ErrnoException;
                // ESRCH — no such process; it genuinely isn't running.
                if (error.code === 'ESRCH') return false;
                // EPERM — the process exists but we lack permission to signal it (e.g. owned by
                // another user) — it IS running, we just can't prove it via signalling.
                if (error.code === 'EPERM')  return true;
            }
            // Any other, unrecognised failure — don't guess; let it propagate so the caller
            // sees the real underlying problem.
            throw err;
        }
    }

    /**
     * Sends a signal to a process and all of its descendants. Thin, logged wrapper around
     * `tree-kill` — chosen over a hand-rolled `ps`-tree-walk because it also handles Windows
     * correctly (via `taskkill /T /F`), where POSIX signals don't translate the way
     * `process.kill(pid, signal)` alone would assume.
     *
     * Individual kill failures (e.g. a descendant that already exited in a race) are logged
     * but do not reject the returned promise — this is a best-effort cleanup operation, and a
     * benign race during teardown should never mask the actual test failure by throwing.
     *
     * @param rootPid - PID of the root process to terminate.
     * @param signal - Signal to send (default: `"SIGKILL"`). Ignored on Windows — `taskkill /F`
     *   is unconditional there, matching `tree-kill`'s own platform behaviour.
     * @throws {Error} If `rootPid` is not a number.
     */
    static async killProcessAndDescendants(rootPid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
        Utils.assertType(rootPid, "number", "Utils.killProcessAndDescendants", "rootPid");
        return new Promise((resolve) => {
            treeKill(rootPid, signal, (err) => {
                if (err) {
                    Log.writeLine(LogLevels.Error, `Killing process tree rooted at [${rootPid}] with [${signal}] threw error (ignoring): ${Utils.errorMessage(err)}`);
                }
                resolve();
            });
        });
    }

    /**
     * Terminates a background process and all its descendants, waiting for the process to close.
     *
     * @param backgroundProcess - The process to terminate.
     * @param options - Optional settings:
     *   - `signal` — Signal to use (default: `"SIGKILL"`).
     * @returns A promise resolving to `true` once the process closes, or `false` if no valid process was provided.
     */
    static async terminateBackgroundProcess(backgroundProcess: ChildProcessWithoutNullStreams, options: { signal?: string | number } = {}): Promise<boolean> {
        const signal = (options.signal ?? 'SIGKILL') as NodeJS.Signals;

        // No process handle at all — nothing to do, and not an error (a caller may routinely
        // call this on a process that was never started).
        if (Utils.isNullOrUndefined(backgroundProcess)) {
            Log.writeLine(LogLevels.TestInformation, `No background process executing — nothing to terminate`);
            return false;
        }
        // A process handle exists but has no PID — this shouldn't normally happen (spawning
        // already validates the PID), but guard against it rather than passing undefined to kill.
        if (Utils.isNullOrUndefined(backgroundProcess.pid)) {
            Log.writeLine(LogLevels.Error, `Background process has no PID — cannot terminate`);
            return false;
        }

        const processPid = backgroundProcess.pid!;
        // Set up the "closed" listener BEFORE actually sending the kill signal below, so there's
        // no race where the process closes before the listener is attached and the event is missed.
        const promise = new Promise<boolean>((resolve) => {
            backgroundProcess.on('close', (code, signal) => {
                Log.writeLine(LogLevels.TestInformation, `Process [${processPid}] closed [Code: ${code ?? '<No Code>'}], Signal: ${signal ?? 'None'}`);
                resolve(true);
            });
        });
        // Now actually send the kill signal to the process and all its descendants, then wait
        // for the 'close' event above to confirm it's actually gone before returning.
        await this.killProcessAndDescendants(processPid, signal);
        return promise;
    }

    // ── Promise utilities ─────────────────────────────────────────────────────

    /**
     * Pauses execution for the given number of milliseconds.
     *
     * @param periodMS - Duration to wait in milliseconds.
     * @param logIt - When `true`, logs the sleep duration at `FrameworkDebug` level (default: `false`).
     * @returns A promise that resolves after the given duration.
     */
    static async sleep(periodMS: number, logIt?: boolean) {
        periodMS = Number(periodMS);
        if (logIt === true) Log.writeLine(LogLevels.FrameworkDebug, `Sleeping for [${periodMS}] milliseconds`);
        return new Promise((resolve) => {
            setTimeout(resolve, periodMS);
        });
    }

    /**
     * Pauses Node.js execution until a keyboard key is pressed, while keeping the event loop running.
     *
     * @param logOutput - Optional message to write to the log before pausing.
     * @returns A promise that resolves when a key is pressed.
     * @warning This hangs indefinitely in non-TTY environments (e.g. CI pipelines).
     *   In such cases the call is logged and returns immediately.
     */
    static async pause(logOutput?: string): Promise<void> {
        if (logOutput) {
            Log.writeLine(LogLevels.TestInformation, logOutput);
        }
        const stdin = process.stdin;

        // A non-TTY stdin (e.g. piped input, or a CI pipeline with no interactive terminal at
        // all) has no keyboard to wait for — pausing here would hang forever, so detect that
        // and return immediately instead, just logging that the pause was skipped.
        if (!stdin.isTTY) {
            Log.writeLine(LogLevels.Error, "Stdin is not a TTY — cannot pause for key press. Ignoring.");
            return;
        }

        return new Promise<void>((resolve) => {
            // Shared teardown for once the key press has been seen — turn raw mode back off,
            // re-pause stdin, and remove this specific listener so it doesn't linger.
            const cleanup = () => {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener("data", onData);
            };

            const onData = (chunk: Buffer) => {
                Log.writeLine(LogLevels.TestDebug, `Input received: ${JSON.stringify(chunk.toString(), null, 2)}`);
                cleanup();
                resolve();
            };

            // Drain any buffered input before attaching the listener — anything typed before
            // this function was even called (e.g. buffered ahead of a slow test) must not
            // immediately satisfy the pause, so resume reading, throw away whatever's sitting
            // in the buffer, then pause again so the slate is clean.
            stdin.resume();
            while (stdin.read() !== null) { /* draining */ }
            stdin.pause();

            // Attach a one-shot data listener (fires on the very next key press only), switch
            // into raw mode (so a single keystroke is delivered immediately, without waiting
            // for Enter/line-buffering), then resume reading to actually start listening.
            stdin.once("data", onData);
            stdin.setRawMode(true);
            stdin.resume();
        });
    }

    /**
     * Wraps a promise with a timeout and tracks it in the outstanding promise count.
     *
     * The count is accessible via {@link promiseCount} and can be checked at the end of a
     * test to verify all promises have settled. Use {@link resetPromiseCount} to clear
     * the count between tests.
     *
     * @param promise - The promise to wrap.
     * @param options - Optional settings:
     *   - `timeoutMS` — Timeout in milliseconds. Falls back to {@link defaultPromiseTimeout} if not given.
     *   - `friendlyName` — Name shown in the timeout error message (defaults to the caller's function name).
     * @returns A promise that resolves/rejects with the original result, or rejects with a timeout error.
     * @throws {Error} If no timeout is configured (neither `timeoutMS` nor `defaultPromiseTimeout` is set).
     * @throws {Error} If `timeoutMS` is negative.
     */
    static async timeoutPromise<T>(promise: Promise<T>, options: { timeoutMS?: number, friendlyName?: string } = {}): Promise<T> {
        // Track this as an outstanding promise for the duration of the call — incremented here,
        // decremented in the `finally` below regardless of whether it resolves, rejects, or times out.
        Utils._promiseCount++;
        // If the caller didn't give a friendly name, try to infer the calling function's own
        // name from the stack as a fallback, so timeout error messages are still identifiable.
        const operationName = options?.friendlyName ?? (this.inferCallerFunctionName() || "Unknown operation");
        try {
            // No per-call timeout was given, and no workspace-wide default has been configured
            // either — there's nothing to time out against, which is a configuration mistake
            // worth failing on loudly rather than silently waiting forever.
            if (Utils.isNullOrUndefined(options?.timeoutMS) && Utils._defaultPromiseTimeout === 0) {
                const errText = 'Utils.timeoutPromise: No timeout given and default not set (have you initialised the default timeout?)';
                Log.logErrorAndThrow(errText);
            }
            // Use the per-call timeout if given, otherwise fall back to the configured default.
            const actualTimeout = (Utils.isNullOrUndefined(options?.timeoutMS) ? Utils._defaultPromiseTimeout : options?.timeoutMS) as number;
            if (actualTimeout < 0) {
                const errText = `Utils.timeoutPromise: Timeout cannot be negative. Was [${actualTimeout}]`;
                Log.logErrorAndThrow(errText);
            }
            // Delegate the actual race-against-a-timer logic to withTimeout.
            return this.withTimeout<T>(promise, { timeoutMS: actualTimeout, friendlyName: operationName });
        } finally {
            // Always decrement, whatever happened above — keeps promiseCount accurate even on
            // an early throw from the validation checks.
            Utils._promiseCount--;
        }
    }

    /**
     * @deprecated Use {@link timeoutPromise} instead.
     */
    static async withTimeoutTracked<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return this.withTimeout<T>(promise, { timeoutMS: timeoutMs, friendlyName: this.inferCallerFunctionName() ?? undefined });
    }

    // ── Action parsing ────────────────────────────────────────────────────────

    /**
     * Parses a raw action string into a verb and a parameter map.
     *
     * The expected format is `actionName(param1: value1, param2: value2)` where the
     * parameter block is valid JSON5 without the outer braces. If no parentheses are
     * present, `parameters` will be an empty map.
     *
     * @param rawAction - The raw action string to parse.
     * @returns A {@link Utils.ActionAndParams} object with `action`, `normalizedAction`, and `parameters`.
     * @throws {Error} If the parameter block is not valid JSON5.
     *
     * @example
     * Utils.splitActionAndParameters("click(target: '#btn', force: true)");
     * // => { action: "click", normalizedAction: "click", parameters: Map { "target" => "#btn", "force" => true } }
     */
    static splitActionAndParameters(rawAction: string): ActionAndParams {
        // Split "actionName(param1: value1, ...)" into the bare verb and the raw text inside
        // the parentheses — StringUtils owns the actual splitting logic.
        const actionAndParameters = StringUtils.splitVerbAndParameters(rawAction);
        const normalizedAction = actionAndParameters.verb.toLowerCase().trim();

        if (StringUtils.isBlank(actionAndParameters.parameters)) {
            // No parentheses, or empty parentheses — no parameters to parse, return an empty map.
            return { action: actionAndParameters.verb, normalizedAction, parameters: new Map() };
        } else {
            // Wrap the inner text back in braces to form a real JSON5 object literal, then
            // validate and parse it that way, converting the resulting object's entries into a Map.
            const paramsJSON = "{" + actionAndParameters.parameters + "}";
            if (JsonUtils.isJson(paramsJSON, true)) {
                const paramsMap = new Map(Object.entries(JsonUtils.parse(paramsJSON, true)));
                return { action: actionAndParameters.verb, normalizedAction, parameters: paramsMap };
            } else {
                // The parenthesised content isn't valid JSON5 once wrapped in braces — the
                // action string itself is malformed, so fail loudly with the raw content shown.
                const errText = `Invalid action [${actionAndParameters.verb}] parameter syntax. Expected (param1: <value>, param2: <value2>, ...). Got: (${actionAndParameters.parameters})`;
                Log.logErrorAndThrow(errText);
            }
        }
    }

    // ── Enum helpers ──────────────────────────────────────────────────────────

    /**
     * Checks whether a value exists as a member of the given enum.
     *
     * @param enumType - The enum object to check against.
     * @param valueToCheck - The value to look for.
     * @returns `true` if the value is a member of the enum, `false` otherwise.
     */
    static checkENUMValueExists(enumType: object, valueToCheck: string) {
        try {
            // Object.values on a TS enum object returns every member's runtime value — just
            // check whether the value under test is among them.
            return Object.values(enumType).includes(valueToCheck);
        } catch {
            // enumType wasn't actually a usable object (e.g. null) — fail closed as "not found"
            // rather than letting this throw.
            return false;
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Converts data to a string suitable for writing to a file:
     * - JSON strings are normalised (parsed then re-stringified)
     * - Non-JSON strings are used as-is
     * - Objects are pretty-printed as JSON
     */
    private static serialiseFileData(data: string | object): string {
        if (typeof data === "string") {
            // A string that happens to already be valid (strict) JSON is normalised by
            // round-tripping it through parse/stringify (e.g. collapses formatting/whitespace
            // differences); a string that ISN'T JSON is written out exactly as given.
            return JsonUtils.isJson(data) ? JSON.stringify(JSON.parse(data)) : data;
        }
        // A real object — pretty-print it with 2-space indentation for a readable file.
        return JSON.stringify(data, null, 2);
    }

    private static async withTimeout<T>(promise: Promise<T>, options: { timeoutMS?: number, friendlyName?: string } = {}): Promise<T> {
        let timeoutHandle: NodeJS.Timeout;
        // Build a second promise that does nothing but reject once timeoutMS elapses — this is
        // the thing the real `promise` races against below. The friendlyName, if given, is
        // prefixed onto the rejection message so a timeout error is actually traceable to the
        // operation that caused it.
        const timeoutPromise = new Promise<T>((_, reject) => {
            timeoutHandle = setTimeout(
                () => reject(new Error(`${Utils.isNullOrUndefined(options?.friendlyName) ? 'T' : `${options?.friendlyName}: T`}imeout after ${options?.timeoutMS ?? '0'} ms`)),
                options?.timeoutMS ?? 0
            );
        });
        // Whichever side of the race settles first, the other side's timer must still be
        // cleared — otherwise a won-by-promise race leaves the losing setTimeout running for
        // the full timeoutMS, holding the Node event loop open even though the real operation
        // already finished (confirmed in production: a Cucumber-JS suite hanging ~30s after
        // all scenarios passed, matching the default timeout exactly).
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
    }

    private static inferCallerFunctionName(): string | null {
        // Creating an Error here (without throwing it) is purely a way to capture a stack
        // trace at this exact point — split it into individual frame lines.
        const error = new Error();
        const stackLines = error.stack?.split("\n") || [];
        // Frame 0 is "Error", frame 1 is this function itself (inferCallerFunctionName), frame
        // 2 is whichever Utils method called it (e.g. timeoutPromise) — frame 3 is the actual
        // caller of THAT, which is the function name we actually want to report.
        const callerLine = stackLines[3] || "";
        // V8 stack frames look like "    at FunctionName (file:line:col)" — extract just the
        // function name portion.
        const match = callerLine.match(/at (.+?) \(/);
        return match ? match[1] : null;
    }
}

/**
 * The parsed result of a raw action string, as returned by {@link Utils.splitActionAndParameters}.
 */
export interface ActionAndParams {
    /** Original non-normalized action verb */
    action: string;
    /** Lowercase and trimmed action verb */
    normalizedAction: string;
    /** All action parameters passed by the caller */
    parameters: Map<string, unknown>;
}
