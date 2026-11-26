import { addDays, addMonths, addYears, format } from "date-fns";

import { Log, LogLevels, StringUtils } from "../index.js";
import { Detokeniser } from "./detokeniser.js";

describe("Detokeniser", () => {
  // The default tokenStartStop is now "<%%>" (utils/docs/design/
  // detokeniser-v2-engine-rewrite.md, point 9) — but almost every test below predates that
  // change and writes its literal token syntax as "[[...]]" for readability. Rather than
  // rewrite 200+ literal strings, this pins the boundary to the "[[]]" alternate before every
  // test: every mechanic in the engine (scan, escape, nesting, markers, logging) is provably
  // boundary-character-agnostic — see detokeniser.ts, every one of those mechanics reads
  // _startTokenChar/_endTokenChar as fields, never a hardcoded string — so this is equivalent
  // coverage to running the exact same assertions under the real default. Genuine coverage of
  // the real, unmodified default — including the two adversarial real-world strings that
  // motivated changing it — lives in its own "default tokenStartStop ('<%%>')" describe block
  // below, which calls Detokeniser.reset() itself to see the true factory default rather than
  // this pin.
  beforeEach(() => {
    Detokeniser.tokenStartStop = "[[]]";
  });

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

  // ─── tokenStartStop ────────────────────────────────────────────────────────────

  describe("tokenStartStop", () => {
    // Overrides the suite-wide beforeEach's "[[]]" pin (see the top-of-suite comment) to see
    // the real, unmodified factory default.
    it("is '<%%>' by default", () => {
      Detokeniser.reset();
      expect(Detokeniser.tokenStartStop).toBe("<%%>");
    });

    it("accepts every value on the allow-list", async () => {
      Detokeniser.tokenStartStop = "<%%>";
      expect(Detokeniser.tokenStartStop).toBe("<%%>");
      await expect(Detokeniser.doAsync("<%random|digits|4%>")).resolves.toMatch(/^\d{4}$/);

      Detokeniser.tokenStartStop = "{{}}";
      expect(Detokeniser.tokenStartStop).toBe("{{}}");
      await expect(Detokeniser.doAsync("{{random|digits|4}}")).resolves.toMatch(/^\d{4}$/);

      Detokeniser.tokenStartStop = "<<>>";
      expect(Detokeniser.tokenStartStop).toBe("<<>>");
      await expect(Detokeniser.doAsync("<<random|digits|4>>")).resolves.toMatch(/^\d{4}$/);

      Detokeniser.tokenStartStop = "[[]]";
      expect(Detokeniser.tokenStartStop).toBe("[[]]");
      await expect(Detokeniser.doAsync("[[random|digits|4]]")).resolves.toMatch(/^\d{4}$/);
    });

    it("rejects a 2-character shorthand — the setting takes the full 4-character open+close form, not a decoded pair", () => {
      expect(() => (Detokeniser.tokenStartStop = "[]")).toThrow(/not an allowed token boundary/);
      expect(() => (Detokeniser.tokenStartStop = "{}")).toThrow(/not an allowed token boundary/);
    });

    it("rejects a mismatched open/close pair", () => {
      expect(() => (Detokeniser.tokenStartStop = "[[}}")).toThrow(/not an allowed token boundary/);
    });

    it("rejects '(())' specifically — it collides with this grammar's own paren-based verb syntax, not just incidental data, so it's not on the allow-list at all", () => {
      expect(() => (Detokeniser.tokenStartStop = "(())")).toThrow(/not an allowed token boundary/);
    });

    it("rejects a non-string value", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (Detokeniser.tokenStartStop = 42 as any)).toThrow();
    });

    it("leaves the previous, still-valid boundary in place after a rejected assignment", () => {
      Detokeniser.tokenStartStop = "{{}}";
      expect(() => (Detokeniser.tokenStartStop = "[]")).toThrow();
      expect(Detokeniser.tokenStartStop).toBe("{{}}");
    });

    it("reset() restores tokenStartStop to '<%%>'", () => {
      Detokeniser.tokenStartStop = "<<>>";
      Detokeniser.reset();
      expect(Detokeniser.tokenStartStop).toBe("<%%>");
    });

    it("escaping, de-escaping, and nesting all generalise correctly to a non-default boundary — the mechanics are boundary-agnostic", async () => {
      Detokeniser.tokenStartStop = "{{}}";
      await expect(Detokeniser.doAsync("No `{{token`}} here")).resolves.toBe("No {{token}} here");
      await expect(Detokeniser.doAsync("{{date|addDays({{random|digits|1}})|yyyy-MM-dd}}")).resolves.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("markers/opacity work identically under a non-default boundary", async () => {
      Detokeniser.tokenStartStop = "<<>>";
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mysetting", () => "hello;world");
      Detokeniser.addCallback("concat", ({ args, delimiter }) => String(args.split(delimiter).length));
      await expect(Detokeniser.doAsync("<<concat;<<mysetting>>;suffix>>")).resolves.toBe("2");
      Detokeniser.resetCallbacks();
    });

    it("the exact 2D-JSON-array collision this setting exists for — switching boundary avoids it entirely, with the fail-loud-on-unrecognised-verb guarantee fully intact", async () => {
      // Under the [[]] alternate boundary this throws (see "Malformed input throws" above) —
      // the array's own incidental [[/]] adjacency is indistinguishable from real token
      // syntax. Switching to <<>> removes the collision outright: this data has no "<<"/">>"
      // anywhere, so the array is never mistaken for token syntax in the first place.
      Detokeniser.tokenStartStop = "<<>>";
      Detokeniser.addCallback("myval", () => "99");
      await expect(Detokeniser.doAsync('{"data":[[1,2],[3,<<myval>>]]}')).resolves.toBe('{"data":[[1,2],[3,99]]}');
      Detokeniser.resetCallbacks();
    });
  });

  // ─── default tokenStartStop ('<%%>') — real, unmodified default, not the [[]] pin ────────
  //
  // Everything above (and below) this block runs under the suite-wide "[[]]" pin for literal-
  // syntax readability. This block calls Detokeniser.reset() itself to see the true, factory
  // default and never touches tokenStartStop otherwise — it's the one place in this suite that
  // actually exercises "<%%>" end to end, including the two real adversarial file-path strings
  // that motivated moving off [[]] as the default in the first place (utils/docs/design/
  // detokeniser-v2-engine-rewrite.md, point 9).

  describe("default tokenStartStop ('<%%>')", () => {
    beforeEach(() => {
      Detokeniser.reset();
    });

    it("resolves a token end to end using the real default boundary, with no tokenStartStop assignment at all", async () => {
      await expect(Detokeniser.doAsync("Ref-<%random|digits|4%>")).resolves.toMatch(/^Ref-\d{4}$/);
    });

    it("nesting and escaping both work correctly under the real default, not just the [[]] alternate", async () => {
      await expect(Detokeniser.doAsync("<%date|addDays(<%random|digits|1%>)|dd-MM-yyyy%>")).resolves.toMatch(/^\d{2}-\d{2}-\d{4}$/);
      await expect(Detokeniser.doAsync("No `<%token`%> here")).resolves.toBe("No <%token%> here");
    });

    it("a plain file path containing no tokens at all, with heavy incidental [[/]] adjacency, passes through completely unchanged under the real default — the first of the two real paths that broke the previous default", async () => {
      // No "<" or ">" anywhere in this string at all, so it can never collide with <%/%> —
      // structurally, not by luck (see point 9's own survey). Previously threw outright under
      // the old [[]] default: "Detokeniser: unmatched ]] — no corresponding [[ found before
      // it", since this string's own incidental [[/]] adjacency looked exactly like real,
      // unterminated token syntax.
      const path = "/hell/[[hwho/amd/[[hhe]]/b[[]]s./stuff/[[.txt";
      await expect(Detokeniser.doAsync(path)).resolves.toBe(path);
    });

    it("a plain file path mixing [[/]] and <</>> adjacency, with no tokens at all, passes through completely unchanged under the real default — the second, worse real path, which previously corrupted silently under every old boundary", async () => {
      // Under every one of the three old allow-listed boundaries ([[]], {{}}, <<>>) this used
      // to come back silently WRONG — not a thrown error, actual deleted "/" characters —
      // because the escape character was "/" itself, unconditionally, regardless of which
      // boundary was active: a "/" sitting right before any active boundary sequence was
      // consumed as "this escapes the next boundary char". This string has no "%" anywhere, so
      // under the real default it can't collide with "<%"/"%>" either as boundary OR as the
      // new backtick escape character (which this string also doesn't contain) escaping
      // anything — it must come back completely untouched.
      const path = "/this/[[/is/]]also/<<valid/<</>>/path/see.txt";
      await expect(Detokeniser.doAsync(path)).resolves.toBe(path);
    });
  });

  // ─── Exhaustive file-path data — every allow-listed boundary, no tokens ─────────────────
  //
  // Every string in this block is pure literal data a real test might pass through the
  // Detokeniser incidentally (a path field inside a larger body) — none of them contain a
  // real token. Run under all 4 allow-listed boundaries, not just the default: 19 of the 20
  // generic shapes below (plain Unix, Windows drive-letter and UNC, spaces, unicode, dot-heavy
  // names, degenerate/edge forms, URLs, percent-encoding) contain none of any boundary's own
  // characters at all, so they're asserted unchanged universally. The remaining cases —
  // Mat's own two real adversarial paths, a path containing every legacy pair's characters,
  // and a path genuinely containing the live boundary sequence — behave *differently* by
  // design depending which boundary is active (that's the whole point of the setting), so
  // each gets its own explicit per-boundary branch rather than a blanket assertion.

  describe.each([
    { label: "<% %> (default)", open: "<%", close: "%>" },
    { label: "[[ ]]", open: "[[", close: "]]" },
    { label: "{{ }}", open: "{{", close: "}}" },
    { label: "<< >>", open: "<<", close: ">>" },
  ])("tokenStartStop = $label", ({ open, close }) => {
    beforeEach(() => {
      Detokeniser.tokenStartStop = open + close;
    });

    it.each([
      ["Unix absolute path", "/usr/local/bin/node"],
      ["Unix relative path, parent-dir segments", "../../config/settings.yaml"],
      ["Unix dot-relative path", "./src/index.ts"],
      ["Windows drive-letter path", "C:\\Users\\mat\\file.txt"],
      ["Windows UNC path", "\\\\server\\share\\folder\\file.txt"],
      ["path containing spaces", "/home/mat/My Documents/report final.docx"],
      ["path containing unicode characters", "/home/mat/résumé_日本語.pdf"],
      ["path with a multi-segment dotted extension", "/home/mat/archive.tar.gz.bak"],
      ["a bare dot-segment path", "..."],
      ["the root path alone", "/"],
      ["a path with a trailing slash", "/home/mat/folder/"],
      ["a path with incidental doubled/tripled slashes", "/home//mat///folder"],
      ["a full http(s) URL with query string and fragment", "https://example.com/path?query=1&other=2#fragment"],
      ["a file:// URI", "file:///home/mat/file.txt"],
      ["a path containing percent-encoding", "/home/mat/My%20Documents/file.txt"],
      ["a path with lone (non-doubled) angle brackets", "/home/mat/<weird>file.txt"],
      ["a path containing a literal backtick (the escape char) with nothing to escape", "/home/mat/file`name.txt"],
      ["a path containing a literal newline", "/home/mat/file\nname.txt"],
      ["a backtick immediately before an unrelated '<' with nothing matching after it", "/home/mat/file`<weird.txt"],
      ["a very long path, well past any truncation length used in logging", `/home/mat/${"x".repeat(500)}/file.txt`],
    ])("%s — passes through completely unchanged", async (_label, path) => {
      await expect(Detokeniser.doAsync(path)).resolves.toBe(path);
    });

    it("a path containing every legacy boundary pair's own characters — throws under whichever one the string's own bracket pair actually matches, passes through under the rest", async () => {
      const path = "/p/[[a]]/{{b}}/<<c>>/d";
      if (open === "[[" || open === "{{" || open === "<<") {
        await expect(Detokeniser.doAsync(path)).rejects.toThrow(/Unsupported token/);
      } else {
        await expect(Detokeniser.doAsync(path)).resolves.toBe(path);
      }
    });

    it("the first real adversarial path Mat reported — throws only under [[]] (its own unmatched ]]), passes through under every other boundary", async () => {
      const path = "/hell/[[hwho/amd/[[hhe]]/b[[]]s./stuff/[[.txt";
      if (open === "[[") {
        await expect(Detokeniser.doAsync(path)).rejects.toThrow(/Unsupported token/);
      } else {
        await expect(Detokeniser.doAsync(path)).resolves.toBe(path);
      }
    });

    it("the second, worse real adversarial path Mat reported — previously corrupted silently under every old boundary (the '/' escape char ate real path separators); now throws cleanly under [[]]/<<>> (its own real bracket pairs) and passes through under <%%>/{{}}", async () => {
      const path = "/this/[[/is/]]also/<<valid/<</>>/path/see.txt";
      if (open === "[[" || open === "<<") {
        await expect(Detokeniser.doAsync(path)).rejects.toThrow(/Unsupported token/);
      } else {
        await expect(Detokeniser.doAsync(path)).resolves.toBe(path);
      }
    });

    it("a path genuinely containing the live open sequence, with no matching close anywhere — throws unterminated under every boundary (there's nothing boundary-specific about this one, just a plain unterminated opener)", async () => {
      const path = `/home/mat/${open}weird/file.txt`;
      await expect(Detokeniser.doAsync(path)).rejects.toThrow(/unterminated/i);
    });

    it("a path genuinely containing the live close sequence, with no matching open anywhere — throws unmatched under every boundary, same reasoning", async () => {
      const path = `/home/mat/weird${close}/file.txt`;
      await expect(Detokeniser.doAsync(path)).rejects.toThrow(/unmatched/i);
    });

    it("escaping with a single backtick reveals the exact literal path regardless of which boundary is active — the escape character itself never changes with tokenStartStop", async () => {
      const raw = `/home/mat/${open}weird/file.txt`;
      const escaped = `/home/mat/\`${open}weird/file.txt`;
      await expect(Detokeniser.doAsync(escaped)).resolves.toBe(raw);
    });
  });

  describe("Exhaustive file-path data — mixed with a real token (real default boundary only)", () => {
    beforeEach(() => {
      Detokeniser.reset();
    });

    it("an incidental path containing every old boundary's lookalike adjacency coexists correctly with a real token elsewhere in the same body", async () => {
      const result = await Detokeniser.doAsync("Loaded from /this/[[path/[[.txt and id=<%random|digits|4%>");
      expect(result).toMatch(/^Loaded from \/this\/\[\[path\/\[\[\.txt and id=\d{4}$/);
    });
  });

  // ─── maxNestingDepth ──────────────────────────────────────────────────────────

  describe("maxNestingDepth", () => {
    it("is 8 by default", () => {
      expect(Detokeniser.maxNestingDepth).toBe(8);
    });

    it("rejects zero, negative, non-integer and non-number values", () => {
      expect(() => (Detokeniser.maxNestingDepth = 0)).toThrow();
      expect(() => (Detokeniser.maxNestingDepth = -1)).toThrow();
      expect(() => (Detokeniser.maxNestingDepth = 2.5)).toThrow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (Detokeniser.maxNestingDepth = "8" as any)).toThrow();
    });

    it("accepts a positive integer, including 1", () => {
      Detokeniser.maxNestingDepth = 1;
      expect(Detokeniser.maxNestingDepth).toBe(1);
      Detokeniser.maxNestingDepth = 100;
      expect(Detokeniser.maxNestingDepth).toBe(100);
    });

    it("leaves the previous, still-valid value in place after a rejected assignment", () => {
      Detokeniser.maxNestingDepth = 5;
      expect(() => (Detokeniser.maxNestingDepth = -1)).toThrow();
      expect(Detokeniser.maxNestingDepth).toBe(5);
    });

    it("reset() restores maxNestingDepth to 8", () => {
      Detokeniser.maxNestingDepth = 2;
      Detokeniser.reset();
      expect(Detokeniser.maxNestingDepth).toBe(8);
    });

    it("governs literal bracket-nesting depth written directly in the input, not just handler recursion", async () => {
      Detokeniser.addCallback("echo", ({ args }) => args);
      Detokeniser.maxNestingDepth = 2;
      // 3 literal levels of [[echo|...]] nesting — one more than the limit allows.
      await expect(Detokeniser.doAsync("[[echo|[[echo|[[echo|x]]]]]]")).rejects.toThrow(/too many levels of \[\[\] nesting|maxNestingDepth/);
    });

    it("literal bracket-nesting within the limit still resolves correctly", async () => {
      Detokeniser.addCallback("echo", ({ args }) => args);
      Detokeniser.maxNestingDepth = 5;
      await expect(Detokeniser.doAsync("[[echo|[[echo|[[echo|x]]]]]]")).resolves.toBe("x");
    });

    it("governs a handler's own output recursively resolving into fresh tokens (not just literal input nesting)", async () => {
      Detokeniser.addCallback("loop", () => "[[loop]]");
      await expect(Detokeniser.doAsync("[[loop]]")).rejects.toThrow(/maxNestingDepth/);
    });

    it("a handler chain that terminates within the configured depth resolves correctly", async () => {
      let remaining = 3;
      Detokeniser.addCallback("countdown", () => {
        remaining--;
        return remaining > 0 ? "[[countdown]]" : "done";
      });
      await expect(Detokeniser.doAsync("[[countdown]]")).resolves.toBe("done");
    });

    it("lowering the limit makes a previously-fine handler chain throw", async () => {
      Detokeniser.maxNestingDepth = 1;
      let remaining = 3;
      Detokeniser.addCallback("countdown", () => {
        remaining--;
        return remaining > 0 ? "[[countdown]]" : "done";
      });
      await expect(Detokeniser.doAsync("[[countdown]]")).rejects.toThrow(/maxNestingDepth/);
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
      expect(processedCalls[0][1]).toContain("[[random|digits|1]]");
      expect(processedCalls[1][1]).toContain("[[date|addDays(");
    });

    it("a nested token's log line shows the real, marker-resolved value on the result side, even though the raw-token side shows the internal marker (the inner token was already resolved and marker-substituted by the time the outer one's own raw text is captured)", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mysetting", () => "hello;world");
      Detokeniser.addCallback("concat", ({ args, delimiter }) => args.split(delimiter).join(""));
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync("[[concat;[[mysetting]];suffix]]");

      const outerCall = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith("Processed [[[concat;")
      );
      expect(outerCall).toBeDefined();
      // The result side ("to [...]") is marker-resolved for readability; the raw-token side
      // necessarily shows whatever was already in the buffer when concat's own ]] closed —
      // by then the inner [[mysetting]] syntax is long gone, replaced by its marker.
      expect(outerCall?.[1]).toMatch(/^Processed \[\[\[concat;.+;suffix\]\]\] to \[hello;worldsuffix\]$/);
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
        ([level, message]) => level === LogLevels.FrameworkInformation && (message as string).startsWith("Processed [")
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Processed [plain text, nothing to resolve here], no tokens found");
    });

    it("truncates the 'no tokens found' line's raw string at 48 characters", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      const longPlainText = "x".repeat(200);
      await Detokeniser.doAsync(longPlainText);

      const call = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.FrameworkInformation && (message as string).startsWith("Processed [")
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBe(`Processed [${StringUtils.truncateIfNeeded(longPlainText, 48)}], no tokens found`);
    });

    it("never logs 'no tokens found' for a string that does contain a token", async () => {
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await Detokeniser.doAsync("Ref-[[random|digits|4]]");

      const noTokenCall = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.FrameworkInformation && (message as string).endsWith("no tokens found")
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

    it("string with escaped token opener and closer", async () => {
      await expect(Detokeniser.doAsync("No `[[token`]] here")).resolves.toStrictEqual("No [[token]] here");
    });

    it("string with escaped escape then escaped token opener and closer", async () => {
      await expect(Detokeniser.doAsync("No ```[[token`]] here")).resolves.toStrictEqual("No `[[token]] here");
    });

    // De-escaping is positional (only immediately before [[/]]), not a global find-and-replace
    // — a run of escape chars nowhere near a token boundary must never be touched.
    it("a double escape char far from any token boundary is left completely untouched", async () => {
      await expect(Detokeniser.doAsync("a stray `` backtick pair, nowhere near a boundary")).resolves.toStrictEqual(
        "a stray `` backtick pair, nowhere near a boundary"
      );
    });

    it("an even-length escape run immediately before a REAL, resolved token boundary doesn't stop the token resolving, and is left completely untouched afterward", async () => {
      // "``[[" — the even run (2 chars) doesn't escape the boundary, so the token still
      // resolves. Once resolved, the "[[" that run used to precede is gone entirely (replaced
      // by the token's result) — there's no boundary sequence left for the de-escape pass to
      // find adjacent to the "``" anymore, so (unlike the escaped-boundary case above) it's
      // left exactly as-is, not collapsed.
      await expect(Detokeniser.doAsync("No ``[[random|digits|1]] here")).resolves.toMatch(/^No ``\d here$/);
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

  // ─── Malformed input — throws, no tolerant fallback ──────────────────────────
  //
  // Deliberate behaviour change from the engine this replaces (see
  // utils/docs/design/detokeniser-v2-engine-rewrite.md, "Malformed input / unrecognised verb:
  // throw") — an unterminated [[, a stray ]], an incidental JSON-nested-array-shaped [[/]]
  // adjacency, and an unrecognised verb all used to fold back to literal text. All of them now
  // throw and fail the current test outright.

  describe("Malformed input throws", () => {
    it("an opener with no matching closer throws", async () => {
      await expect(Detokeniser.doAsync("No token [[here")).rejects.toThrow(/unterminated/i);
    });

    it("a closer with no matching opener throws", async () => {
      await expect(Detokeniser.doAsync("No token ]]here")).rejects.toThrow(/unmatched/i);
    });

    it("an unrecognised verb throws, naming the verb", async () => {
      await expect(Detokeniser.doAsync("[[unknown]]")).rejects.toThrow(/Unsupported token \[unknown\]/);
    });

    it("a callback declining (returning undefined) with nothing else registered for that verb throws", async () => {
      Detokeniser.addCallback("anything", () => undefined);
      await expect(Detokeniser.doAsync("[[anything]]")).rejects.toThrow(/Unsupported token/);
      Detokeniser.resetCallbacks();
    });

    it("an incidental JSON-nested-array-shaped [[/]] adjacency, with no real verb involved, now throws rather than passing through", async () => {
      // Previously tolerated as "incidental [[/]] adjacency in unrelated data" — the new
      // engine makes no such allowance; Detokeniser is only ever called on strings a tester
      // deliberately wants detokenised.
      const body = `{"data":[[1,2],[3,4]]}`;
      await expect(Detokeniser.doAsync(body)).rejects.toThrow();
    });

    it("a 2D JSON array with a genuine nested token inside one of its cells still throws — the token's own [[/]] get mismatched with the array's incidental ones, not cleanly separated from them", async () => {
      // Tracing the scan: the outer "[[" (of [[1,2],[3,...) opens a frame; the lone "]" after
      // "1,2" and lone "[" before "3" are just ordinary characters (neither is part of a real
      // "]]"/"[[" pair); the inner [[myval]] opens and closes its OWN frame correctly and
      // resolves to "99", leaving "1,2],[3,<marker>" as what's accumulated; the FOURTH ']'
      // then pairs with the THIRD one to close the outer frame, handing
      // "1,2],[3,<marker>" to doToken as one single, bogus "verb" — which nothing claims.
      Detokeniser.addCallback("myval", () => "99");
      // The error message must show the real resolved value ("99"), never a raw, invisible
      // marker sentinel character — see the readability fix this exact case surfaced.
      await expect(Detokeniser.doAsync('{"data":[[1,2],[3,[[myval]]]]}')).rejects.toThrow(/Unsupported token \[1,2\],\[3,99\]/);
      Detokeniser.resetCallbacks();
    });

    it("by contrast, a genuine nested token inside a single-dimension JSON array resolves correctly — the ambiguity is specifically about [[/]] ADJACENCY (2D arrays), not arrays in general", async () => {
      Detokeniser.addCallback("myval", () => "99");
      await expect(Detokeniser.doAsync('{"data":[1,2,3],"id":"[[myval]]"}')).resolves.toBe('{"data":[1,2,3],"id":"99"}');
      // Even a single array directly WRAPPING the token (one extra ']' beyond the token's own
      // "]]", with nothing after it to pair with) is fine — only back-to-back "[["/"]]" pairs
      // from TWO adjacent structural levels are ambiguous, not a lone extra bracket.
      await expect(Detokeniser.doAsync("[3,[[myval]]]")).resolves.toBe("[3,99]");
      Detokeniser.resetCallbacks();
    });

    it("a [[ never closed by a matching ]] anywhere in the string throws, even with a well-formed sibling token present", async () => {
      await expect(Detokeniser.doAsync("before [[unclosed and [[random|digits|2]] after")).rejects.toThrow(/unterminated/i);
    });

    it("a stray ]] with no open [[ throws, even with a well-formed sibling token present", async () => {
      await expect(Detokeniser.doAsync("]] [[random|digits|3]]")).rejects.toThrow(/unmatched/i);
    });

    it("an unterminated verb qualifier throws a clear error", async () => {
      Detokeniser.addCallback("someverb", () => "ok");
      await expect(Detokeniser.doAsync("[[someverb(unterminated|arg]]")).rejects.toThrow(/Unterminated/);
      Detokeniser.resetCallbacks();
    });

    it("an empty token body throws", async () => {
      await expect(Detokeniser.doAsync("[[]]")).rejects.toThrow(/Empty token/);
    });

    it("a non-string input, while enabled, is rejected by the usual type assertion rather than silently accepted", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(Detokeniser.doAsync(42 as any)).rejects.toThrow(/tokenisedString/);
    });

    it("a handler's own malformed output that falls back to literal (see Processor-output recursion) can still contain an even-length escape run surviving right next to the now-literal boundary — de-escape still collapses it pairwise", async () => {
      // 2 escape chars before an unterminated [[ — the recursive output check tolerates the
      // unterminated bracket (handler output, not original input, per the fallback above) and
      // uses it literally; de-escape then still collapses the even run pairwise, same as it
      // would for any other even run immediately before a literal [[/]].
      Detokeniser.addCallback("bracketdata3", () => "a``[[b");
      await expect(Detokeniser.doAsync("[[bracketdata3]]")).resolves.toBe("a`[[b");
      Detokeniser.resetCallbacks();
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
      await expect(Detokeniser.doAsync("[[random|from(ab`[[)|3]]")).resolves.toMatch(/^[ab[]{3}$/);
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
      await expect(Detokeniser.doAsync("[[random|from('he`'llo')|6]]")).resolves.toBe("he'llo");
    });

    it("from - quoted string list, opposite quote type inside an item needs no escaping", async () => {
      await expect(Detokeniser.doAsync('[[random|from("he\'llo")|6]]')).resolves.toBe("he'llo");
    });

    it("from - quoted string list, literal ')' inside an item doesn't end the call early", async () => {
      await expect(Detokeniser.doAsync("[[random|from('he)llo')|6]]")).resolves.toBe("he)llo");
    });

    it("from - quoted string list, <length> is a maximum total — an overshooting draw is never truncated, the fill loop just stops before adding it", async () => {
      // items of length 7/3/5, cap 5: drawing the 7-char item first doesn't fit at all → "";
      // drawing the 3-char item first leaves remaining=2, nothing else fits → "123"; drawing
      // the 5-char item first exactly fills the cap → "12345". No outcome is ever a truncated
      // partial item (e.g. "12345" cut from the 7-char item) — buildFromStringListResult never
      // truncates, only stops cleanly.
      await expect(Detokeniser.doAsync("[[random|from('1234567','123','12345')|5]]")).resolves.toMatch(/^(|123|12345)$/);
    });

    it("from - quoted string list, a cap shorter than every item always resolves to empty — the fill loop stops before its first draw, never truncates it to fit", async () => {
      // Both items (4 and 5 chars) exceed the 3-char cap, so the very first draw, whichever
      // item it is, never fits — the loop breaks immediately, every time.
      await expect(Detokeniser.doAsync("[[random|from('true','false')|3]]")).resolves.toBe("");
    });

    it("from - quoted string list, an empty item stops the fill loop rather than looping forever", async () => {
      // Drawing '' first stops immediately (an empty item always breaks the loop, win or
      // lose). Drawing 'bye' first (3 chars, remaining becomes 2) also stops on the next draw
      // either way — '' breaks via the empty-item rule, 'bye' again doesn't fit (3 > 2) and
      // breaks via the doesn't-fit rule. "byebye"/"byeby" can never happen — 'bye' twice is 6
      // chars, over the 5-char cap, and an overshooting draw is never truncated to fit.
      await expect(Detokeniser.doAsync("[[random|from('','bye')|5]]")).resolves.toMatch(/^(|bye)$/);
    });

    it("from - trailing content after a validly-closed call throws, naming the real cause instead of 'invalid length'", async () => {
      await expect(Detokeniser.doAsync("[[random|from('he')llo')|5]]")).rejects.toThrow(
        /Trailing content after a from\(\.\.\.\)\/float\(\.\.\.\)\/date\(\.\.\.\) call.*found: \[llo'\)\|5\]/
      );
    });

    it("from - character-pool mode, omitted length defaults to a single random character", async () => {
      await expect(Detokeniser.doAsync("[[random|from(abcd)]]")).resolves.toMatch(/^[abcd]$/);
    });

    it("from - quoted string list, omitted length picks exactly one whole item, uncapped", async () => {
      await expect(Detokeniser.doAsync("[[random|from('cat','dog')]]")).resolves.toMatch(/^(cat|dog)$/);
    });

    it("from - quoted string list, omitted length is never truncated even for a long item", async () => {
      await expect(Detokeniser.doAsync("[[random|from('1234567')]]")).resolves.toBe("1234567");
    });

    it("named set (not from(...)), omitted length defaults to a single random character", async () => {
      await expect(Detokeniser.doAsync("[[random|digits]]")).resolves.toMatch(/^\d$/);
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
      await expect(Detokeniser.doAsync("[[random|date(21600000,21660000)|dd-MM-yyyy]]")).resolves.toMatch(/^01-01-1970$/);
    });

    it("date - range returned as epoch within bounds", async () => {
      const result = parseInt(await Detokeniser.doAsync("[[random|date(21600000,108000000)|epoch]]"));
      expect(result).toBeGreaterThanOrEqual(21600000);
      expect(result).toBeLessThanOrEqual(108000000);
    });

    it("type/length nested inside a verb whose own output contains the delimiter character — opacity protects random's own split", async () => {
      Detokeniser.addCallback("poolwithdelim", () => "ab|cd");
      // The nested token's resolved value ("ab|cd") lands inside from(...)'s own content —
      // random's own splitRandomVerbArgs must see this as one opaque unit when finding the
      // type/length boundary, not be corrupted by the '|' inside it.
      await expect(Detokeniser.doAsync("[[random|from([[poolwithdelim]])|3]]")).resolves.toMatch(/^[abcd|]{3}$/);
      Detokeniser.resetCallbacks();
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
      const result = await Detokeniser.doAsync("[[date|AddHours(0)|yyyy-MM-dd]]");
      expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("addMinutes", async () => {
      const result = await Detokeniser.doAsync("[[date|AddMinutes(0)|yyyy-MM-dd]]");
      expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("random date within a fixed epoch range", async () => {
      const result = await Detokeniser.doAsync("[[date|random(946684800000,946771200000)|yyyy-MM-dd]]");
      expect(result).toMatch(/^2000-01-0[12]$/);
    });

    it("followingDay - following Friday after Sunday 2013-04-07 is 2013-04-12", async () => {
      await expect(Detokeniser.doAsync("[[date|followingDay(1365292800000,friday)|yyyy-MM-dd]]")).resolves.toBe("2013-04-12");
    });

    it("zone-aware: epoch format is unaffected by the zone (epoch has no timezone)", async () => {
      const result = await Detokeniser.doAsync("[[date|2013-4-5|epoch|UTC]]");
      expect(result).toBe("1365120000000");
    });

    it("zone-aware: fixed date formatted in a given IANA zone", async () => {
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

    it("date-fns literal-text quoting in the format argument is unaffected — the leading ' is date-fns' own escape syntax, not quote-aware splitting", async () => {
      const result = await Detokeniser.doAsync("[[date|today|'T'HH:mm]]");
      expect(result).toBe(format(new Date(), "'T'HH:mm"));
    });

    it("a nested token's output supplying the IANA zone resolves to its real value, not a leftover marker", async () => {
      Detokeniser.addCallback("myzone", () => "Pacific/Auckland");
      const result = await Detokeniser.doAsync("[[date|2013-4-5|yyyy-MM-dd HH:mm|[[myzone]]]]");
      expect(result).toBe("2013-04-05 13:00");
      Detokeniser.resetCallbacks();
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
      await expect(Detokeniser.doAsync("[[diff|Pacific/Kiritimati|UTC]]")).resolves.toBe("14");
    });

    it("quarter-hour-offset zone produces a decimal result", async () => {
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

    it("opacity: a nested token's value containing the delimiter character encodes correctly in full, not truncated at the first '|' inside it", async () => {
      Detokeniser.addCallback("nastyvalue", () => "a|b|c");
      const encoded = await Detokeniser.doAsync("[[base64|encode|[[nastyvalue]]]]");
      expect(Buffer.from(encoded, "base64").toString()).toBe("a|b|c");
      Detokeniser.resetCallbacks();
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

    it("opacity: a nested token's payload value containing the delimiter character needs no quoting at all — the marker protects it automatically", async () => {
      Detokeniser.addCallback("nastypayload", () => `{"sub":"a|b"}`);
      const result = await Detokeniser.doAsync("[[jwt|[[nastypayload]]|MySecret]]");
      const decodedPayload = JSON.parse(Buffer.from(result.split(".")[1], "base64url").toString());
      expect(decodedPayload.sub).toBe("a|b");
      Detokeniser.resetCallbacks();
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

  // ─── Callbacks / VerbContext ─────────────────────────────────────────────────

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

    it("context carries verb, rawVerb, qualifier, args and a working resolveMarkers function", async () => {
      let captured: Detokeniser.VerbContext | undefined;
      Detokeniser.addCallback("mytype", (context) => {
        captured = context;
        return "ok";
      });
      await Detokeniser.doAsync("[[mytype(q)|arg1|arg2]]");
      expect(captured).toBeDefined();
      expect(captured?.verb).toBe("mytype");
      expect(captured?.rawVerb).toBe("mytype(q)");
      expect(captured?.qualifier).toBe("q");
      expect(captured?.args).toBe("arg1|arg2");
      expect(captured?.delimiter).toBe("|");
      expect(captured?.options).toEqual({});
      expect(typeof captured?.resolveMarkers).toBe("function");
      // No markers present in this plain, unnested args text — resolveMarkers is a no-op.
      expect(captured?.resolveMarkers("arg1|arg2")).toBe("arg1|arg2");
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

    it("resetCallbacks clears all callbacks — the verb then has no handler at all and throws", async () => {
      Detokeniser.addCallback("anything", () => "sync");
      Detokeniser.resetCallbacks();
      await expect(Detokeniser.doAsync("[[anything]]")).rejects.toThrow(/Unsupported token/);
    });

    it("reset clears all callbacks — the verb then has no handler at all and throws", async () => {
      Detokeniser.addCallback("anything", () => "sync");
      Detokeniser.reset();
      // reset() also restores tokenStartStop to the real default ("<%%>", not this suite's
      // "[[]]" pin) — use that boundary here, since this is testing reset()'s own effect.
      await expect(Detokeniser.doAsync("<%anything%>")).rejects.toThrow(/Unsupported token/);
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

    it("a verb qualifier is extracted — first unescaped ')' ends it, no nesting of its own structural characters", async () => {
      let capturedQualifier: string | undefined;
      Detokeniser.addCallback("someverb", ({ qualifier }) => {
        capturedQualifier = qualifier;
        return "ok";
      });
      await Detokeniser.doAsync("[[someverb(ddd(sd)|arg1|arg2]]");
      expect(capturedQualifier).toBe("ddd(sd");
    });

    it("a qualifier with nothing after its closing ')' is legal — the whole token can just be a parameterised verb", async () => {
      Detokeniser.addCallback("q", ({ qualifier }) => `got:${qualifier}`);
      await expect(Detokeniser.doAsync("[[q(hello)]]")).resolves.toBe("got:hello");
    });

    it("an escaped ')' inside a qualifier is literal content, not the qualifier's own closing paren", async () => {
      let capturedQualifier: string | undefined;
      Detokeniser.addCallback("q", ({ qualifier }) => {
        capturedQualifier = qualifier;
        return "ok";
      });
      await Detokeniser.doAsync("[[q(a`)b)|arg]]");
      expect(capturedQualifier).toBe("a)b");
    });

    it("something other than the delimiter or end-of-string immediately after a qualifier's closing ')' is malformed and throws", async () => {
      Detokeniser.addCallback("q", () => "ok");
      await expect(Detokeniser.doAsync("[[q(hello)X]]")).rejects.toThrow(/Malformed token/);
    });

    it("a user-registered callback that throws is logged and treated as declining — falls through to the next callback, then the built-in", async () => {
      // Registered first, so tried SECOND (most-recently-registered is tried first) — this is
      // the one that should actually end up winning, once the throwing one above it declines.
      Detokeniser.addCallback("date", () => "SECOND");
      // Registered second (most recent) — tried FIRST, throws, gets caught+logged, falls
      // through to the one above.
      Detokeniser.addCallback("date", () => {
        throw new Error("deliberately broken callback");
      });
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await expect(Detokeniser.doAsync("[[date|today|yyyy]]")).resolves.toBe("SECOND");
      const errorCall = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.Error && (message as string).includes("deliberately broken callback")
      );
      expect(errorCall).toBeDefined();
      vi.restoreAllMocks();
    });
  });

  // ─── Opacity / markers ────────────────────────────────────────────────────────
  //
  // See utils/docs/design/detokeniser-v2-engine-rewrite.md, "Opacity — the marker scheme".
  // A resolved value spliced into a still-open outer token's own body must never let its own
  // characters be mistaken for that outer token's structural syntax, regardless of what that
  // outer verb's own splitting convention is.

  describe("Opacity / markers", () => {
    afterEach(() => {
      Detokeniser.resetCallbacks();
    });

    it("a verb that does its own naive delimiter split sees exactly the parts it expects, never corrupted by a nested value's own delimiter characters", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mysetting", () => "hello;I;Am;mat");
      Detokeniser.addCallback("concat", ({ args, delimiter }) => String(args.split(delimiter).length));
      await expect(Detokeniser.doAsync("[[concat;[[mysetting]];suffix]]")).resolves.toBe("2");
    });

    it("a verb that needs real content calls resolveMarkers after its own split, and gets the correct dereferenced value", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mysetting", () => "hello;I;Am;mat");
      Detokeniser.addCallback("concat", ({ args, delimiter, resolveMarkers }) => resolveMarkers(args.split(delimiter).join("")));
      Detokeniser.addCallback("length", ({ args, resolveMarkers }) => String(resolveMarkers(args).length));
      await expect(Detokeniser.doAsync("[[length;[[concat;[[mysetting]];suffix]]]]")).resolves.toBe("20");
    });

    it("a verb that never calls resolveMarkers still never leaks raw marker text into the final output — the engine resolves it automatically", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mysetting", () => "hello;world");
      // concat never calls resolveMarkers at all — it just reshuffles opaque text.
      Detokeniser.addCallback("concat", ({ args, delimiter }) => args.split(delimiter).join("-"));
      const result = await Detokeniser.doAsync("[[concat;[[mysetting]];suffix]]");
      expect(result).toBe("hello;world-suffix");
      // No private-use-area marker characters anywhere in the final result.
      expect(result.includes(String.fromCodePoint(0xe000))).toBe(false);
      expect(result.includes(String.fromCodePoint(0xe001))).toBe(false);
    });

    it("markers survive multiple levels of enclosing frames unresolved, only dereferenced once at the very top", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("inner", () => "a;b;c");
      Detokeniser.addCallback("passthrough", ({ args }) => args);
      Detokeniser.addCallback("length", ({ args, resolveMarkers }) => String(resolveMarkers(args).length));
      // 3 levels: inner → passthrough → passthrough → length.
      const result = await Detokeniser.doAsync("[[length;[[passthrough;[[passthrough;[[inner]]]]]]]]");
      expect(result).toBe("5"); // "a;b;c" is 5 characters
    });

    it("a marker produced by resolving one nested value inside another's output still resolves correctly (marker-within-marker)", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("leaf", () => "x;y");
      // "wrap" glues its own opaque args together without dereferencing — its own result, when
      // embedded in an enclosing frame, is itself wrapped in a fresh marker whose stored value
      // contains the still-unresolved inner marker.
      Detokeniser.addCallback("wrap", ({ args }) => `[${args}]`);
      Detokeniser.addCallback("length", ({ args, resolveMarkers }) => String(resolveMarkers(args).length));
      const result = await Detokeniser.doAsync("[[length;[[wrap;[[leaf]]]]]]");
      expect(result).toBe("5"); // "[x;y]" is 5 characters
    });

    it("a literal private-use-area character typed directly in test data (not an internal marker) passes through completely unaffected", async () => {
      // Vanishingly unlikely in practice, but the engine must never mistake a real, isolated
      // sentinel-range character for one of its own markers if it isn't immediately followed
      // by digits and the closing sentinel.
      const literalChar = String.fromCodePoint(0xe000);
      await expect(Detokeniser.doAsync(`before ${literalChar} after`)).resolves.toBe(`before ${literalChar} after`);
    });

    // ─── Breadth: multiple sibling markers at the same level ───────────────────

    it("3 sibling nested tokens as 3 separate args — the enclosing verb sees exactly 3 parts, not corrupted by any of their delimiter-laden real values", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("zoneA", () => "x;y");
      Detokeniser.addCallback("zoneB", () => "p;q");
      Detokeniser.addCallback("zoneC", () => "m;n");
      Detokeniser.addCallback("concat3", ({ args, delimiter }) => String(args.split(delimiter).length));
      await expect(Detokeniser.doAsync("[[concat3;[[zoneA]];[[zoneB]];[[zoneC]]]]")).resolves.toBe("3");
    });

    it("3 sibling nested tokens' real values are each dereferenced correctly and independently, in the right order", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("zoneA", () => "x;y");
      Detokeniser.addCallback("zoneB", () => "p;q");
      Detokeniser.addCallback("zoneC", () => "m;n");
      Detokeniser.addCallback("concat3real", ({ args, delimiter, resolveMarkers }) => args.split(delimiter).map(resolveMarkers).join("|"));
      await expect(Detokeniser.doAsync("[[concat3real;[[zoneA]];[[zoneB]];[[zoneC]]]]")).resolves.toBe("x;y|p;q|m;n");
    });

    it("the same verb invoked twice at the same level gets two distinct, independently-indexed markers — not one slot overwriting the other", async () => {
      Detokeniser.delimiter = ";";
      let n = 0;
      Detokeniser.addCallback("counter", () => `v${n++};x`);
      Detokeniser.addCallback("concat", ({ args, delimiter, resolveMarkers }) => args.split(delimiter).map(resolveMarkers).join("|"));
      await expect(Detokeniser.doAsync("[[concat;[[counter]];[[counter]]]]")).resolves.toBe("v0;x|v1;x");
    });

    it("a mix of plain literal args and nested-token args, interleaved — opacity applies only where a marker actually is, literal args are untouched", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("zoneA", () => "x;y");
      Detokeniser.addCallback("concat3", ({ args, delimiter }) => String(args.split(delimiter).length));
      await expect(Detokeniser.doAsync("[[concat3;literalX;[[zoneA]];literalY]]")).resolves.toBe("3");
    });

    // ─── Depth + breadth combined ───────────────────────────────────────────────

    it("two nested branches, each itself wrapping a further nested leaf — breadth at the outer level, depth in each branch, neither corrupts the other", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("leafA", () => "1;2");
      Detokeniser.addCallback("leafB", () => "3;4");
      Detokeniser.addCallback("wrap", ({ args }) => args);
      Detokeniser.addCallback("combo", ({ args, delimiter }) => String(args.split(delimiter).length));
      // combo's own split must see exactly 2 parts (the two [[wrap;...]] branches), regardless
      // of the semicolons inside leafA/leafB's real values, which stay hidden behind markers
      // wrap never dereferences.
      await expect(Detokeniser.doAsync("[[combo;[[wrap;[[leafA]]]];[[wrap;[[leafB]]]]]]")).resolves.toBe("2");
    });

    it("the same two-branch, two-deep structure, with real content dereferenced correctly on both branches", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("leafA", () => "1;2");
      Detokeniser.addCallback("leafB", () => "3;4");
      Detokeniser.addCallback("wrap", ({ args }) => args);
      Detokeniser.addCallback("combo2", ({ args, delimiter, resolveMarkers }) => args.split(delimiter).map(resolveMarkers).join(" | "));
      await expect(Detokeniser.doAsync("[[combo2;[[wrap;[[leafA]]]];[[wrap;[[leafB]]]]]]")).resolves.toBe("1;2 | 3;4");
    });

    it("3 siblings nested one level in, then measured as a whole 2 levels up — breadth under depth, fully dereferenced at the top", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("zoneA", () => "x;y");
      Detokeniser.addCallback("zoneB", () => "p;q");
      Detokeniser.addCallback("zoneC", () => "m;n");
      Detokeniser.addCallback("concat3", ({ args, delimiter }) => args.split(delimiter).join(""));
      Detokeniser.addCallback("length", ({ args, resolveMarkers }) => String(resolveMarkers(args).length));
      // concat3 never dereferences — its own marker-laden result becomes length's args, which
      // DOES dereference. "x;y" + "p;q" + "m;n" = "x;yp;qm;n" = 9 characters.
      await expect(Detokeniser.doAsync("[[length;[[concat3;[[zoneA]];[[zoneB]];[[zoneC]]]]]]")).resolves.toBe("9");
    });

    it("two independent top-level tokens, each with its own internal nesting, resolve correctly side by side with no interference", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("leafA", () => "1;2");
      Detokeniser.addCallback("leafB", () => "3;4");
      Detokeniser.addCallback("wrap", ({ args }) => args);
      const result = await Detokeniser.doAsync("A=[[wrap;[[leafA]]]] B=[[wrap;[[leafB]]]]");
      expect(result).toBe("A=1;2 B=3;4");
    });

    it("multiple markers inside a single verb's own qualifier, side by side, both dereferenced correctly", async () => {
      Detokeniser.addCallback("a", () => "1");
      Detokeniser.addCallback("b", () => "2");
      Detokeniser.addCallback("q", ({ qualifier, resolveMarkers }) => `got:${resolveMarkers(qualifier ?? "")}`);
      await expect(Detokeniser.doAsync("[[q([[a]]-[[b]])]]")).resolves.toBe("got:1-2");
    });
  });

  // ─── Processor-output recursion ──────────────────────────────────────────────
  //
  // See utils/docs/design/detokeniser-v2-engine-rewrite.md, "Processor-output recursion". A
  // handler's own returned value is checked for fresh, unescaped token syntax and resolved the
  // same way as input-nesting — not just literal text written directly in the original input.

  describe("Processor-output recursion", () => {
    afterEach(() => {
      Detokeniser.resetCallbacks();
    });

    it("a self-correcting handler's freshly-returned token is resolved by the engine, one level deeper", async () => {
      let firstCall = true;
      Detokeniser.addCallback("selfcorrect", () => {
        if (firstCall) {
          firstCall = false;
          return "[[selfcorrect]]corrected";
        }
        return "final";
      });
      await expect(Detokeniser.doAsync("[[selfcorrect]]")).resolves.toBe("finalcorrected");
    });

    it("a multi-level self-correction chain (3 deep) resolves fully", async () => {
      let remaining = 3;
      Detokeniser.addCallback("countdown", () => {
        remaining--;
        return remaining > 0 ? `[[countdown]]-${remaining}` : "done";
      });
      await expect(Detokeniser.doAsync("[[countdown]]")).resolves.toBe("done-1-2");
    });

    it("an escaped token in a handler's own returned value is left alone (not resolved), then de-escaped once at the final top-level return", async () => {
      Detokeniser.addCallback("loadfile", () => "literal `[[not-a-token`]] here");
      await expect(Detokeniser.doAsync("[[loadfile]]")).resolves.toBe("literal [[not-a-token]] here");
    });

    it("an escaped token revealed by de-escaping a handler's output is not mistaken for a real token even though the text now literally contains [[/]]", async () => {
      Detokeniser.addCallback("loadfile", () => "`[[totallyunrecognised`]]");
      // If the engine mistakenly tried to resolve this as a real token after de-escaping it
      // would throw "Unsupported token" — it must not, because de-escaping only ever happens
      // once, as the very last step, after all token resolution (including recursion) is done.
      await expect(Detokeniser.doAsync("[[loadfile]]")).resolves.toBe("[[totallyunrecognised]]");
    });

    it("recursion applies equally to user-registered callbacks and built-ins — a user callback's self-correction works the same way", async () => {
      let attempts = 0;
      Detokeniser.addCallback("flaky", () => {
        attempts++;
        return attempts < 2 ? "[[flaky]]" : "stable";
      });
      await expect(Detokeniser.doAsync("[[flaky]]")).resolves.toBe("stable");
      expect(attempts).toBe(2);
    });

    it("a handler's own output that merely LOOKS like broken token syntax (incidental, not a typo) falls back to using it literally, logging a Warning, rather than failing the whole call", async () => {
      // A handler whose own generated content (e.g. random|from(...) drawing literal bracket
      // characters from a test-author-chosen pool) happens to contain an unterminated [[, or a
      // verb name nothing claims, is NOT the same situation as a tester typing malformed input
      // directly — see MalformedTokenSyntaxError's own doc comment. Only this one recursion
      // step tolerates it; the same shapes in the original input still throw (see "Malformed
      // input throws" above).
      Detokeniser.addCallback("bracketdata", () => "value=[[unterminated");
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await expect(Detokeniser.doAsync("[[bracketdata]]")).resolves.toBe("value=[[unterminated");
      const warningCall = writeLineSpy.mock.calls.find(([level]) => level === LogLevels.Warning);
      expect(warningCall).toBeDefined();
      vi.restoreAllMocks();
    });

    it("a handler's own output containing a well-formed but unrecognised verb also falls back literally, not a hard failure", async () => {
      Detokeniser.addCallback("bracketdata2", () => "see [[notaregisteredverb]] here");
      await expect(Detokeniser.doAsync("[[bracketdata2]]")).resolves.toBe("see [[notaregisteredverb]] here");
    });

    it("a RecursionDepthExceededError from within a handler's own output is NOT swallowed by this same fallback — it's a hard failure either way", async () => {
      Detokeniser.addCallback("loop", () => "[[loop]]");
      await expect(Detokeniser.doAsync("[[loop]]")).rejects.toThrow(/maxNestingDepth/);
    });

    it("a handler's own thrown validation error (a built-in recognising its own verb and rejecting bad arguments), reached via output recursion, still propagates and is not swallowed by this fallback", async () => {
      // "random" is real, recognised, but "bogus_mode" is invalid for it — reached here via
      // passthrough's own RETURNED value (not the original input), so it's the output-
      // recursion catch block's job to tell this apart from incidental bracket-shaped data.
      // It must still throw.
      Detokeniser.addCallback("passthrough", () => "[[random|bogus_mode|5]]");
      await expect(Detokeniser.doAsync("[[passthrough]]")).rejects.toThrow(/Unrecognised random Type/);
    });
  });

  // ─── escapeOutgoingTokens option ──────────────────────────────────────────────

  describe("escapeOutgoingTokens option", () => {
    afterEach(() => {
      Detokeniser.resetCallbacks();
    });

    it("defaults to false — literal brackets revealed by de-escaping are left as plain text", async () => {
      Detokeniser.addCallback("loadfile", () => "contains `[[literal`]] brackets");
      const result = await Detokeniser.doAsync("[[loadfile]]");
      expect(result).toBe("contains [[literal]] brackets");
    });

    it("when true, escapes every literal [[/]] in the final result, after de-escaping has already revealed them", async () => {
      Detokeniser.addCallback("loadfile", () => "contains `[[literal`]] brackets");
      const result = await Detokeniser.doAsync("[[loadfile]]", { escapeOutgoingTokens: true });
      expect(result).toBe("contains `[[literal`]] brackets");
    });

    it("escapes a literal bracket sequence regardless of how it got there — a blind rescan, not provenance-tracked", async () => {
      // This handler never used escaping at all — the literal [[/]] in its own return value
      // would normally be re-interpreted as a fresh token and throw (nothing registered for
      // "incidental"), so to exercise the blind-rescan behaviour on content that's already
      // plain by the time escapeOutgoingTokens runs, de-escape a deliberately-escaped sequence
      // first, same as the "defaults to false" test, then confirm escapeOutgoingTokens still
      // catches it even though its origin (a de-escaped token) is irrelevant to the rescan.
      Detokeniser.addCallback("loadfile", () => "`[[incidental`]] and `[[another`]]");
      const result = await Detokeniser.doAsync("[[loadfile]]", { escapeOutgoingTokens: true });
      expect(result).toBe("`[[incidental`]] and `[[another`]]");
    });

    it("fires exactly once, on the top-level result only — a nested token's own intermediate resolution is not separately escaped", async () => {
      Detokeniser.addCallback("inner", () => "`[[x`]]");
      Detokeniser.addCallback("outer", ({ args }) => `wrapped-${args}`);
      const result = await Detokeniser.doAsync("[[outer|[[inner]]]]", { escapeOutgoingTokens: true });
      // If this fired more than once (e.g. once per nesting level), the already-escaped
      // sequence would get double-escaped ("``[[x``]]"). It must not.
      expect(result).toBe("wrapped-`[[x`]]");
    });
  });

  // ─── Qualifier — nesting ──────────────────────────────────────────────────────

  describe("Qualifier nesting", () => {
    afterEach(() => {
      Detokeniser.resetCallbacks();
    });

    it("a token can be nested inside a verb's own parenthesised qualifier", async () => {
      Detokeniser.addCallback("inner", () => "nsw");
      Detokeniser.addCallback("q", ({ qualifier }) => `zone:${qualifier}`);
      await expect(Detokeniser.doAsync("[[q([[inner]])]]")).resolves.toBe("zone:nsw");
    });

    it("random|from(...) accepting a nested token as its pool, exactly as date's own addDays(...) can", async () => {
      Detokeniser.addCallback("pool", () => "xyz");
      await expect(Detokeniser.doAsync("[[random|from([[pool]])|3]]")).resolves.toMatch(/^[xyz]{3}$/);
      Detokeniser.resetCallbacks();
    });
  });

  // ─── Structural parsing — single-pass, stack-based boundary scanning ────────

  describe("Structural parsing", () => {
    it("nesting and multiple sibling tokens in the same string both resolve correctly together", async () => {
      Detokeniser.delimiter = ";";
      const result = await Detokeniser.doAsync(
        "Order [[random;digits;4]] placed on [[date;today;yyyy-MM-dd]], ships by " +
        "[[date;addDays([[random;digits;1]]);dd-MM-yyyy]], ref [[random;uppercaseletters;3]]"
      );
      expect(result).toMatch(/^Order \d{4} placed on \d{4}-\d{2}-\d{2}, ships by \d{2}-\d{2}-\d{4}, ref [A-Z]{3}$/);
    });

    it("a verb's own output containing delimiter-shaped punctuation never corrupts a sibling token elsewhere in the same string, across many random draws", async () => {
      Detokeniser.delimiter = ";";
      // Drawing from a pool of structurally-significant punctuation (the delimiter plus
      // several other grammar-significant characters — deliberately excluding quotes/parens,
      // which have their OWN special meaning inside random|from(...)'s own grammar and would
      // test that instead of this) as a SIBLING (not nested) token, immediately followed by a
      // genuine, unrelated date token — neither should ever affect the other, regardless of
      // which punctuation the random draw happens to produce.
      for (let i = 0; i < 100; i++) {
        const result = await Detokeniser.doAsync("before [[random;from(;:!?&~^);2]] after [[date;today;yyyy]]");
        expect(result).toMatch(/^before .{2} after \d{4}$/);
      }
    });

    it("a verb's own output containing delimiter-shaped punctuation, nested inside another verb's own split, never corrupts that split", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("concat", ({ args, delimiter }) => String(args.split(delimiter).length));
      for (let i = 0; i < 100; i++) {
        const result = await Detokeniser.doAsync("[[concat;[[random;from(;:!?&~^);2]];suffix]]");
        expect(result).toBe("2");
      }
      Detokeniser.resetCallbacks();
    });
  });

  // ─── tokenStartStop — every boundary-sensitive test, repeated under all 4 allow-listed
  //     boundaries ────────────────────────────────────────────────────────────────────────
  //
  // Everything above uses the default [[]] boundary throughout (the suite-wide beforeEach pin
  // — see the top-of-suite note). The tests in this block are the ones where the boundary
  // characters are actually load-bearing — scanning, escaping, nesting, markers/opacity,
  // malformed-input throws, qualifier parsing — run again under every one of
  // Detokeniser._allowedTokenStartStops's 4 members (including the real default, "<%%>", and
  // "[[]]" explicitly rather than relying only on the implicit pin) to prove the mechanism is
  // genuinely boundary-agnostic, not just "happens to work for whichever one was tested." One
  // deterministic proof-of-wiring per built-in is included too, but NOT each built-in's own
  // internal business logic (random's float precision, date's day-math, diff's timezone
  // offsets, etc.) — that logic is entirely orthogonal to which boundary is active, already
  // covered exhaustively above, and quadruplicating it here would be pure bloat with no added
  // confidence.

  describe.each([
    { label: "<% %> (default)", open: "<%", close: "%>" },
    { label: "[[ ]]", open: "[[", close: "]]" },
    { label: "{{ }}", open: "{{", close: "}}" },
    { label: "<< >>", open: "<<", close: ">>" },
  ])("tokenStartStop = $label", ({ open, close }) => {
    beforeEach(() => {
      Detokeniser.tokenStartStop = open + close;
    });

    it("is reported back correctly by the getter", () => {
      expect(Detokeniser.tokenStartStop).toBe(open + close);
    });

    // ─ Basic string manipulation ─
    it("no token in string", async () => {
      await expect(Detokeniser.doAsync("No token here")).resolves.toStrictEqual("No token here");
    });

    it("string with escaped token opener and closer", async () => {
      await expect(Detokeniser.doAsync(`No \`${open}token\`${close} here`)).resolves.toStrictEqual(`No ${open}token${close} here`);
    });

    it("string with escaped escape then escaped token opener and closer", async () => {
      await expect(Detokeniser.doAsync(`No \`\`\`${open}token\`${close} here`)).resolves.toStrictEqual(`No \`${open}token${close} here`);
    });

    it("non-token text preserved around a resolved token", async () => {
      await expect(Detokeniser.doAsync(`PREFIX-${open}random|digits|4${close}-SUFFIX`)).resolves.toMatch(/^PREFIX-\d{4}-SUFFIX$/);
    });

    it("an even-length escape run immediately before a REAL, resolved token boundary doesn't stop the token resolving, and is left untouched afterward", async () => {
      await expect(Detokeniser.doAsync(`No \`\`${open}random|digits|1${close} here`)).resolves.toMatch(/^No ``\d here$/);
    });

    // ─ Malformed input throws ─
    it("an opener with no matching closer throws", async () => {
      await expect(Detokeniser.doAsync(`No token ${open}here`)).rejects.toThrow(/unterminated/i);
    });

    it("a closer with no matching opener throws", async () => {
      await expect(Detokeniser.doAsync(`No token ${close}here`)).rejects.toThrow(/unmatched/i);
    });

    it("an unrecognised verb throws, naming the verb", async () => {
      await expect(Detokeniser.doAsync(`${open}unknown${close}`)).rejects.toThrow(/Unsupported token \[unknown\]/);
    });

    it("an empty token body throws", async () => {
      await expect(Detokeniser.doAsync(`${open}${close}`)).rejects.toThrow(/Empty token/);
    });

    it("a never-closed opener throws, even with a well-formed sibling token present", async () => {
      await expect(Detokeniser.doAsync(`before ${open}unclosed and ${open}random|digits|2${close} after`)).rejects.toThrow(/unterminated/i);
    });

    // ─ Debug logging ─
    it("logs one 'Processed [token] to [result]' line, using the active boundary in the raw-token text", async () => {
      Log.loggingLevel = LogLevels.TestDebug;
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      const result = await Detokeniser.doAsync(`Ref-${open}random|digits|4${close}`);
      const call = writeLineSpy.mock.calls.find(
        ([level, message]) => level === LogLevels.TestDebug && (message as string).startsWith(`Processed [${open}random|digits|4${close}]`)
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBe(`Processed [${open}random|digits|4${close}] to [${result.replace("Ref-", "")}]`);
      vi.restoreAllMocks();
    });

    // ─ Nesting ─
    it("nested tokens resolve innermost first", async () => {
      const result = await Detokeniser.doAsync(`${open}date|addDays(${open}random|digits|1${close})|dd-MM-yyyy${close}`);
      expect(result).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    });

    it("nesting and multiple sibling tokens in the same string both resolve correctly together", async () => {
      Detokeniser.delimiter = ";";
      const result = await Detokeniser.doAsync(
        `Order ${open}random;digits;4${close} placed on ${open}date;today;yyyy-MM-dd${close}, ships by ` +
        `${open}date;addDays(${open}random;digits;1${close});dd-MM-yyyy${close}, ref ${open}random;uppercaseletters;3${close}`
      );
      expect(result).toMatch(/^Order \d{4} placed on \d{4}-\d{2}-\d{2}, ships by \d{2}-\d{2}-\d{4}, ref [A-Z]{3}$/);
    });

    // ─ Qualifier parsing ─
    it("a verb qualifier is extracted — first unescaped ')' ends it", async () => {
      let capturedQualifier: string | undefined;
      Detokeniser.addCallback("someverb", ({ qualifier }) => {
        capturedQualifier = qualifier;
        return "ok";
      });
      await Detokeniser.doAsync(`${open}someverb(ddd(sd)|arg1|arg2${close}`);
      expect(capturedQualifier).toBe("ddd(sd");
      Detokeniser.resetCallbacks();
    });

    it("nesting is legal inside a verb's own qualifier", async () => {
      Detokeniser.addCallback("inner", () => "nsw");
      Detokeniser.addCallback("q", ({ qualifier }) => `zone:${qualifier}`);
      await expect(Detokeniser.doAsync(`${open}q(${open}inner${close})${close}`)).resolves.toBe("zone:nsw");
      Detokeniser.resetCallbacks();
    });

    // ─ Opacity / markers ─
    it("a verb that does its own naive delimiter split sees exactly the parts it expects, never corrupted by a nested value's own delimiter characters", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("mysetting", () => "hello;I;Am;mat");
      Detokeniser.addCallback("concat", ({ args, delimiter }) => String(args.split(delimiter).length));
      await expect(Detokeniser.doAsync(`${open}concat;${open}mysetting${close};suffix${close}`)).resolves.toBe("2");
      Detokeniser.resetCallbacks();
    });

    it("breadth + depth combined: 3 siblings nested one level in, then measured as a whole 2 levels up", async () => {
      Detokeniser.delimiter = ";";
      Detokeniser.addCallback("zoneA", () => "x;y");
      Detokeniser.addCallback("zoneB", () => "p;q");
      Detokeniser.addCallback("zoneC", () => "m;n");
      Detokeniser.addCallback("concat3", ({ args, delimiter }) => args.split(delimiter).join(""));
      Detokeniser.addCallback("length", ({ args, resolveMarkers }) => String(resolveMarkers(args).length));
      const result = await Detokeniser.doAsync(
        `${open}length;${open}concat3;${open}zoneA${close};${open}zoneB${close};${open}zoneC${close}${close}${close}`
      );
      expect(result).toBe("9");
      Detokeniser.resetCallbacks();
    });

    // ─ Processor-output recursion ─
    it("a self-correcting handler's freshly-returned token is resolved by the engine, one level deeper", async () => {
      let firstCall = true;
      Detokeniser.addCallback("selfcorrect", () => {
        if (firstCall) {
          firstCall = false;
          return `${open}selfcorrect${close}corrected`;
        }
        return "final";
      });
      await expect(Detokeniser.doAsync(`${open}selfcorrect${close}`)).resolves.toBe("finalcorrected");
      Detokeniser.resetCallbacks();
    });

    it("an escaped token in a handler's own returned value is left alone, then de-escaped once at the final top-level return", async () => {
      Detokeniser.addCallback("loadfile", () => `literal \`${open}not-a-token\`${close} here`);
      await expect(Detokeniser.doAsync(`${open}loadfile${close}`)).resolves.toBe(`literal ${open}not-a-token${close} here`);
      Detokeniser.resetCallbacks();
    });

    it("a handler's own malformed-looking output (incidental, not a typo) falls back to using it literally rather than failing the whole call", async () => {
      Detokeniser.addCallback("bracketdata", () => `value=${open}unterminated`);
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      await expect(Detokeniser.doAsync(`${open}bracketdata${close}`)).resolves.toBe(`value=${open}unterminated`);
      const warningCall = writeLineSpy.mock.calls.find(([level]) => level === LogLevels.Warning);
      expect(warningCall).toBeDefined();
      vi.restoreAllMocks();
      Detokeniser.resetCallbacks();
    });

    it("maxNestingDepth guards a handler whose output resolves back into itself, under this boundary too", async () => {
      Detokeniser.addCallback("loop", () => `${open}loop${close}`);
      await expect(Detokeniser.doAsync(`${open}loop${close}`)).rejects.toThrow(/maxNestingDepth/);
      Detokeniser.resetCallbacks();
    });

    // ─ escapeOutgoingTokens ─
    it("escapeOutgoingTokens escapes a literal boundary sequence revealed by de-escaping, using the active boundary's own characters", async () => {
      Detokeniser.addCallback("loadfile", () => `contains \`${open}literal\`${close} brackets`);
      const result = await Detokeniser.doAsync(`${open}loadfile${close}`, { escapeOutgoingTokens: true });
      expect(result).toBe(`contains \`${open}literal\`${close} brackets`);
    });

    // ─ The 2D-JSON-array motivating case ─
    it("the 2D-JSON-array collision this setting exists for — present under [[]] (documented, by design), avoided entirely under every other boundary", async () => {
      Detokeniser.addCallback("myval", () => "99");
      const body = `{"data":[[1,2],[3,${open}myval${close}]]}`;
      if (open === "[[") {
        // [[]] is the boundary this exact collision motivated the whole setting to route
        // around — the array's own incidental [[/]] adjacency really is indistinguishable
        // from a bogus token here, so this one case is expected to throw, not a regression.
        await expect(Detokeniser.doAsync(body)).rejects.toThrow(/Unsupported token/);
      } else {
        await expect(Detokeniser.doAsync(body)).resolves.toBe('{"data":[[1,2],[3,99]]}');
      }
      Detokeniser.resetCallbacks();
    });

    // ─ One proof-of-wiring per built-in (not each built-in's own internal logic) ─
    it("random", async () => {
      await expect(Detokeniser.doAsync(`${open}random|digits|4${close}`)).resolves.toMatch(/^\d{4}$/);
    });

    it("date", async () => {
      await expect(Detokeniser.doAsync(`${open}date|today|yyyy-MM-dd${close}`)).resolves.toBe(format(new Date(), "yyyy-MM-dd"));
    });

    it("timezone", async () => {
      await expect(Detokeniser.doAsync(`${open}timezone|Europe/London${close}`)).resolves.toBe("Europe/London");
    });

    it("diff", async () => {
      await expect(Detokeniser.doAsync(`${open}diff|UTC|UTC${close}`)).resolves.toBe("0");
    });

    it("base64", async () => {
      await expect(Detokeniser.doAsync(`${open}base64|encode|Hello World${close}`)).resolves.toBe("SGVsbG8gV29ybGQ=");
    });

    it("jwt", async () => {
      const result = await Detokeniser.doAsync(`${open}jwt|{"sub":"1234"}|MySecret${close}`);
      expect(result.split(".").length).toBe(3);
    });

    it("setting", async () => {
      const result = await Detokeniser.doAsync(`${open}setting|profileParameterName: "myParam"${close}`, {
        contextParameters: { myParam: "contextValue" },
      });
      expect(result).toBe("contextValue");
    });

    it("mockintercepts", async () => {
      await expect(Detokeniser.doAsync(`${open}mockintercepts|$.requests[0].body.id${close}`)).rejects.toThrow(
        "No Mock Intercepted requests to harvest from!?"
      );
    });

    it("a user-registered callback overriding a built-in", async () => {
      Detokeniser.addCallback("date", () => "OVERRIDDEN");
      await expect(Detokeniser.doAsync(`${open}date|today|yyyy${close}`)).resolves.toBe("OVERRIDDEN");
      Detokeniser.resetCallbacks();
    });

    // ─ The rest of "Malformed input throws" ─
    describe("Malformed input throws (remaining cases)", () => {
      it("a callback declining with nothing else registered for that verb throws", async () => {
        Detokeniser.addCallback("anything", () => undefined);
        await expect(Detokeniser.doAsync(`${open}anything${close}`)).rejects.toThrow(/Unsupported token/);
        Detokeniser.resetCallbacks();
      });

      it("a JSON 2D array throws under [[]] (the exact collision this setting exists for) but isn't trouble at all under any other boundary — there's no [[/]] in it to collide with otherwise", async () => {
        const body = `{"data":[[1,2],[3,4]]}`;
        if (open === "[[") {
          // The array's own incidental [[/]] adjacency really is indistinguishable from a
          // bogus token under this specific boundary — expected, by design, not a regression.
          await expect(Detokeniser.doAsync(body)).rejects.toThrow(/Unsupported token/);
        } else {
          // Zero "{{"/"}}" or "<<"/">>" or "<%"/"%>" adjacency in this data, so under every
          // other boundary it's just ordinary, unresolved literal text — no ambiguity exists.
          await expect(Detokeniser.doAsync(body)).resolves.toBe(body);
        }
      });

      it("a stray closer with no open token throws, even with a well-formed sibling token present", async () => {
        await expect(Detokeniser.doAsync(`${close} ${open}random|digits|3${close}`)).rejects.toThrow(/unmatched/i);
      });

      it("an unterminated verb qualifier throws a clear error", async () => {
        Detokeniser.addCallback("someverb", () => "ok");
        await expect(Detokeniser.doAsync(`${open}someverb(unterminated|arg${close}`)).rejects.toThrow(/Unterminated/);
        Detokeniser.resetCallbacks();
      });

      it("a non-string input, while enabled, is rejected by the usual type assertion rather than silently accepted", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(Detokeniser.doAsync(42 as any)).rejects.toThrow(/tokenisedString/);
      });

      it("a handler's own malformed output that falls back to literal can still contain an even-length escape run surviving right next to the now-literal boundary — de-escape still collapses it pairwise", async () => {
        Detokeniser.addCallback("bracketdata3", () => `a\`\`${open}b`);
        await expect(Detokeniser.doAsync(`${open}bracketdata3${close}`)).resolves.toBe(`a\`${open}b`);
        Detokeniser.resetCallbacks();
      });
    });

    // ─ The rest of "Random token" ─
    describe("Random token (remaining cases)", () => {
      it("float - 1 decimal place, no rounding", async () => {
        await expect(Detokeniser.doAsync(`${open}random|float(100.4999,100.4999)|1${close}`)).resolves.toMatch(/^100\.4$/);
        await expect(Detokeniser.doAsync(`${open}random|float(100.5,100.5)|2${close}`)).resolves.toMatch(/^100\.50$/);
      });

      it("float - 2 decimal places", async () => {
        await expect(Detokeniser.doAsync(`${open}random|float(100.3,100.4999)|2${close}`)).resolves.toMatch(/^100\.[34]\d$/);
      });

      it("from - single char from numeric set", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from(1234567890)|1${close}`)).resolves.toMatch(/^\d$/);
      });

      it("from - 5 chars from alpha set", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from(abcd)|5${close}`)).resolves.toMatch(/^[abcd]{5}$/);
      });

      it("from - with escaped token opener inside paren content", async () => {
        // A single backtick-escape protects only the FIRST character of `open` from the outer
        // scan's own boundary check — the second character (if `open` isn't a doubled single
        // char, e.g. "<%") still falls through as an ordinary pool character afterward. The
        // expected character class is every unique character in `open`, not just open[0].
        const openChars = [...new Set(open.split(""))].join("");
        await expect(Detokeniser.doAsync(`${open}random|from(ab\`${open})|3${close}`)).resolves.toMatch(new RegExp(`^[ab${openChars}]{3}$`));
      });

      it("from - quoted string list, single quotes, picks one whole item", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('cat','dog')|3${close}`)).resolves.toMatch(/^(cat|dog)$/);
      });

      it("from - quoted string list, mixed single and double quotes per item", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('cat',"dog")|3${close}`)).resolves.toMatch(/^(cat|dog)$/);
      });

      it("from - quoted string list, incidental whitespace tolerated around comma and before first item", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from( 'cat' , 'dog' )|3${close}`)).resolves.toMatch(/^(cat|dog)$/);
      });

      it("from - quoted string list, escaped same-type quote inside an item", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('he\`'llo')|6${close}`)).resolves.toBe("he'llo");
      });

      it("from - quoted string list, opposite quote type inside an item needs no escaping", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from("he'llo")|6${close}`)).resolves.toBe("he'llo");
      });

      it("from - quoted string list, literal ')' inside an item doesn't end the call early", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('he)llo')|6${close}`)).resolves.toBe("he)llo");
      });

      it("from - quoted string list, <length> is a maximum total — an overshooting draw is never truncated, the fill loop just stops before adding it", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('1234567','123','12345')|5${close}`)).resolves.toMatch(/^(|123|12345)$/);
      });

      it("from - quoted string list, a cap shorter than every item always resolves to empty", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('true','false')|3${close}`)).resolves.toBe("");
      });

      it("from - quoted string list, an empty item stops the fill loop rather than looping forever", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('','bye')|5${close}`)).resolves.toMatch(/^(|bye)$/);
      });

      it("from - trailing content after a validly-closed call throws, naming the real cause instead of 'invalid length'", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('he')llo')|5${close}`)).rejects.toThrow(
          /Trailing content after a from\(\.\.\.\)\/float\(\.\.\.\)\/date\(\.\.\.\) call.*found: \[llo'\)\|5\]/
        );
      });

      it("from - character-pool mode, omitted length defaults to a single random character", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from(abcd)${close}`)).resolves.toMatch(/^[abcd]$/);
      });

      it("from - quoted string list, omitted length picks exactly one whole item, uncapped", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('cat','dog')${close}`)).resolves.toMatch(/^(cat|dog)$/);
      });

      it("from - quoted string list, omitted length is never truncated even for a long item", async () => {
        await expect(Detokeniser.doAsync(`${open}random|from('1234567')${close}`)).resolves.toBe("1234567");
      });

      it("named set (not from(...)), omitted length defaults to a single random character", async () => {
        await expect(Detokeniser.doAsync(`${open}random|digits${close}`)).resolves.toMatch(/^\d$/);
      });

      it("digits - 1 character", async () => {
        await expect(Detokeniser.doAsync(`${open}random|digits|1${close}`)).resolves.toMatch(/^[0-9]$/);
      });

      it("digits - 4 characters", async () => {
        await expect(Detokeniser.doAsync(`${open}random|digits|4${close}`)).resolves.toMatch(/^[0-9]{4}$/);
      });

      it("letters - 1 character", async () => {
        await expect(Detokeniser.doAsync(`${open}random|letters|1${close}`)).resolves.toMatch(/^[a-zA-Z]$/);
      });

      it("letters - 5 characters", async () => {
        await expect(Detokeniser.doAsync(`${open}random|letters|5${close}`)).resolves.toMatch(/^[a-zA-Z]{5}$/);
      });

      it("lowercaseletters - 6 characters", async () => {
        await expect(Detokeniser.doAsync(`${open}random|lowercaseletters|6${close}`)).resolves.toMatch(/^[a-z]{6}$/);
      });

      it("uppercaseletters - 10 characters", async () => {
        await expect(Detokeniser.doAsync(`${open}random|uppercaseletters|10${close}`)).resolves.toMatch(/^[A-Z]{10}$/);
      });

      it("alphanumerics - 10 characters", async () => {
        await expect(Detokeniser.doAsync(`${open}random|alphanumerics|10${close}`)).resolves.toMatch(/^[0-9a-zA-Z]{10}$/);
      });

      it("date - fixed range, formatted", async () => {
        await expect(Detokeniser.doAsync(`${open}random|date(21600000,21660000)|dd-MM-yyyy${close}`)).resolves.toMatch(/^01-01-1970$/);
      });

      it("date - range returned as epoch within bounds", async () => {
        const result = parseInt(await Detokeniser.doAsync(`${open}random|date(21600000,108000000)|epoch${close}`));
        expect(result).toBeGreaterThanOrEqual(21600000);
        expect(result).toBeLessThanOrEqual(108000000);
      });

      it("type/length nested inside a verb whose own output contains the delimiter character — opacity protects random's own split", async () => {
        Detokeniser.addCallback("poolwithdelim", () => "ab|cd");
        await expect(Detokeniser.doAsync(`${open}random|from(${open}poolwithdelim${close})|3${close}`)).resolves.toMatch(/^[abcd|]{3}$/);
        Detokeniser.resetCallbacks();
      });
    });

    // ─ The rest of "Date token" ─
    describe("Date token (remaining cases)", () => {
      it("fixed date as epoch", async () => {
        await expect(Detokeniser.doAsync(`${open}date|2013-4-5|epoch${close}`)).resolves.toBe("1365120000000");
      });

      it("fixed date as second-epoch", async () => {
        await expect(Detokeniser.doAsync(`${open}date|2013-4-5|second-epoch${close}`)).resolves.toBe("1365120000");
      });

      it("fixed date formatted", async () => {
        await expect(Detokeniser.doAsync(`${open}date|2013-4-5|MM=dd=yyyy${close}`)).resolves.toBe("04=05=2013");
      });

      it("today returns today", async () => {
        const result = await Detokeniser.doAsync(`${open}date|today|yyyy-MM-dd${close}`);
        expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
      });

      it("now returns today", async () => {
        const result = await Detokeniser.doAsync(`${open}date|now|yyyy-MM-dd${close}`);
        expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
      });

      it("yesterday", async () => {
        const result = await Detokeniser.doAsync(`${open}date|yesterday|yyyy-MM-dd${close}`);
        expect(result).toBe(format(addDays(new Date(), -1), "yyyy-MM-dd"));
      });

      it("tomorrow", async () => {
        const result = await Detokeniser.doAsync(`${open}date|tomorrow|yyyy-MM-dd${close}`);
        expect(result).toBe(format(addDays(new Date(), 1), "yyyy-MM-dd"));
      });

      it("addYears", async () => {
        const result = await Detokeniser.doAsync(`${open}date|AddYears(3)|EEE MMM dd yyyy${close}`);
        expect(result).toBe(format(addYears(new Date(), 3), "EEE MMM dd yyyy"));
      });

      it("addMonths", async () => {
        const result = await Detokeniser.doAsync(`${open}date|AddMonths(3)|EEE MMM dd yyyy${close}`);
        expect(result).toBe(format(addMonths(new Date(), 3), "EEE MMM dd yyyy"));
      });

      it("addDays", async () => {
        const result = await Detokeniser.doAsync(`${open}date|AddDays(3)|EEE MMM dd yyyy${close}`);
        expect(result).toBe(format(addDays(new Date(), 3), "EEE MMM dd yyyy"));
      });

      it("addHours", async () => {
        const result = await Detokeniser.doAsync(`${open}date|AddHours(0)|yyyy-MM-dd${close}`);
        expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
      });

      it("addMinutes", async () => {
        const result = await Detokeniser.doAsync(`${open}date|AddMinutes(0)|yyyy-MM-dd${close}`);
        expect(result).toBe(format(new Date(), "yyyy-MM-dd"));
      });

      it("random date within a fixed epoch range", async () => {
        const result = await Detokeniser.doAsync(`${open}date|random(946684800000,946771200000)|yyyy-MM-dd${close}`);
        expect(result).toMatch(/^2000-01-0[12]$/);
      });

      it("followingDay - following Friday after Sunday 2013-04-07 is 2013-04-12", async () => {
        await expect(Detokeniser.doAsync(`${open}date|followingDay(1365292800000,friday)|yyyy-MM-dd${close}`)).resolves.toBe("2013-04-12");
      });

      it("zone-aware: epoch format is unaffected by the zone (epoch has no timezone)", async () => {
        const result = await Detokeniser.doAsync(`${open}date|2013-4-5|epoch|UTC${close}`);
        expect(result).toBe("1365120000000");
      });

      it("zone-aware: fixed date formatted in a given IANA zone", async () => {
        const result = await Detokeniser.doAsync(`${open}date|2013-4-5|yyyy-MM-dd HH:mm|Pacific/Auckland${close}`);
        expect(result).toBe("2013-04-05 13:00");
      });

      it("zone-aware: invalid zone name throws a clear error", async () => {
        await expect(Detokeniser.doAsync(`${open}date|today|yyyy-MM-dd|Not/AZone${close}`)).rejects.toThrow(/not a recognised IANA timezone/);
      });

      it("invalid date verb throws", async () => {
        await expect(Detokeniser.doAsync(`${open}date|addWorkingDays(5)|dd-MM-yyyy${close}`)).rejects.toThrow("Invalid date verb");
      });

      it("nested tokens resolve innermost first", async () => {
        const result = await Detokeniser.doAsync(
          `${open}date|random(${open}date|2000-01-01|epoch${close},${open}date|2000-01-02|epoch${close})|yyyy-MM-dd${close}`
        );
        expect(result).toMatch(/^2000-01-0[12]$/);
      });

      it("random digit nested inside date addDays", async () => {
        const result = await Detokeniser.doAsync(`${open}date|addDays(${open}random|digits|1${close})|yyyy-MM-dd${close}`);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it("date-fns literal-text quoting in the format argument is unaffected", async () => {
        const result = await Detokeniser.doAsync(`${open}date|today|'T'HH:mm${close}`);
        expect(result).toBe(format(new Date(), "'T'HH:mm"));
      });

      it("a nested token's output supplying the IANA zone resolves to its real value, not a leftover marker", async () => {
        Detokeniser.addCallback("myzone", () => "Pacific/Auckland");
        const result = await Detokeniser.doAsync(`${open}date|2013-4-5|yyyy-MM-dd HH:mm|${open}myzone${close}${close}`);
        expect(result).toBe("2013-04-05 13:00");
        Detokeniser.resetCallbacks();
      });
    });

    // ─ The rest of "timezone token" ─
    it("timezone: invalid zone name throws a clear error", async () => {
      await expect(Detokeniser.doAsync(`${open}timezone|Nowhere/Fake${close}`)).rejects.toThrow(/not a recognised IANA timezone/);
    });

    // ─ The rest of "diff token" ─
    describe("diff token (remaining cases)", () => {
      it("a zone diffed against itself is zero", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|Europe/London|Europe/London${close}`)).resolves.toBe("0");
      });

      it("UTC offset of a fixed-offset zone", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|Pacific/Kiritimati|UTC${close}`)).resolves.toBe("14");
      });

      it("quarter-hour-offset zone produces a decimal result", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|Asia/Kathmandu|UTC${close}`)).resolves.toBe("5.75");
      });

      it("argument order is significant (sign flips)", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|UTC|Pacific/Kiritimati${close}`)).resolves.toBe("-14");
      });

      it("nested inside timezone tokens", async () => {
        await expect(
          Detokeniser.doAsync(`${open}diff|${open}timezone|Pacific/Kiritimati${close}|${open}timezone|UTC${close}${close}`)
        ).resolves.toBe("14");
      });

      it("missing second zone throws", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|UTC${close}`)).rejects.toThrow(/needs 2 IANA zone names/);
      });

      it("invalid zone name throws a clear error", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|UTC|Nowhere/Fake${close}`)).rejects.toThrow(/not a recognised IANA timezone/);
      });

      it("the first zone can be quoted — proves the quote-aware wiring", async () => {
        await expect(Detokeniser.doAsync(`${open}diff|'Pacific/Kiritimati'|UTC${close}`)).resolves.toBe("14");
      });
    });

    // ─ The rest of "BASE64 token" ─
    describe("BASE64 token (remaining cases)", () => {
      it("encode", async () => {
        const value = "Hello World";
        const encoded = await Detokeniser.doAsync(`${open}base64|encode|${value}${close}`);
        expect(Buffer.from(encoded, "base64").toString()).toBe(value);
      });

      it("encode value containing pipe character", async () => {
        const value = "Hello|World";
        const encoded = await Detokeniser.doAsync(`${open}base64|encode|${value}${close}`);
        expect(Buffer.from(encoded, "base64").toString()).toBe(value);
      });

      it("decode", async () => {
        const value = "Hello World";
        const encoded = Buffer.from(value).toString("base64");
        await expect(Detokeniser.doAsync(`${open}base64|decode|${encoded}${close}`)).resolves.toBe(value);
      });

      it("decode value containing pipe character in original", async () => {
        const value = "Hello|World";
        const encoded = Buffer.from(value).toString("base64");
        await expect(Detokeniser.doAsync(`${open}base64|decode|${encoded}${close}`)).resolves.toBe(value);
      });

      it("encode/decode roundtrip via nested tokens", async () => {
        const value = "roundtrip test 123";
        const encoded = await Detokeniser.doAsync(`${open}base64|encode|${value}${close}`);
        const decoded = await Detokeniser.doAsync(`${open}base64|decode|${encoded}${close}`);
        expect(decoded).toBe(value);
      });

      it("invalid direction throws", async () => {
        await expect(Detokeniser.doAsync(`${open}base64|baddir|something${close}`)).rejects.toThrow();
      });

      it("opacity: a nested token's value containing the delimiter character encodes correctly in full", async () => {
        Detokeniser.addCallback("nastyvalue", () => "a|b|c");
        const encoded = await Detokeniser.doAsync(`${open}base64|encode|${open}nastyvalue${close}${close}`);
        expect(Buffer.from(encoded, "base64").toString()).toBe("a|b|c");
        Detokeniser.resetCallbacks();
      });
    });

    // ─ The rest of "JWT token" ─
    //
    // Skipped specifically under {{}} — not a bug to work around, but the exact collision risk
    // the tokenStartStop allow-list's own doc comment already documents: jwt's payload/options
    // are raw, unquoted JSON *objects*, and {{}} collides with nested JSON objects the same way
    // [[]] collides with nested JSON arrays. `...{"algorithm":"HS256"}` immediately followed by
    // the token's own closing `}}` gives 3 adjacent '}' characters; the scanner matches the
    // first "}}" it finds, one character before the real end, truncating the options JSON and
    // throwing a parse error. <<>> has no such collision (confirmed — every one of these tests
    // passes under it) and is the boundary to prefer for JSON-heavy payloads like these.
    (open === "{{" ? describe.skip : describe)("JWT token (remaining cases)", () => {
      it("full JWT with payload, signature and options", async () => {
        const result = await Detokeniser.doAsync(`${open}jwt|{"sub":"1234","name":"Test"}|MySecret|{"algorithm":"HS256"}${close}`);
        expect(result).toBeDefined();
        expect(result.split(".").length).toBe(3);
      });

      it("JWT with payload and signature, no options", async () => {
        const result = await Detokeniser.doAsync(`${open}jwt|{"sub":"1234"}|MySecret${close}`);
        expect(result).toBeDefined();
        expect(result.split(".").length).toBe(3);
      });

      it("JWT with payload only, no signature or options", async () => {
        const result = await Detokeniser.doAsync(`${open}jwt|{"sub":"1234","name":"Test"}${close}`);
        expect(result).toBeDefined();
        expect(result.split(".").length).toBe(3);
      });

      it("a quoted payload can carry a literal pipe character the JSON value itself needs", async () => {
        const result = await Detokeniser.doAsync(`${open}jwt|'{"sub":"a|b"}'|MySecret${close}`);
        const decodedPayload = JSON.parse(Buffer.from(result.split(".")[1], "base64url").toString());
        expect(decodedPayload.sub).toBe("a|b");
      });

      it("opacity: a nested token's payload value containing the delimiter character needs no quoting at all", async () => {
        Detokeniser.addCallback("nastypayload", () => `{"sub":"a|b"}`);
        const result = await Detokeniser.doAsync(`${open}jwt|${open}nastypayload${close}|MySecret${close}`);
        const decodedPayload = JSON.parse(Buffer.from(result.split(".")[1], "base64url").toString());
        expect(decodedPayload.sub).toBe("a|b");
        Detokeniser.resetCallbacks();
      });
    });

    // ─ The rest of "Setting token" ─
    describe("Setting token (remaining cases)", () => {
      it("invalid postamble (not key:value JSON) throws", async () => {
        await expect(Detokeniser.doAsync(`${open}setting|invalid${close}`)).rejects.toThrow();
      });

      it("reads from process env", async () => {
        const envName = "DETOKENISER_SPEC_TEST_VAR";
        const envValue = "hello from env";
        process.env[envName] = envValue;
        try {
          await expect(Detokeniser.doAsync(`${open}setting|processEnvName: "${envName}"${close}`)).resolves.toBe(envValue);
        } finally {
          delete process.env[envName];
        }
      });

      it("reads from contextParameters", async () => {
        const result = await Detokeniser.doAsync(`${open}setting|profileParameterName: "myParam"${close}`, {
          contextParameters: { myParam: "contextValue" },
        });
        expect(result).toBe("contextValue");
      });

      it("uses defaultValue when env var not set", async () => {
        const result = await Detokeniser.doAsync(
          `${open}setting|processEnvName: "DETOKENISER_SPEC_DEFINITELY_NOT_SET_XYZ", defaultValue: "fallback"${close}`
        );
        expect(result).toBe("fallback");
      });
    });

    // ─ The rest of "Callbacks" ─
    describe("Callbacks (remaining cases)", () => {
      afterEach(() => {
        Detokeniser.resetCallbacks();
      });

      it("sync callback receives parsed args and its return value is used", async () => {
        let capturedArgs: string | undefined;
        Detokeniser.addCallback("mytoken", ({ args }) => {
          capturedArgs = args;
          return "syncResult";
        });
        const result = await Detokeniser.doAsync(`${open}mytoken|arg1|arg2${close}`);
        expect(capturedArgs).toBe("arg1|arg2");
        expect(result).toBe("syncResult");
      });

      it("verb matching is case-insensitive and trimmed", async () => {
        Detokeniser.addCallback("MyToken", () => "ok");
        await expect(Detokeniser.doAsync(`${open} mytoken ${close}`)).resolves.toBe("ok");
      });

      it("context carries verb, rawVerb, qualifier, args and a working resolveMarkers function", async () => {
        let captured: Detokeniser.VerbContext | undefined;
        Detokeniser.addCallback("mytype", (context) => {
          captured = context;
          return "ok";
        });
        await Detokeniser.doAsync(`${open}mytype(q)|arg1|arg2${close}`);
        expect(captured).toBeDefined();
        expect(captured?.verb).toBe("mytype");
        expect(captured?.rawVerb).toBe("mytype(q)");
        expect(captured?.qualifier).toBe("q");
        expect(captured?.args).toBe("arg1|arg2");
        expect(captured?.delimiter).toBe("|");
        expect(captured?.options).toEqual({});
        expect(typeof captured?.resolveMarkers).toBe("function");
        expect(captured?.resolveMarkers("arg1|arg2")).toBe("arg1|arg2");
      });

      it("async callback receives parsed args and its return value is used", async () => {
        let capturedArgs: string | undefined;
        Detokeniser.addCallback("asynctoken", async ({ args }) => {
          capturedArgs = args;
          return "asyncResult";
        });
        const result = await Detokeniser.doAsync(`${open}asynctoken|arg1|arg2${close}`);
        expect(capturedArgs).toBe("arg1|arg2");
        expect(result).toBe("asyncResult");
      });

      it("resetCallbacks clears all callbacks — the verb then has no handler at all and throws", async () => {
        Detokeniser.addCallback("anything", () => "sync");
        Detokeniser.resetCallbacks();
        await expect(Detokeniser.doAsync(`${open}anything${close}`)).rejects.toThrow(/Unsupported token/);
      });

      it("reset clears all callbacks — the verb then has no handler at all and throws", async () => {
        Detokeniser.addCallback("anything", () => "sync");
        Detokeniser.reset();
        // reset() also restores tokenStartStop to the real default ("<%%>") — re-set it so
        // the rest of this parametrized iteration keeps testing the boundary it's meant to.
        Detokeniser.tokenStartStop = open + close;
        await expect(Detokeniser.doAsync(`${open}anything${close}`)).rejects.toThrow(/Unsupported token/);
      });

      it("among several callbacks registered for the same verb, the most recently registered one wins", async () => {
        Detokeniser.addCallback("date", () => "FIRST");
        Detokeniser.addCallback("date", () => "SECOND");
        await expect(Detokeniser.doAsync(`${open}date|today|yyyy${close}`)).resolves.toBe("SECOND");
      });

      it("a callback can decline and fall through to another callback for the same verb, then to the built-in", async () => {
        Detokeniser.addCallback("date", ({ qualifier }) => (qualifier === "special" ? "SPECIAL" : undefined));
        await expect(Detokeniser.doAsync(`${open}date(special)|today|yyyy${close}`)).resolves.toBe("SPECIAL");
        const result = await Detokeniser.doAsync(`${open}date|today|yyyy${close}`);
        expect(result).toBe(format(new Date(), "yyyy"));
      });

      it("resetCallbacks removes an override and restores the built-in", async () => {
        Detokeniser.addCallback("date", () => "OVERRIDDEN");
        Detokeniser.resetCallbacks();
        const result = await Detokeniser.doAsync(`${open}date|today|yyyy${close}`);
        expect(result).toBe(format(new Date(), "yyyy"));
      });

      it("a callback receives the same DoOptions the caller passed to doAsync, including contextParameters", async () => {
        let captured: Record<string, unknown> | undefined;
        Detokeniser.addCallback("anything", ({ options }) => {
          captured = options.contextParameters;
          return "ok";
        });
        await Detokeniser.doAsync(`${open}anything${close}`, { contextParameters: { foo: "bar" } });
        expect(captured).toEqual({ foo: "bar" });
      });

      it("a qualifier with nothing after its closing ')' is legal", async () => {
        Detokeniser.addCallback("q", ({ qualifier }) => `got:${qualifier}`);
        await expect(Detokeniser.doAsync(`${open}q(hello)${close}`)).resolves.toBe("got:hello");
      });
    });
  });
});
