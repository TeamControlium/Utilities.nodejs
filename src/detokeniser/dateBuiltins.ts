import { addDays, addHours, addMinutes, addMonths, addYears, format } from "date-fns";
import { formatInTimeZone, getTimezoneOffset } from "date-fns-tz";

import { Log, LogLevels, StringUtils, Utils } from "../index.js";
import type { Detokeniser } from "./detokeniser.js";
import { findLeadingParenCall } from "./verbArgGrammar.js";

/**
 * Date/time-related built-in verbs: `date`, `timezone`, `diff`. Not part of this package's
 * public API — only imported by `detokeniser.ts` to register these as built-in handlers.
 *
 * ### `date` — date and time
 * Format is a [date-fns format string](https://date-fns.org/docs/format), or the special
 * values `epoch` (milliseconds since 1970-01-01) or `second-epoch`.
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
 */

interface DateTokenPreambleReturn {
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

export function builtinDate(context: Detokeniser.CallbackContext): string {
  // 'date' needs at least an offset verb and a format (doDateToken enforces the exact
  // shape, including the optional 3rd IANA-zone part) — this just guards against a
  // completely empty body.
  if (StringUtils.isBlank(context.args))
    throw new Error(`Date token [${context.rawVerb}] needs 2 or 3 parts {{date;<offset>;<format>[;<ianaZone>]}}`);
  return doDateToken(context.args, context.delimiter);
}

export function builtinTimezone(context: Detokeniser.CallbackContext): string {
  // 'timezone' needs exactly the IANA zone name to validate.
  if (StringUtils.isBlank(context.args)) throw new Error(`Timezone token [${context.rawVerb}] needs an IANA zone name (IE. {{timezone;Europe/London}})`);
  return doTimezoneToken(context.args);
}

export function builtinDiff(context: Detokeniser.CallbackContext): string {
  // 'diff' needs exactly two IANA zone names — doDiffToken enforces the exact count.
  if (StringUtils.isBlank(context.args)) throw new Error(`Diff token [${context.rawVerb}] needs 2 IANA zone names (IE. {{diff;<zoneA>;<zoneB>}})`);
  return doDiffToken(context.args, context.delimiter);
}

function doDateToken(tokenBody: string, delimiter: string): string {

  ////////////////////////////////////////////////////
  //
  // Resolver for `[[date|...]]` tokens: starts from the current time, resolves the verb's
  // offset via the preamble/verb helpers, then formats the result. Fully synchronous — no
  // verb this token supports needs to await anything external.

  let date = new Date().getTime();
  const dateTokenPrep = doDateTokenPreamble(date, tokenBody, delimiter);
  date = doDateTokenVerb(date, dateTokenPrep);
  return doDateTokenPostamble(dateTokenPrep.offsetAndFormat, date, dateTokenPrep.ianaZone);
}

function doDateTokenPreamble(date: number, tokenBody: string, delimiter: string): DateTokenPreambleReturn {

  ////////////////////////////////////////////////////
  //
  // Setup for doDateToken: splits tokenBody into its offset/verb part, its format part,
  // and an optional 3rd raw-IANA-zone part; validates that zone (if given) against the
  // runtime's own timezone database; extracts the verb name and its parenthesised params
  // (if any) from the offset part; and bundles up every verb-specific error message string
  // up front so each calling branch can just reference the one it needs rather than
  // building it inline.

  // Find the offset expression first — a bare verb (e.g. "today") or a name(...)-shaped call
  // (e.g. "addDays(5)", "random(0,100)", "followingDay(epoch,wednesday)") — via the shared,
  // quote-aware findLeadingParenCall, rather than splitting the whole tokenBody on the
  // delimiter first: addDays/random/followingDay's own params are numeric/fixed-vocabulary
  // today, so a delimiter character embedded in them is a low-probability risk in practice,
  // but finding the call's own real closing ')' before splitting at all means this verb never
  // has to re-derive that correctness independently of random|from(...)'s identical need.
  const leadingCall = findLeadingParenCall(tokenBody.trim());
  let offsetExpr: string;
  let formatAndZoneText: string;
  if (leadingCall) {
    offsetExpr = leadingCall.call;
    // Normally the delimiter immediately follows the call's own closing ')' — strip it. If
    // something else trails it instead, hand the whole remainder through unstripped; the
    // plain split and format-string validation below still catch it, just without a
    // bespoke "trailing content" message (unlike random|from(...), whose own quoted-list
    // content makes that case realistic enough to name specifically — see that verb's own
    // splitRandomVerbArgs for the contrast).
    formatAndZoneText = leadingCall.remainder.startsWith(delimiter) ? leadingCall.remainder.slice(delimiter.length) : leadingCall.remainder;
  } else {
    // Not a name(...)-shaped call at all — a bare verb (e.g. "today") or a fixed "yyyy-MM-dd"
    // date. Split at the first delimiter, exactly as the old whole-string split did for this
    // case (there's no parens content here for a delimiter to hide inside).
    const firstDelimiterIndex = tokenBody.indexOf(delimiter);
    offsetExpr = firstDelimiterIndex === -1 ? tokenBody : tokenBody.substring(0, firstDelimiterIndex);
    formatAndZoneText = firstDelimiterIndex === -1 ? "" : tokenBody.substring(firstDelimiterIndex + delimiter.length);
  }
  // Split whatever follows the offset expression into [format, ianaZone?] — e.g.
  // ["dd-MM-yyyy"] or ["dd-MM-yyyy", "Europe/London"]. The zone is genuinely optional —
  // omitting it means "format in local time", same as before this token supported zones at
  // all. Deliberately NOT StringUtils.splitRemainingQuoted — the format part is a date-fns
  // format string, which already uses a leading `'` for its own literal-text escaping (e.g.
  // 'T'HH:mm). Quote-aware splitting would misread that as this method's own quoting syntax
  // and corrupt it. See doRandomToken's identical note (randomBuiltins.ts) for its date(...)
  // sub-variant.
  const formatAndZone = StringUtils.splitRemaining(formatAndZoneText, delimiter, 2);
  const offsetAndFormat = [offsetExpr, formatAndZone[0]];
  const ianaZone = formatAndZone[1];

  // Must have an actual format — formatAndZoneText was blank if either no delimiter followed
  // the offset expression at all, or (for a name(...)-shaped call) nothing trailed its own
  // closing ')'.
  if (StringUtils.isBlank(formatAndZone[0])) throw new Error("Date token does not have a format parameter; example: {date;today;dd-MM-yyyy}");
  // A zone was actually supplied — validate it now, up front, rather than letting a typo
  // surface later as a confusing date-fns formatting error.
  if (ianaZone) assertValidIANAZone(ianaZone, "Date token's timezone");

  Log.writeLine(LogLevels.TestDebug, `Time now is [${date}] (Epoch) and we are in [${ianaZone ?? "<local time>"}]`);

  return {
    offsetAndFormat: offsetAndFormat,
    // verb is the offset expression's name only — strip everything from its own leading "("
    // onward for a matched call (e.g. "addDays(5)" → "addDays"); otherwise the whole offset
    // expression is the verb (e.g. "today").
    verb: (leadingCall ? offsetExpr.split("(")[0] : offsetExpr).toLowerCase().trim(),
    // params is whatever's between the matched call's own parens (e.g. "5" from
    // "addDays(5)"), taken from its own known end (not a second ".split("(")" call, which
    // would misparse a param value containing its own "(" or a quoted ")"), or undefined if
    // there was no name(...)-shaped call at all (e.g. "today").
    params: leadingCall ? offsetExpr.slice(offsetExpr.indexOf("(") + 1, offsetExpr.length - 1) : undefined,

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

function doDateTokenPostamble(offsetAndFormat: string[], date: number, ianaZone: string | undefined): string {

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
    // that caused it for context, including the original stack trace (on its own line —
    // this was previously the two literal characters "/r", not an actual line break, so
    // the stack trace ran on straight after the message with nothing separating them).
    const errorText = `Error formatting date [${date}] with format string[${offsetAndFormat[1]}]: ${Utils.errorMessage(err)}`;
    const stack = err instanceof Error ? err.stack : undefined;
    throw new Error(stack ? `${errorText}\n${stack}` : errorText);
  }
}

function doDateTokenVerb(date: number, dateTokenPrep: DateTokenPreambleReturn): number {

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
        returnDate = doRandomDate(dateTokenPrep.params as string);
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
      returnDate = addYears(date, getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
      break;
    case "addmonths":
      returnDate = addMonths(date, getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
      break;
    case "adddays":
      returnDate = addDays(date, getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
      break;
    case "addhours":
      returnDate = addHours(date, getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
      break;
    case "addminutes":
      returnDate = addMinutes(date, getParsedDateOffset(dateTokenPrep.params, dateTokenPrep.errParseDateOffset)).getTime();
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
        returnDate = getFollowingDay(
          getParsedDateOffset(currentAndDay[0], dateTokenPrep.errInvalidEpoch),
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
        // The verb itself is a fixed "yyyy-MM-dd" date, not an offset keyword — the tester
        // just wants that exact date formatted, with no offset applied.
        const date = dateTokenPrep.verb.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        // Pull year/month/day out of the regex match; month is 0-indexed for Date.UTC. No
        // `?? 0` fallback needed here — the regex above only ever matches all-digit groups,
        // so Number(...) on any of them always succeeds (never returns NaN, let alone
        // null/undefined, which is the only thing `??` would actually catch).
        const year = Number((date as Array<string>)[1]);
        const month = Number((date as Array<string>)[2]) - 1;
        const day = Number((date as Array<string>)[3]);
        Log.writeLine(LogLevels.TestDebug, `Date got fixed date:- >>${year}<<>>${month}<<>>${day}<<`);
        // Construct as midnight UTC on that date.
        const fullEpoch = new Date(Date.UTC(year, month, day, 0, 0, 0));
        Log.writeLine(LogLevels.TestDebug, `... which is:- >>${fullEpoch}<<`);

        returnDate = fullEpoch.getTime();
      } else {
        // Neither a recognised verb nor a fixed-date literal — genuinely invalid.
        throw new Error(dateTokenPrep.errInvalidDateVerb);
      }
  }
  return returnDate;
}

function getFollowingDay(currentDateEpoch: number, requiredDayOfTheWeek: string, errorString: string): Date {
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

function getParsedDateOffset(numString: string | undefined, errorMessage: string): number {
  // No params string supplied at all (e.g. a verb like "addDays" with no parens/number).
  if (Utils.isNullOrUndefined(numString)) {
    throw new Error(`${errorMessage} Got [No Params!]`);
  } else {
    // Trim whitespace, then require it to parse as a whole number.
    const offsetValue = parseInt(numString?.trim() as string);
    if (isNaN(offsetValue)) throw new Error(`${errorMessage} Got [${numString?.trim() as string}]`);
    return offsetValue;
  }
}

/**
 * Picks a random epoch within an inclusive `"fromEpoch,toEpoch"` range. Shared by `date`'s
 * own `random(...)` verb and `random`'s `date(...)` sub-mode (randomBuiltins.ts) — exported
 * for that sibling file to import, not part of this package's public API.
 */
export function doRandomDate(maxAndMinDates: string): number {
  // Expect exactly two comma-separated epoch numbers: "fromEpoch,toEpoch".
  const maxAndMin: string[] = maxAndMinDates.split(",");

  if (maxAndMin.length != 2 || Number.isNaN(+maxAndMin[0]) || Number.isNaN(+maxAndMin[1]))
    throw new Error(`Invalid Maximum and Minimum dates. Expect {random;date(fromEpoch,toEpoch);<format>}. Max/min was: [${maxAndMinDates}]`);
  const minDate = Number(maxAndMin[0]);
  const maxDate = Number(maxAndMin[1]);
  if (minDate > maxDate) throw new Error(`Minimum date greater than maximum!! Max/min was: [${maxAndMinDates}]`);
  // Pick a random whole number of days within the inclusive range and add that many days
  // (in milliseconds) onto minDate.
  return minDate + Math.abs(Utils.getRandomInt(0, numberOfDays(minDate, maxDate) - 1)) * 1000 * 60 * 60 * 24;
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
function assertValidIANAZone(zone: string, context: string): void {
  try {
    // Constructing this throws synchronously on an unrecognised zone — the formatter
    // instance itself is discarded, this call's only job is the validation side effect.
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
  } catch {
    throw new Error(`${context}: [${zone}] is not a recognised IANA timezone name (e.g. "Europe/London", "Africa/Lusaka", "UTC").`);
  }
}

function doTimezoneToken(tokenBody: string): string {

  ////////////////////////////////////////////////////
  //
  // Resolves a `[[timezone|<IANAZoneName>]]` token: just validates the given zone name and
  // returns it unchanged — the "standard form" other tokens (date's zone part, diff) expect
  // is simply the validated IANA zone string itself, so this doubles as both a validator and
  // a pass-through, nestable directly inside those other tokens' own argument lists.

  const zone = tokenBody.trim();
  assertValidIANAZone(zone, "Timezone token");
  return zone;
}

function doDiffToken(tokenBody: string, delimiter: string): string {

  ////////////////////////////////////////////////////
  //
  // Resolves a `[[diff|<zoneA>|<zoneB>]]` token: validates both zone names, looks up each
  // one's current UTC offset (DST-aware, since it's resolved "now" rather than from a fixed
  // per-zone constant), and returns zoneA's offset minus zoneB's, in hours, as a plain
  // decimal number string. "UTC" is itself a valid zone, so a single zone's offset from UTC
  // is just this same token with "UTC" as the other side.

  // Quote-aware: zoneA (the only one of the two that isn't the final, absorbed field) can
  // be wrapped in '...'/"..." — no real IANA zone name needs this, but it costs nothing and
  // keeps every built-in's top-level split working the same way.
  const [zoneA, zoneB] = StringUtils.splitRemainingQuoted(tokenBody, delimiter, 2);
  // Both zones are mandatory — there's no meaningful "diff" with only one side given.
  if (!zoneA || !zoneB) throw new Error(`Diff token needs 2 IANA zone names (IE. {{diff;<zoneA>;<zoneB>}}). Got [${tokenBody}]`);
  assertValidIANAZone(zoneA, "Diff token's first zone");
  assertValidIANAZone(zoneB, "Diff token's second zone");

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

function numberOfDays(minDate: number, maxDate: number): number {
  Log.writeLine(LogLevels.TestDebug, `Min date [${minDate}], Max date[${maxDate}]`);
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  // Inclusive day count between the two epochs (order-independent, via Math.abs) — +1 so
  // the range includes both endpoints as valid days, not just the days strictly between.
  const numberOfDays = Math.floor(Math.abs((minDate - maxDate) / MS_PER_DAY)) + 1;
  Log.writeLine(LogLevels.TestDebug, `Min date [${minDate}], Max date[${maxDate}].  Number of days [${numberOfDays}]`);
  return numberOfDays;
}
