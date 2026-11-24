import { addDays, addMonths, addYears, format } from "date-fns";

import { Log, LogLevels, StringUtils } from "../index.js";
import { Detokeniser } from "./detokeniser.js";

describe("Detokeniser", () => {
  afterEach(() => {
    Detokeniser.reset();
  });

  // ─── enabled toggle ───────────────────────────────────────────────────────────

  describe("enabled toggle", () => {
    it("is true by default", () => {
      expect(Detokeniser.enabled).toBe(true);
    });

    it("passes a string straight through, untouched, when disabled — even one with real tokens in it", async () => {
      Detokeniser.enabled = false;
      await expect(Detokeniser.doAsync("Ref-[[random|digits|6]]")).resolves.toStrictEqual("Ref-[[random|digits|6]]");
    });

    it("does not even validate its input type when disabled — true pass-through, not just skipped processing", async () => {
      Detokeniser.enabled = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(Detokeniser.doAsync(42 as any)).resolves.toBe(42);
    });

    it("reset() restores enabled to true", () => {
      Detokeniser.enabled = false;
      Detokeniser.reset();
      expect(Detokeniser.enabled).toBe(true);
    });
  });

  // ─── delimiter ────────────────────────────────────────────────────────────────

  describe("delimiter", () => {
    it("is '|' by default", () => {
      expect(Detokeniser.delimiter).toBe("|");
    });

    it("accepts every character on the allow-list", async () => {
      for (const char of [" ", "|", ";", ":", "~", "^", "!", "?", "&"]) {
        Detokeniser.delimiter = char;
        expect(Detokeniser.delimiter).toBe(char);
      }
    });

    it("rejects a character outside the allow-list, with a clear error naming the allowed set", () => {
      expect(() => (Detokeniser.delimiter = ",")).toThrow(/not an allowed delimiter character/);
      expect(() => (Detokeniser.delimiter = ",")).toThrow(/<space>, \|, ;, :, ~, \^, !, \?, &/);
    });

    it("rejects every character that is already structurally significant elsewhere in the grammar", () => {
      for (const char of ["[", "]", "(", ")", "/", ",", "'", '"']) {
        expect(() => (Detokeniser.delimiter = char)).toThrow(/not an allowed delimiter character/);
      }
    });

    it("rejects a letter or digit, even though neither breaks the grammar", () => {
      expect(() => (Detokeniser.delimiter = "b")).toThrow(/not an allowed delimiter character/);
      expect(() => (Detokeniser.delimiter = "5")).toThrow(/not an allowed delimiter character/);
    });

    it("rejects a multi-character string, even if every character in it is individually allowed", () => {
      expect(() => (Detokeniser.delimiter = ";;")).toThrow(/not an allowed delimiter character/);
    });

    it("rejects a non-string value", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (Detokeniser.delimiter = 42 as any)).toThrow();
    });

    it("leaves the previous, still-valid delimiter in place after a rejected assignment", () => {
      Detokeniser.delimiter = ";";
      expect(() => (Detokeniser.delimiter = "(")).toThrow();
      expect(Detokeniser.delimiter).toBe(";");
    });

    it("reset() restores delimiter to '|'", () => {
      Detokeniser.delimiter = ";";
      Detokeniser.reset();
      expect(Detokeniser.delimiter).toBe("|");
    });

    it("a built-in verb splits its own args on the current delimiter, not a hardcoded '|'", async () => {
      Detokeniser.delimiter = ";";
      await expect(Detokeniser.doAsync("[[random;digits;4]]")).resolves.toMatch(/^\d{4}$/);
      await expect(Detokeniser.doAsync("[[date;today;yyyy]]")).resolves.toBe(format(new Date(), "yyyy"));
      await expect(Detokeniser.doAsync("[[base64;encode;Hello World]]")).resolves.toBe("SGVsbG8gV29ybGQ=");
      await expect(Detokeniser.doAsync("[[diff;UTC;UTC]]")).resolves.toBe("0");
    });

    it("the previous delimiter ('|') is no longer treated specially once changed — it's just a literal character to a built-in that now splits on ';'", async () => {
      Detokeniser.delimiter = ";";
      // base64-encoding a value that itself contains a literal '|' — no quoting needed now,
      // since '|' is no longer the separator.
      await expect(Detokeniser.doAsync("[[base64;encode;a|b]]")).resolves.toBe(Buffer.from("a|b").toString("base64"));
    });

    it("a token-shaped qualifier form (verb(qualifier)|args) still parses correctly against a non-default delimiter", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mytype", ({ qualifier }) => (qualifier === "special" ? "SPECIAL" : undefined));
      await expect(Detokeniser.doAsync("[[mytype(special);today;yyyy]]")).resolves.toBe("SPECIAL");
    });

    it("a user-registered callback's context carries the current delimiter, not a stale default", async () => {
      Detokeniser.delimiter = "~";
      let captured: string | undefined;
      Detokeniser.addCallback("echo", ({ delimiter }) => {
        captured = delimiter;
        return "ok";
      });
      await Detokeniser.doAsync("[[echo~a]]");
      expect(captured).toBe("~");
    });

    it("space is a valid, if unusual, delimiter choice", async () => {
      Detokeniser.delimiter = " ";
      await expect(Detokeniser.doAsync("[[random digits 4]]")).resolves.toMatch(/^\d{4}$/);
    });
  });

  // ─── Debug logging ────────────────────────────────────────────────────────────

  describe("debug logging", () => {
    beforeEach(() => {
      Log.loggingLevel = LogLevels.TestDebug;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("logs one 'Processed [token] to [result]' line for a single resolved token", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      const result = await Detokeniser.doAsync("Ref-[[random|digits|4]]");

      const call = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [[[random|digits|4]]]")
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBe(`Processed [[[random|digits|4]]] to [${result.replace("Ref-", "")}]`);
    });

    it("logs one line per token, innermost first, for a nested token", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync("[[date|addDays([[random|digits|1]])|dd-MM-yyyy]]");

      const processedCalls = writeLineSpy.mock.calls.filter(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [")
      );
      expect(processedCalls.length).toBe(2);
      // The inner [[random|...]] token resolves (and is logged) before the outer [[date|...]]
      // token, which can only resolve once the inner one's result has been spliced in.
      expect(processedCalls[0][1]).toContain("[[random|digits|1]]");
      expect(processedCalls[1][1]).toContain("[[date|addDays(");
    });

    it("truncates the raw token and the result independently, at 64 characters each", async () => {
      Detokeniser.addCallback("echo", ({ args }) => args);
      const longArg = "y".repeat(100);
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync(`[[echo|${longArg}]]`);

      const call = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [")
      );
      expect(call).toBeDefined();
      const rawToken = `[[echo|${longArg}]]`;
      expect(call?.[1]).toBe(
        `Processed [${StringUtils.truncateIfNeeded(rawToken, 64)}] to [${StringUtils.truncateIfNeeded(longArg, 64)}]`
      );
    });

    it("logs nothing per-token on failure — only the existing error-level log applies", async () => {
      // "random" IS a recognised verb — this fails inside its own dispatch (an unrecognised
      // sub-verb), not via UnsupportedTokenError, so it still genuinely throws rather than
      // falling back to literal text (see the "unsupported verb" tests below for that case).
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await expect(Detokeniser.doAsync("[[random|bogus_mode|5]]")).rejects.toThrow();

      const processedCall = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [")
      );
      expect(processedCall).toBeUndefined();
      const errorCall = writeLineSpy.mock.calls.find(([level]) => level === LogLevels.Error);
      expect(errorCall).toBeDefined();
    });

    it("logs a single truncated 'no tokens found' line when the string contains no [[ at all", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync("plain text, nothing to resolve here");

      const call = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [")
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Processed [plain text, nothing to resolve here], no tokens found");
    });

    it("truncates the 'no tokens found' line's raw string at 48 characters", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      const longPlainText = "x".repeat(200);
      await Detokeniser.doAsync(longPlainText);

      const call = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [")
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBe(`Processed [${StringUtils.truncateIfNeeded(longPlainText, 48)}], no tokens found`);
    });

    it("never logs 'no tokens found' for a string that does contain a token", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync("Ref-[[random|digits|4]]");

      const noTokenCall = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).endsWith("no tokens found")
      );
      expect(noTokenCall).toBeUndefined();
    });

    it("logs nothing when disabled", async () => {
      Detokeniser.enabled = false;
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync("Ref-[[random|digits|4]]");
      expect(writeLineSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Basic string manipulation ───────────────────────────────────────────────

  describe("Basic string manipulation with no tokens", () => {
    it("no token in string", async () => {
      await expect(Detokeniser.doAsync("No token here")).resolves.toStrictEqual("No token here");
    });

    it("empty string", async () => {
      await expect(Detokeniser.doAsync("")).resolves.toStrictEqual("");
    });

    it("no token but with an opener", async () => {
      await expect(Detokeniser.doAsync("No token [[here")).resolves.toStrictEqual("No token [[here");
    });

    it("no token but with a closer", async () => {
      await expect(Detokeniser.doAsync("No token ]]here")).resolves.toStrictEqual("No token ]]here");
    });

    it("string with unknown verb falls back to literal text, not an error, and logs a Warning", async () => {
      // Deliberate trade-off (see UnsupportedTokenError's own doc comment): an unrecognised
      // verb is indistinguishable, from here, between a genuine typo and incidental [[/]]
      // adjacency in unrelated literal data (e.g. a JSON nested array) — resolved in favour
      // of treating it as literal text, logged at Warning rather than silently.
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await expect(Detokeniser.doAsync("[[unknown]]")).resolves.toStrictEqual("[[unknown]]");
      const warningCall = writeLineSpy.mock.calls.find(([level]) => level === LogLevels.Warning);
      expect(warningCall).toBeDefined();
      expect(warningCall?.[1]).toContain("[[unknown]]");
    });

    it("a JSON nested array — incidental [[/]] adjacency with no verb involved at all — passes through unchanged", async () => {
      const body = `{"data":[[1,2],[3,4]]}`;
      await expect(Detokeniser.doAsync(body)).resolves.toStrictEqual(body);
    });

    it("a JSON nested array alongside a genuine, unrelated token — both resolve correctly in the same string", async () => {
      await expect(Detokeniser.doAsync('{"id":"[[random|digits|4]]","data":[[1,2],[3,4]]}')).resolves.toMatch(
        /^\{"id":"\d{4}","data":\[\[1,2\],\[3,4\]\]\}$/
      );
    });

    it("string with escaped token opener and closer", async () => {
      await expect(Detokeniser.doAsync("No /[[token/]] here")).resolves.toStrictEqual("No [[token]] here");
    });

    it("string with escaped escape then escaped token opener and closer", async () => {
      await expect(Detokeniser.doAsync("No ///[[token/]] here")).resolves.toStrictEqual("No /[[token]] here");
    });

    // De-escaping is positional (only immediately before [[/]]), not a global find-and-replace
    // — a run of escape chars nowhere near a token boundary must never be touched.
    it("a double escape char far from any token boundary is left completely untouched", async () => {
      await expect(Detokeniser.doAsync("https://example.com")).resolves.toStrictEqual("https://example.com");
    });

    it("a double escape char immediately before an unresolved token boundary still collapses to one literal escape char", async () => {
      // No closing ']]' at all here — the whole string stays one literal block (no token
      // is ever actually matched), which is what lets this exercise doDeEscapesIfRequired's
      // even-length-run case directly rather than token resolution.
      await expect(Detokeniser.doAsync("No //[[token here")).resolves.toStrictEqual("No /[[token here");
    });

    it("unrelated double-slashes well away from a resolved token are all left untouched", async () => {
      await expect(Detokeniser.doAsync("https://a.com and [[random|digits|1]] and https://b.com")).resolves.toMatch(
        /^https:\/\/a\.com and \d and https:\/\/b\.com$/
      );
    });

    it("non-token text preserved around a resolved token", async () => {
      await expect(Detokeniser.doAsync("PREFIX-[[random|digits|4]]-SUFFIX")).resolves.toMatch(/^PREFIX-\d{4}-SUFFIX$/);
    });
  });

  // ─── Random token ────────────────────────────────────────────────────────────

  describe("Random token", () => {
    it("float - 1 decimal place, no rounding", async () => {
      await expect(Detokeniser.doAsync("[[random|float(100.4999,100.4999)|1]]")).resolves.toMatch(/^100\.4$/);
      await expect(Detokeniser.doAsync("[[random|float(100.5,100.5)|2]]")).resolves.toMatch(/^100\.50$/);
    });

    it("float - 2 decimal places", async () => {
      await expect(Detokeniser.doAsync("[[random|float(100.3,100.4999)|2]]")).resolves.toMatch(/^100\.[34]\d$/);
    });

    it("from - single char from numeric set", async () => {
      await expect(Detokeniser.doAsync("[[random|from(1234567890)|1]]")).resolves.toMatch(/^\d$/);
    });

    it("from - 5 chars from alpha set", async () => {
      await expect(Detokeniser.doAsync("[[random|from(abcd)|5]]")).resolves.toMatch(/^[abcd]{5}$/);
    });

    it("from - with escaped token opener inside paren content", async () => {
      // /[[ inside from() is a literal [[ — result chars should include [
      await expect(Detokeniser.doAsync("[[random|from(ab/[[)|3]]")).resolves.toMatch(/^[ab[]{3}$/);
    });

    it("from - quoted string list, single quotes, picks one whole item", async () => {
      await expect(Detokeniser.doAsync("[[random|from('cat','dog')|3]]")).resolves.toMatch(/^(cat|dog)$/);
    });

    it("from - quoted string list, mixed single and double quotes per item", async () => {
      await expect(Detokeniser.doAsync("[[random|from('cat',\"dog\")|3]]")).resolves.toMatch(/^(cat|dog)$/);
    });

    it("from - quoted string list, incidental whitespace tolerated around comma and before first item", async () => {
      await expect(Detokeniser.doAsync("[[random|from( 'cat' , 'dog' )|3]]")).resolves.toMatch(/^(cat|dog)$/);
    });

    it("from - quoted string list, escaped same-type quote inside an item", async () => {
      // Cap set to exactly the item's own length (6) — any larger would leave budget for the
      // fill loop to continue, truncating a second copy of this single-item pool onto the end.
      await expect(Detokeniser.doAsync("[[random|from('he/'llo')|6]]")).resolves.toBe("he'llo");
    });

    it("from - quoted string list, opposite quote type inside an item needs no escaping", async () => {
      await expect(Detokeniser.doAsync('[[random|from("he\'llo")|6]]')).resolves.toBe("he'llo");
    });

    it("from - quoted string list, literal ')' inside an item doesn't end the call early", async () => {
      await expect(Detokeniser.doAsync("[[random|from('he)llo')|6]]")).resolves.toBe("he)llo");
    });

    it("from - quoted string list, <length> is a maximum total, filled exactly by truncating an overshooting draw", async () => {
      // Drawing '1234567' (7 chars) first truncates to its first 5 characters ("12345"),
      // same as drawing '12345' whole. Drawing '123' first (3 chars) leaves a remaining
      // budget of 2 — every item in this pool starts with "12", so whatever's drawn next
      // contributes "12" regardless, giving "12312". Either way, the 5-character cap is
      // always used up fully, never left short and never "" (see buildFromStringListResult's
      // own doc comment for why a too-long draw is truncated rather than discarded).
      await expect(Detokeniser.doAsync("[[random|from('1234567','123','12345')|5]]")).resolves.toMatch(/^(12345|12312)$/);
    });

    it("from - quoted string list, cap shorter than every item truncates instead of resolving to empty", async () => {
      await expect(Detokeniser.doAsync("[[random|from('true','false')|3]]")).resolves.toMatch(/^(tru|fal)$/);
    });

    it("from - quoted string list, an empty item stops the fill loop rather than looping forever", async () => {
      // Drawing '' first (or second, after 'bye') stops the loop immediately, since an empty
      // item can never reduce the remaining budget — 'bye' can also be truncated to fill the
      // rest of the cap if drawn a second time.
      await expect(Detokeniser.doAsync("[[random|from('','bye')|5]]")).resolves.toMatch(/^(|bye|byeby)$/);
    });

    it("from - trailing content after a validly-closed call throws, naming the real cause instead of 'invalid length'", async () => {
      // 'he')llo') — the FIRST unescaped ' after 'he closes a complete, valid one-item list,
      // from('he'), with its own matching ')' right after. "llo')|5" trails that close paren
      // without the delimiter immediately following it, so this is never a length/format
      // argument — the author most likely forgot to escape an embedded quote inside the item
      // they meant to write, but whatever the cause, this throws naming it as trailing
      // content, not as an invalid length (which would misdescribe the actual problem).
      await expect(Detokeniser.doAsync("[[random|from('he')llo')|5]]")).rejects.toThrow(
        /Trailing content after a from\(\.\.\.\)\/float\(\.\.\.\)\/date\(\.\.\.\) call.*found: \[llo'\)\|5\]/
      );
    });

    it("from - character-pool mode still requires an explicit length, unchanged", async () => {
      await expect(Detokeniser.doAsync("[[random|from(abcd)]]")).rejects.toThrow(/Invalid length part/);
    });

    it("from - quoted string list, omitted length picks exactly one whole item, uncapped", async () => {
      await expect(Detokeniser.doAsync("[[random|from('cat','dog')]]")).resolves.toMatch(/^(cat|dog)$/);
    });

    it("from - quoted string list, omitted length is never truncated even for a long item", async () => {
      await expect(Detokeniser.doAsync("[[random|from('1234567')]]")).resolves.toBe("1234567");
    });

    it("named set (not from(...)) still requires an explicit length, unchanged", async () => {
      await expect(Detokeniser.doAsync("[[random|digits]]")).rejects.toThrow(/Invalid length part/);
    });

    it("digits - 1 character", async () => {
      await expect(Detokeniser.doAsync("[[random|digits|1]]")).resolves.toMatch(/^[0-9]$/);
    });

    it("digits - 4 characters", async () => {
      await expect(Detokeniser.doAsync("[[random|digits|4]]")).resolves.toMatch(/^[0-9]{4}$/);
    });

    it("letters - 1 character", async () => {
      await expect(Detokeniser.doAsync("[[random|letters|1]]")).resolves.toMatch(/^[a-zA-Z]$/);
    });

    it("letters - 5 characters", async () => {
      await expect(Detokeniser.doAsync("[[random|letters|5]]")).resolves.toMatch(/^[a-zA-Z]{5}$/);
    });

    it("lowercaseletters - 6 characters", async () => {
      await expect(Detokeniser.doAsync("[[random|lowercaseletters|6]]")).resolves.toMatch(/^[a-z]{6}$/);
    });

    it("uppercaseletters - 10 characters", async () => {
      await expect(Detokeniser.doAsync("[[random|uppercaseletters|10]]")).resolves.toMatch(/^[A-Z]{10}$/);
    });

    it("alphanumerics - 10 characters", async () => {
      await expect(Detokeniser.doAsync("[[random|alphanumerics|10]]")).resolves.toMatch(/^[0-9a-zA-Z]{10}$/);
    });

    it("date - fixed range, formatted", async () => {
      // 21600000–21660000 ms epoch is entirely within 1970-01-01
      await expect(Detokeniser.doAsync("[[random|date(21600000,21660000)|dd-MM-yyyy]]")).resolves.toMatch(/^01-01-1970$/);
    });

    it("date - range returned as epoch within bounds", async () => {
      const result = parseInt(await Detokeniser.doAsync("[[random|date(21600000,108000000)|epoch]]"));
      expect(result).toBeGreaterThanOrEqual(21600000);
      expect(result).toBeLessThanOrEqual(108000000);
    });
  });

  // ─── Date token ───────────────────────────────────────────────────────────────

  describe("Date token", () => {
    it("fixed date as epoch", async () => {
      await expect(Detokeniser.doAsync("[[date|2013-4-5|epoch]]")).resolves.toBe("1365120000000");
    });

    it("fixed date as second-epoch", async () => {
      await expect(Detokeniser.doAsync("[[date|2013-4-5|second-epoch]]")).resolves.toBe("1365120000");
    });

    it("fixed date formatted", async () => {
      await expect(Detokeniser.doAsync("[[date|2013-4-5|MM=dd=yyyy]]")).resolves.toBe("04=05=2013");
    });

    it("today returns today", async () => {
      const result = await Detokeniser.doAsync("[[date|today|yyyy-MM-dd]]");
      expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("now returns today", async () => {
      const result = await Detokeniser.doAsync("[[date|now|yyyy-MM-dd]]");
      expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("yesterday", async () => {
      const result = await Detokeniser.doAsync("[[date|yesterday|yyyy-MM-dd]]");
      expect(result).toBe(format(addDays(new Date(), -1), "yyyy-MM-dd"));
    });

    it("tomorrow", async () => {
      const result = await Detokeniser.doAsync("[[date|tomorrow|yyyy-MM-dd]]");
      expect(result).toBe(format(addDays(new Date(), 1), "yyyy-MM-dd"));
    });

    it("addYears", async () => {
      const result = await Detokeniser.doAsync("[[date|AddYears(3)|EEE MMM dd yyyy]]");
      expect(result).toBe(format(addYears(new Date(), 3), "EEE MMM dd yyyy"));
    });

    it("addMonths", async () => {
      const result = await Detokeniser.doAsync("[[date|AddMonths(3)|EEE MMM dd yyyy]]");
      expect(result).toBe(format(addMonths(new Date(), 3), "EEE MMM dd yyyy"));
    });

    it("addDays", async () => {
      const result = await Detokeniser.doAsync("[[date|AddDays(3)|EEE MMM dd yyyy]]");
      expect(result).toBe(format(addDays(new Date(), 3), "EEE MMM dd yyyy"));
    });

    it("addHours", async () => {
      // 0 hours → same date
      const result = await Detokeniser.doAsync("[[date|AddHours(0)|yyyy-MM-dd]]");
      expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("addMinutes", async () => {
      // 0 minutes → same date
      const result = await Detokeniser.doAsync("[[date|AddMinutes(0)|yyyy-MM-dd]]");
      expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("random date within a fixed epoch range", async () => {
      // 946684800000 = 2000-01-01 UTC, 946771200000 = 2000-01-02 UTC
      const result = await Detokeniser.doAsync("[[date|random(946684800000,946771200000)|yyyy-MM-dd]]");
      expect(result).toMatch(/^2000-01-0[12]$/);
    });

    it("followingDay - following Friday after Sunday 2013-04-07 is 2013-04-12", async () => {
      // 1365292800000 = 2013-04-07 00:00:00 UTC
      await expect(Detokeniser.doAsync("[[date|followingDay(1365292800000,friday)|yyyy-MM-dd]]")).resolves.toBe("2013-04-12");
    });

    it("zone-aware: epoch format is unaffected by the zone (epoch has no timezone)", async () => {
      const result = await Detokeniser.doAsync("[[date|2013-4-5|epoch|UTC]]");
      expect(result).toBe("1365120000000");
    });

    it("zone-aware: fixed date formatted in a given IANA zone", async () => {
      // 2013-04-05 00:00:00 UTC is already 2013-04-05 13:00 in Pacific/Auckland (UTC+13 in April).
      const result = await Detokeniser.doAsync("[[date|2013-4-5|yyyy-MM-dd HH:mm|Pacific/Auckland]]");
      expect(result).toBe("2013-04-05 13:00");
    });

    it("zone-aware: invalid zone name throws a clear error", async () => {
      await expect(Detokeniser.doAsync("[[date|today|yyyy-MM-dd|Not/AZone]]")).rejects.toThrow(/not a recognised IANA timezone/);
    });

    it("invalid date verb throws", async () => {
      await expect(Detokeniser.doAsync("[[date|addWorkingDays(5)|dd-MM-yyyy]]")).rejects.toThrow("Invalid date verb");
    });

    it("nested tokens resolve innermost first", async () => {
      const result = await Detokeniser.doAsync(
        "[[date|random([[date|2000-01-01|epoch]],[[date|2000-01-02|epoch]])|yyyy-MM-dd]]"
      );
      expect(result).toMatch(/^2000-01-0[12]$/);
    });

    it("random digit nested inside date addDays", async () => {
      const result = await Detokeniser.doAsync("[[date|addDays([[random|digits|1]])|yyyy-MM-dd]]");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("date-fns literal-text quoting in the format argument is unaffected — the leading ' is date-fns' own escape syntax, not this redesign's quote-aware splitting, which this verb deliberately excludes", async () => {
      const result = await Detokeniser.doAsync("[[date|today|'T'HH:mm]]");
      expect(result).toBe(format(new Date(), "'T'HH:mm"));
    });
  });

  // ─── timezone token ───────────────────────────────────────────────────────────

  describe("timezone token", () => {
    it("valid IANA zone is returned unchanged", async () => {
      await expect(Detokeniser.doAsync("[[timezone|Europe/London]]")).resolves.toBe("Europe/London");
    });

    it("invalid zone name throws a clear error", async () => {
      await expect(Detokeniser.doAsync("[[timezone|Nowhere/Fake]]")).rejects.toThrow(/not a recognised IANA timezone/);
    });
  });

  // ─── diff token ───────────────────────────────────────────────────────────────

  describe("diff token", () => {
    it("a zone diffed against itself is zero", async () => {
      await expect(Detokeniser.doAsync("[[diff|Europe/London|Europe/London]]")).resolves.toBe("0");
    });

    it("UTC offset of a fixed-offset zone", async () => {
      // Pacific/Kiritimati is a fixed UTC+14 zone (no DST), so this is stable year-round.
      await expect(Detokeniser.doAsync("[[diff|Pacific/Kiritimati|UTC]]")).resolves.toBe("14");
    });

    it("quarter-hour-offset zone produces a decimal result", async () => {
      // Asia/Kathmandu is a fixed UTC+5:45 zone (no DST).
      await expect(Detokeniser.doAsync("[[diff|Asia/Kathmandu|UTC]]")).resolves.toBe("5.75");
    });

    it("argument order is significant (sign flips)", async () => {
      await expect(Detokeniser.doAsync("[[diff|UTC|Pacific/Kiritimati]]")).resolves.toBe("-14");
    });

    it("nested inside timezone tokens", async () => {
      await expect(Detokeniser.doAsync("[[diff|[[timezone|Pacific/Kiritimati]]|[[timezone|UTC]]]]")).resolves.toBe("14");
    });

    it("missing second zone throws", async () => {
      await expect(Detokeniser.doAsync("[[diff|UTC]]")).rejects.toThrow(/needs 2 IANA zone names/);
    });

    it("invalid zone name throws a clear error", async () => {
      await expect(Detokeniser.doAsync("[[diff|UTC|Nowhere/Fake]]")).rejects.toThrow(/not a recognised IANA timezone/);
    });

    it("the first zone can be quoted — no real zone name needs this, but proves the quote-aware wiring", async () => {
      await expect(Detokeniser.doAsync("[[diff|'Pacific/Kiritimati'|UTC]]")).resolves.toBe("14");
    });
  });

  // ─── BASE64 token ────────────────────────────────────────────────────────────

  describe("BASE64 token", () => {
    it("encode", async () => {
      const value = "Hello World";
      const encoded = await Detokeniser.doAsync(`[[base64|encode|${value}]]`);
      expect(Buffer.from(encoded, "base64").toString()).toBe(value);
    });

    it("encode value containing pipe character", async () => {
      // pipe is the 3rd segment so splitRemaining handles it correctly
      const value = "Hello|World";
      const encoded = await Detokeniser.doAsync(`[[base64|encode|${value}]]`);
      expect(Buffer.from(encoded, "base64").toString()).toBe(value);
    });

    it("decode", async () => {
      const value = "Hello World";
      const encoded = Buffer.from(value).toString("base64");
      await expect(Detokeniser.doAsync(`[[base64|decode|${encoded}]]`)).resolves.toBe(value);
    });

    it("decode value containing pipe character in original", async () => {
      const value = "Hello|World";
      const encoded = Buffer.from(value).toString("base64");
      await expect(Detokeniser.doAsync(`[[base64|decode|${encoded}]]`)).resolves.toBe(value);
    });

    it("encode/decode roundtrip via nested tokens", async () => {
      const value = "roundtrip test 123";
      const encoded = await Detokeniser.doAsync(`[[base64|encode|${value}]]`);
      const decoded = await Detokeniser.doAsync(`[[base64|decode|${encoded}]]`);
      expect(decoded).toBe(value);
    });

    it("invalid direction throws", async () => {
      await expect(Detokeniser.doAsync("[[base64|baddir|something]]")).rejects.toThrow();
    });
  });

  // ─── JWT token ───────────────────────────────────────────────────────────────

  describe("JWT token", () => {
    it("full JWT with payload, signature and options", async () => {
      const result = await Detokeniser.doAsync('[[jwt|{"sub":"1234","name":"Test"}|MySecret|{"algorithm":"HS256"}]]');
      expect(result).toBeDefined();
      expect(result.split(".").length).toBe(3);
    });

    it("JWT with payload and signature, no options", async () => {
      const result = await Detokeniser.doAsync('[[jwt|{"sub":"1234"}|MySecret]]');
      expect(result).toBeDefined();
      expect(result.split(".").length).toBe(3);
    });

    it("JWT with payload only, no signature or options", async () => {
      const result = await Detokeniser.doAsync('[[jwt|{"sub":"1234","name":"Test"}]]');
      expect(result).toBeDefined();
      expect(result.split(".").length).toBe(3);
    });

    it("a quoted payload can carry a literal pipe character the JSON value itself needs", async () => {
      const result = await Detokeniser.doAsync(`[[jwt|'{"sub":"a|b"}'|MySecret]]`);
      const decodedPayload = JSON.parse(Buffer.from(result.split(".")[1], "base64url").toString());
      expect(decodedPayload.sub).toBe("a|b");
    });
  });

  // ─── Setting token ───────────────────────────────────────────────────────────

  describe("Setting token", () => {
    it("invalid postamble (not key:value JSON) throws", async () => {
      await expect(Detokeniser.doAsync("[[setting|invalid]]")).rejects.toThrow();
    });

    it("reads from process env", async () => {
      const envName = "DETOKENISER_SPEC_TEST_VAR";
      const envValue = "hello from env";
      process.env[envName] = envValue;
      try {
        await expect(Detokeniser.doAsync(`[[setting|processEnvName: "${envName}"]]`)).resolves.toBe(envValue);
      } finally {
        delete process.env[envName];
      }
    });

    it("reads from contextParameters", async () => {
      const result = await Detokeniser.doAsync('[[setting|profileParameterName: "myParam"]]', {
        contextParameters: { myParam: "contextValue" },
      });
      expect(result).toBe("contextValue");
    });

    it("uses defaultValue when env var not set", async () => {
      const result = await Detokeniser.doAsync(
        '[[setting|processEnvName: "DETOKENISER_SPEC_DEFINITELY_NOT_SET_XYZ", defaultValue: "fallback"]]'
      );
      expect(result).toBe("fallback");
    });
  });

  // ─── mockintercepts token ────────────────────────────────────────────────────

  describe("mockintercepts token", () => {
    it("throws when no intercepted requests are available", async () => {
      await expect(Detokeniser.doAsync("[[mockintercepts|$.requests[0].body.id]]")).rejects.toThrow(
        "No Mock Intercepted requests to harvest from!?"
      );
    });
  });

  // ─── Callbacks ───────────────────────────────────────────────────────────────

  describe("Callbacks", () => {
    afterEach(() => {
      Detokeniser.resetCallbacks();
    });

    it("sync callback receives parsed args and its return value is used", async () => {
      let capturedArgs: string | undefined;
      Detokeniser.addCallback("mytoken", ({ args }) => {
        capturedArgs = args;
        return "syncResult";
      });
      const result = await Detokeniser.doAsync("[[mytoken|arg1|arg2]]");
      expect(capturedArgs).toBe("arg1|arg2");
      expect(result).toBe("syncResult");
    });

    it("verb matching is case-insensitive and trimmed", async () => {
      Detokeniser.addCallback("MyToken", () => "ok");
      await expect(Detokeniser.doAsync("[[ mytoken ]]")).resolves.toBe("ok");
    });

    it("context carries verb, rawVerb, qualifier and args", async () => {
      let captured: Detokeniser.CallbackContext | undefined;
      Detokeniser.addCallback("mytype", (context) => {
        captured = context;
        return "ok";
      });
      await Detokeniser.doAsync("[[mytype(q)|arg1|arg2]]");
      expect(captured).toEqual({
        verb: "mytype",
        rawVerb: "mytype(q)",
        qualifier: "q",
        args: "arg1|arg2",
        delimiter: "|",
        options: {},
      });
    });

    it("a callback declining (returning undefined) for its own verb falls back to literal text — no other handler is registered for it", async () => {
      Detokeniser.addCallback("anything", () => undefined);
      await expect(Detokeniser.doAsync("[[anything]]")).resolves.toStrictEqual("[[anything]]");
    });

    it("async callback receives parsed args and its return value is used", async () => {
      let capturedArgs: string | undefined;
      Detokeniser.addCallback("asynctoken", async ({ args }) => {
        capturedArgs = args;
        return "asyncResult";
      });
      const result = await Detokeniser.doAsync("[[asynctoken|arg1|arg2]]");
      expect(capturedArgs).toBe("arg1|arg2");
      expect(result).toBe("asyncResult");
    });

    it("resetCallbacks clears all callbacks", async () => {
      Detokeniser.addCallback("anything", () => "sync");
      Detokeniser.resetCallbacks();
      await expect(Detokeniser.doAsync("[[anything]]")).resolves.toStrictEqual("[[anything]]");
    });

    it("reset clears all callbacks", async () => {
      Detokeniser.addCallback("anything", () => "sync");
      Detokeniser.reset();
      await expect(Detokeniser.doAsync("[[anything]]")).resolves.toStrictEqual("[[anything]]");
    });

    it("a callback registered for a built-in verb name overrides the built-in", async () => {
      Detokeniser.addCallback("date", () => "OVERRIDDEN");
      await expect(Detokeniser.doAsync("[[date|today|yyyy]]")).resolves.toBe("OVERRIDDEN");
    });

    it("among several callbacks registered for the same verb, the most recently registered one wins", async () => {
      Detokeniser.addCallback("date", () => "FIRST");
      Detokeniser.addCallback("date", () => "SECOND");
      await expect(Detokeniser.doAsync("[[date|today|yyyy]]")).resolves.toBe("SECOND");
    });

    it("a callback can decline (return undefined) and fall through to another callback for the same verb, then to the built-in", async () => {
      Detokeniser.addCallback("date", ({ qualifier }) => (qualifier === "special" ? "SPECIAL" : undefined));
      await expect(Detokeniser.doAsync("[[date(special)|today|yyyy]]")).resolves.toBe("SPECIAL");
      // No qualifier at all — the registered callback declines, falls through to the built-in.
      const result = await Detokeniser.doAsync("[[date|today|yyyy]]");
      expect(result).toBe(format(new Date(), "yyyy"));
    });

    it("resetCallbacks removes an override and restores the built-in — built-ins live in a separate, never-reset list", async () => {
      Detokeniser.addCallback("date", () => "OVERRIDDEN");
      Detokeniser.resetCallbacks();
      const result = await Detokeniser.doAsync("[[date|today|yyyy]]");
      expect(result).toBe(format(new Date(), "yyyy"));
    });

    it("a callback receives the same DoOptions the caller passed to doAsync, including contextParameters", async () => {
      let captured: Record<string, unknown> | undefined;
      Detokeniser.addCallback("anything", ({ options }) => {
        captured = options.contextParameters;
        return "ok";
      });
      await Detokeniser.doAsync("[[anything]]", { contextParameters: { foo: "bar" } });
      expect(captured).toEqual({ foo: "bar" });
    });

    it("a verb qualifier is extracted — first unescaped ')' ends it, no nesting", async () => {
      let capturedQualifier: string | undefined;
      Detokeniser.addCallback("someverb", ({ qualifier }) => {
        capturedQualifier = qualifier;
        return "ok";
      });
      await Detokeniser.doAsync("[[someverb(ddd(sd)|arg1|arg2]]");
      expect(capturedQualifier).toBe("ddd(sd");
    });

    it("an unterminated verb qualifier throws a clear error", async () => {
      Detokeniser.addCallback("someverb", () => "ok");
      await expect(Detokeniser.doAsync("[[someverb(unterminated|arg]]")).rejects.toThrow(/Unterminated/);
    });
  });

  // ─── Structural parsing (stack-based boundary scanning) ────────────────────────
  //
  // Coverage for the single-pass, stack-based rewrite of the token-boundary scanner — see
  // utils/docs/design/detokeniser-structural-parsing-redesign.md for the full design. The
  // prior design found a token's boundaries by locating the first [[/]] pair and splicing the
  // resolved value back into the surrounding text for a fresh re-scan — meaning a verb's own
  // resolved output (not just literal, test-author-written text) was itself re-examined for
  // [[/]] syntax, with no way to tell the two apart. These tests exercise exactly that case:
  // a verb whose output can, by chance, contain the raw characters [[ or ]].

  describe("Structural parsing — resolved output never re-interpreted as token syntax", () => {
    it("a verb producing literal ]] or [[ in its own output never corrupts a later sibling token, across many random draws", async () => {
      Detokeniser.delimiter = ";";
      // random|from([])|2 draws two characters from a pool of exactly "[" and "]" — across
      // enough draws this hits every one of "[[", "]]", "[]", "][" at least once, including
      // the two dangerous cases that look like real token boundaries.
      for (let i = 0; i < 200; i++) {
        const result = await Detokeniser.doAsync("before [[random;from([]);2]] after [[date;today;yyyy]]");
        expect(result).toMatch(/^before (\[\[|\]\]|\[\]|\]\[) after \d{4}$/);
      }
    });

    it("nesting and multiple sibling tokens in the same string both resolve correctly together", async () => {
      Detokeniser.delimiter = ";";
      const result = await Detokeniser.doAsync(
        "Order [[random;digits;4]] placed on [[date;today;yyyy-MM-dd]], ships by " +
        "[[date;addDays([[random;digits;1]]);dd-MM-yyyy]], ref [[random;uppercaseletters;3]]"
      );
      expect(result).toMatch(/^Order \d{4} placed on \d{4}-\d{2}-\d{2}, ships by \d{2}-\d{2}-\d{4}, ref [A-Z]{3}$/);
    });

    it("a [[ never closed by a matching ]] anywhere in the string is tolerated as literal text, not an error — unchanged from the prior design", async () => {
      const result = await Detokeniser.doAsync("before [[unclosed and [[random|digits|2]] after");
      expect(result).toMatch(/^before \[\[unclosed and \d{2} after$/);
    });

    it("a stray ]] with no open [[ to close is literal text, and — unlike the prior design — does not prevent a later, well-formed sibling token from resolving", async () => {
      const result = await Detokeniser.doAsync("]] [[random|digits|3]]");
      expect(result).toMatch(/^\]\] \d{3}$/);
    });
  });
});
