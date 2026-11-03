import { addDays, addMonths, addYears, format } from "date-fns";

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

    it("string with unknown token throws", async () => {
      await expect(Detokeniser.doAsync("[[unknown]]")).rejects.toThrow(
        "Error processing [[[unknown]]]: Unsupported token [unknown]"
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

    it("sync callback receives full token body and its return value is used", async () => {
      let capturedToken: string | undefined;
      Detokeniser.addCallback((token: string) => {
        capturedToken = token;
        return "syncResult";
      });
      const result = await Detokeniser.doAsync("[[mytoken]]");
      expect(capturedToken).toBe("mytoken");
      expect(result).toBe("syncResult");
    });

    it("sync callback receives token with multiple pipe-separated parts", async () => {
      let capturedToken: string | undefined;
      Detokeniser.addCallback((token: string) => {
        capturedToken = token;
        return "ok";
      });
      await Detokeniser.doAsync("[[mytype|arg1|arg2]]");
      expect(capturedToken).toBe("mytype|arg1|arg2");
    });

    it("first callback returning undefined passes to second", async () => {
      Detokeniser.addCallback((token: string) => (token === "first" ? "one" : undefined));
      Detokeniser.addCallback((token: string) => (token === "second" ? "two" : undefined));
      await expect(Detokeniser.doAsync("[[first]]")).resolves.toBe("one");
      await expect(Detokeniser.doAsync("[[second]]")).resolves.toBe("two");
    });

    it("all callbacks returning undefined throws unsupported token", async () => {
      Detokeniser.addCallback(() => undefined);
      await expect(Detokeniser.doAsync("[[anything]]")).rejects.toThrow("Unsupported token");
    });

    it("async callback receives full token body and its return value is used", async () => {
      let capturedToken: string | undefined;
      Detokeniser.addCallback(async (token: string) => {
        capturedToken = token;
        return "asyncResult";
      });
      const result = await Detokeniser.doAsync("[[asynctoken]]");
      expect(capturedToken).toBe("asynctoken");
      expect(result).toBe("asyncResult");
    });

    it("async callback receives token with multiple pipe-separated parts", async () => {
      let capturedToken: string | undefined;
      Detokeniser.addCallback(async (token: string) => {
        capturedToken = token;
        return "ok";
      });
      await Detokeniser.doAsync("[[asynctype|arg1|arg2]]");
      expect(capturedToken).toBe("asynctype|arg1|arg2");
    });

    it("resetCallbacks clears all callbacks", async () => {
      Detokeniser.addCallback(() => "sync");
      Detokeniser.addCallback(async () => "async");
      Detokeniser.resetCallbacks();
      await expect(Detokeniser.doAsync("[[anything]]")).rejects.toThrow("Unsupported token");
    });

    it("reset clears all callbacks", async () => {
      Detokeniser.addCallback(() => "sync");
      Detokeniser.addCallback(async () => "async");
      Detokeniser.reset();
      await expect(Detokeniser.doAsync("[[anything]]")).rejects.toThrow("Unsupported token");
    });
  });
});
