import { MockInstance } from 'vitest';
import { Logger } from "./logger.js";
import { readFileSync } from "fs";

// =============================================================================
// Helpers
// =============================================================================

/** Builds a standard log-capture callback and returns the output array. */
function makeLogCapture(): {
  logOutput: string[];
  callback: (message: string, mediaType?: string) => void;
} {
  const logOutput: string[] = [];
  const callback = (message: string, mediaType?: string): void => {
    logOutput.push(
      `MediaType: [${mediaType ?? "Not Defined"}], Message: [${message}]`
    );
  };
  return { logOutput, callback };
}

// =============================================================================
// Top-level suite
// =============================================================================

describe("Logger", () => {
  afterEach(() => {
    Logger.reset(true);
  });

  // ---------------------------------------------------------------------------
  // Getters and setters (non-output)
  // ---------------------------------------------------------------------------

  describe("Getters and setters", () => {
    it("logToConsole round-trips correctly", () => {
      Logger.logToConsole = true;
      expect(Logger.logToConsole).toBe(true);
      Logger.logToConsole = false;
      expect(Logger.logToConsole).toBe(false);
    });

    it("panicMode round-trips correctly", () => {
      Logger.panicMode = true;
      expect(Logger.panicMode).toBe(true);
      Logger.panicMode = false;
      expect(Logger.panicMode).toBe(false);
    });

    it("throwErrorIfLogOutputFails round-trips correctly", () => {
      Logger.throwErrorIfLogOutputFails = true;
      expect(Logger.throwErrorIfLogOutputFails).toBe(true);
      Logger.throwErrorIfLogOutputFails = false;
      expect(Logger.throwErrorIfLogOutputFails).toBe(false);
    });

    it("writeLineOptions getter returns the active writeLine configuration", () => {
      const opts = Logger.writeLineOptions;
      expect(opts).toBeDefined();
      expect(typeof opts.maxLines).toBe("number");
    });

    describe("maxLines", () => {

      const originalMaxLines = Logger.maxLines;

      afterEach(() => {
        Logger.maxLines = originalMaxLines;
      });

      it("round-trips correctly", () => {
        Logger.maxLines = 200;
        expect(Logger.maxLines).toBe(200);
      });

      it("is reflected by writeLineOptions too — same underlying value", () => {
        Logger.maxLines = 123;
        expect(Logger.writeLineOptions.maxLines).toBe(123);
      });

      it("a call's own options.maxLines still overrides this default", () => {
        Logger.maxLines = 200;
        const lines: string[] = [];
        Logger.logOutputCallback = (text) => lines.push(text);
        Logger.loggingLevel = Logger.Levels.FrameworkDebug;
        Logger.writeLine(Logger.Levels.FrameworkDebug, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), { maxLines: 5 });
        Logger.clearOutputCallback();
        // 5 max: first 3 real lines + a "skipping" notice + the last line.
        expect(lines.length).toBe(5);
      });

      it("rejects a value below 3, matching writeLine's own per-call validation", () => {
        expect(() => { Logger.maxLines = 2; }).toThrow(/maxLines must be 3 or greater/);
      });

      it("rejects a non-number value", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => { Logger.maxLines = "200" as any; }).toThrow();
      });
    });

    it("clearOutputCallback sets callback to undefined", () => {
      Logger.logOutputCallback = () => { };
      expect(Logger.logOutputCallback).toBeDefined();
      Logger.clearOutputCallback();
      expect(Logger.logOutputCallback).toBeUndefined();
    });

    describe("reset()", () => {
      it("reset(false) preserves the existing start time", () => {
        // Give Logger a known start time by resetting with true first
        Logger.reset(true);
        const timeBefore = (Logger as any)["startTime"] as number;
        // Wait a tick to ensure time would differ if reset
        // (no actual sleep needed — just check the value is unchanged)
        Logger.reset(false);
        const timeAfter = (Logger as any)["startTime"] as number;
        expect(timeAfter).toBe(timeBefore);
      });

      it("reset(true) updates the start time to approximately now", () => {
        const before = Date.now();
        Logger.reset(true);
        const after = Date.now();
        const startTime = (Logger as any)["startTime"] as number;
        expect(startTime).toBeGreaterThanOrEqual(before);
        expect(startTime).toBeLessThanOrEqual(after);
      });

      it("reset() restores default options (logToConsole becomes false)", () => {
        Logger.logToConsole = true;
        Logger.reset();
        expect(Logger.logToConsole).toBe(false);
      });

      it("reset() clears the output callback", () => {
        Logger.logOutputCallback = () => { };
        Logger.reset();
        expect(Logger.logOutputCallback).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Logging level — numeric
  // ---------------------------------------------------------------------------

  describe("Logging level (numeric)", () => {
    it.each([
      [Logger.Levels.FrameworkDebug],
      [Logger.Levels.FrameworkInformation],
      [Logger.Levels.TestDebug],
      [Logger.Levels.TestInformation],
      [Logger.Levels.Error],
      [Logger.Levels.NoOutput],
      [7],
    ])("level %p round-trips correctly", (level) => {
      Logger.loggingLevel = level;
      expect(Logger.loggingLevel).toEqual(level);
    });

    it("negative value defaults to FrameworkDebug and emits a warning", () => {
      const { logOutput, callback } = makeLogCapture();
      Logger.logOutputCallback = callback;
      Logger.loggingLevel = Logger.Levels.NoOutput;

      Logger.loggingLevel = -1;

      expect(Logger.loggingLevel).toEqual(Logger.Levels.FrameworkDebug);
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        /WARNG.*Invalid Log Level \[-1\] \(Must be integer greater than zero\)\. Defaulting to Framework Debug!/
      );
    });

    it("decimal value defaults to FrameworkDebug and emits a warning", () => {
      const { logOutput, callback } = makeLogCapture();
      Logger.logOutputCallback = callback;
      Logger.loggingLevel = Logger.Levels.NoOutput;

      Logger.loggingLevel = 3.7;

      expect(Logger.loggingLevel).toEqual(Logger.Levels.FrameworkDebug);
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        /WARNG.*Invalid Log Level \[3\.7\] \(Must be integer greater than zero\)\. Defaulting to Framework Debug!/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Logging level — text
  // ---------------------------------------------------------------------------

  describe("Logging level (text)", () => {
    it.each([
      ["Framework debug", "Framework debug (FKDBG)"],
      ["Framework information", "Framework information (FKINF)"],
      ["TEST DEBUG", "Test debug (TSDBG)"],
      ["test information", "Test information (TSINF)"],
      ["Error", "Errors only (ERROR)"],
      ["No Output", "No output from Log (NOOUT)"],
      ["verbose", "Special Level"],
      ["maximum", "Special Level"],
      ["max", "Special Level"],
      ["special", "Special Level"],
      [32, "Special Level"]
    ])("text '%s' resolves to '%s'", (input, expected) => {
      Logger.loggingLevel = input;
      expect(Logger.loggingLevelText).toMatch(expected);
    });

    it.each([
      ["fkdbg", "Framework debug (FKDBG)"],
      ["fkINF", "Framework information (FKINF)"],
      ["ts dbg", "Test debug (TSDBG)"],
      ["TSINF", "Test information (TSINF)"],
      ["noout", "No output from Log (NOOUT)"],
    ])("shortcode '%s' resolves to '%s'", (input, expected) => {
      Logger.loggingLevel = input;
      expect(Logger.loggingLevelText).toMatch(expected);
    });

    it("unknown text defaults to FrameworkDebug and emits a warning", () => {
      const { logOutput, callback } = makeLogCapture();
      Logger.logOutputCallback = callback;
      Logger.loggingLevel = Logger.Levels.NoOutput;

      Logger.loggingLevel = "wibble";

      expect(Logger.loggingLevel).toEqual(Logger.Levels.FrameworkDebug);
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        /WARNG.*Unknown Log Level \[wibble\]\. Defaulting to Framework Debug!/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Logging level — loggingLevelText
  // ---------------------------------------------------------------------------

  describe("loggingLevelText", () => {
    it.each([
      [Logger.Levels.FrameworkDebug, "Framework debug (FKDBG)"],
      [Logger.Levels.FrameworkInformation, "Framework information (FKINF)"],
      [Logger.Levels.TestDebug, "Test debug (TSDBG)"],
      [Logger.Levels.TestInformation, "Test information (TSINF)"],
      [Logger.Levels.Error, "Errors only (ERROR)"],
      [Logger.Levels.NoOutput, "No output from Log (NOOUT)"],
      [7, "Special Level - (7)"],
    ])("level %p returns '%s'", (level, expectedText) => {
      Logger.loggingLevel = level;
      expect(Logger.loggingLevelText).toMatch(expectedText);
    });

    it("negative internal level returns 'Unknown!'", () => {
      (Logger as any)["options"]["loggingCurrentLevel"] = -10;
      expect(Logger.loggingLevelText).toMatch("Unknown!");
    });
  });

  // ---------------------------------------------------------------------------
  // loggingLevelDescription
  // ---------------------------------------------------------------------------

  describe("loggingLevelDescription", () => {
    it("returns plain level name when no filter is active", () => {
      const result = Logger.loggingLevelDescription(
        Logger.Levels.FrameworkDebug,
        Logger.Levels.NoOutput,
        Logger.Levels.NoOutput
      );
      expect(result).toMatch("Framework debug (FKDBG)");
    });

    it("returns single-level description when min equals max", () => {
      const result = Logger.loggingLevelDescription(
        Logger.Levels.Error,
        Logger.Levels.Warning,
        Logger.Levels.Warning
      );
      expect(result).toMatch(/Levels \[.*\] and \[.*\]/);
    });

    it("returns range description when min is less than max", () => {
      const result = Logger.loggingLevelDescription(
        Logger.Levels.Error,
        Logger.Levels.TestInformation,
        Logger.Levels.FrameworkDebug
      );
      expect(result).toMatch(/Between levels \[.*\]/);
    });

    it("includes panic preamble when panicMode is active", () => {
      Logger.panicMode = true;
      const result = Logger.loggingLevelDescription(
        Logger.Levels.Error,
        Logger.Levels.NoOutput,
        Logger.Levels.NoOutput
      );
      expect(result).toMatch(/^P: /);
    });

    it("returns plain level name when filter range is inverted (min > max)", () => {
      const result = Logger.loggingLevelDescription(
        Logger.Levels.Error,
        Logger.Levels.FrameworkDebug,
        Logger.Levels.TestInformation
      );
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // loggingFilter
  // ---------------------------------------------------------------------------

  describe("loggingFilter", () => {
    it("getter returns { min, max } matching what was set", () => {
      Logger.loggingFilter = { min: 20, max: 25 };
      expect(Logger.loggingFilter).toEqual({ min: 20, max: 25 });
    });

    it("round-trips correctly via getter after setter", () => {
      Logger.loggingFilter = { min: Logger.Levels.Error, max: Logger.Levels.Warning };
      const filter = Logger.loggingFilter;
      expect(filter.min).toBe(Logger.Levels.Error);
      expect(filter.max).toBe(Logger.Levels.Warning);
    });

    it("accepts string level names", () => {
      Logger.loggingFilter = { min: "Error", max: "Warning" };
      expect(Logger.loggingFilter).toEqual({
        min: Logger.Levels.Error,
        max: Logger.Levels.Warning,
      });
    });

    it("invalid min defaults to NoOutput and emits a warning", () => {
      const { logOutput, callback } = makeLogCapture();
      Logger.logOutputCallback = callback;

      Logger.loggingFilter = { min: -5, max: 10 };

      expect(Logger.loggingFilter.min).toBe(Logger.Levels.NoOutput);
      expect(logOutput.length).toBeGreaterThanOrEqual(1);
      expect(logOutput[0]).toMatch(/WARNG.*Invalid Log Level/);
    });

    it("invalid max defaults to NoOutput and emits a warning", () => {
      const { logOutput, callback } = makeLogCapture();
      Logger.logOutputCallback = callback;

      Logger.loggingFilter = { min: 1, max: -5 };

      expect(Logger.loggingFilter.max).toBe(Logger.Levels.NoOutput);
      expect(logOutput.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // writeLine — preamble and filtering (normal mode)
  // ---------------------------------------------------------------------------

  describe("writeLine — normal mode", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Verbose;
      Logger.logOutputCallback = capture.callback;
    });

    it("emits the correct write-type label for every built-in level", () => {
      Logger.writeLine(Logger.Levels.Error, "error test");
      Logger.writeLine(Logger.Levels.Warning, "warn test");
      Logger.writeLine(Logger.Levels.FrameworkDebug, "framework debug test");
      Logger.writeLine(Logger.Levels.FrameworkInformation, "framework info test");
      Logger.writeLine(Logger.Levels.TestDebug, "test debug test");
      Logger.writeLine(Logger.Levels.TestInformation, "test info test");
      Logger.writeLine(20, "special stuff");

      expect(logOutput).toHaveLength(7);
      expect(logOutput[0]).toMatch(/Message: \[ERROR - /);
      expect(logOutput[1]).toMatch(/Message: \[WARNG - /);
      expect(logOutput[2]).toMatch(/Message: \[FKDBG - /);
      expect(logOutput[3]).toMatch(/Message: \[FKINF - /);
      expect(logOutput[4]).toMatch(/Message: \[TSDBG - /);
      expect(logOutput[5]).toMatch(/Message: \[TSINF - /);
      expect(logOutput[6]).toMatch(/Message: \[00020 - /);
    });

    it("preamble contains a wall-clock timestamp and an elapsed time", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "timestamp test");

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/- \[\d{2}:\d{2}:\d{2}\]\[00:00\.\d{3}\] \[/);
    });

    it("preamble contains the caller's file, line, and column", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "caller test");

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        /\[.*logger\.spec\.ts:\d{1,3}:\d{1,2}\]/
      );
    });

    it("message text appears at the end of the log line", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "hello world");

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/: hello world]$/);
    });

    it("NoOutput level produces no output", () => {
      Logger.writeLine(Logger.Levels.NoOutput, "should be silent");
      expect(logOutput).toHaveLength(0);
    });

    it("custom timestamp and elapsed format strings are applied", () => {
      Logger.writeLineOptions.timeFormat = ">>'TIME:' yyyy<<";
      Logger.writeLineOptions.elapsedFormat = ">>'ELAP:' MMM<<";
      Logger.writeLine(Logger.Levels.Error, "format test");

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        /\[>>TIME: 20\d{2}<<\]\[>>ELAP: Jan<<\]/
      );
    });

    it("suppressTimeStamp omits the timestamp from the preamble", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "no timestamp", {
        suppressTimeStamp: true,
      });

      expect(logOutput).toHaveLength(1);
      // Timestamp bracket should be absent; elapsed bracket should still be present
      expect(logOutput[0]).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logOutput[0]).toMatch(/\[00:00\.\d{3}\]/);
    });

    it("suppressElapsed omits the elapsed time from the preamble", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "no elapsed", {
        suppressElapsed: true,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logOutput[0]).not.toMatch(/\[00:00\.\d{3}\]/);
    });

    it("suppressTimeStamp and suppressElapsed together remove both from preamble", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "no time parts", {
        suppressTimeStamp: true,
        suppressElapsed: true,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logOutput[0]).not.toMatch(/\[00:00\.\d{3}\]/);
    });

    it("suppressLevel omits the level label from the preamble", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "no level", {
        suppressLevel: true,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).not.toMatch(/ERR/);
      // Timestamp/elapsed/source are unaffected
      expect(logOutput[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logOutput[0]).toMatch(/\[.*logger\.spec\.ts:\d{1,3}:\d{1,2}\]/);
    });

    it("suppressSource omits the call-site label from the preamble, with no stray separator", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "no source", {
        suppressSource: true,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).not.toMatch(/logger\.spec\.ts/);
      // Elapsed bracket is immediately followed by ": " — no leftover space/bracket.
      expect(logOutput[0]).toMatch(/\[00:00\.\d{3}\]: no source/);
    });

    it("suppressLevel, suppressSource, suppressTimeStamp, and suppressElapsed combine to leave only \" - : \"", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "bare", {
        suppressLevel: true,
        suppressSource: true,
        suppressTimeStamp: true,
        suppressElapsed: true,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/\[ - : bare\]$/);
    });

    it("suppressAllPreamble takes precedence over suppressLevel/suppressSource too", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLine(Logger.Levels.Error, "fully bare", {
        suppressAllPreamble: true,
        suppressLevel: false,
        suppressSource: false,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/\[fully bare\]$/);
    });

    it("a global suppressRealTime-equivalent (Logger-wide suppressTimeStamp) combines with a per-call suppressSource", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.writeLineOptions.suppressTimeStamp = true;
      Logger.writeLine(Logger.Levels.Error, "mixed scope", { suppressSource: true });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logOutput[0]).not.toMatch(/logger\.spec\.ts/);
      expect(logOutput[0]).toMatch(/\[00:00\.\d{3}\]: mixed scope/);
    });

    describe("level filtering", () => {
      it("only emits messages at or below the current level", () => {
        Logger.loggingLevel = Logger.Levels.TestDebug;

        Logger.writeLine(Logger.Levels.TestInformation, "should pass");
        Logger.writeLine(Logger.Levels.TestDebug, "should pass");
        Logger.writeLine(Logger.Levels.FrameworkInformation, "should be filtered");

        expect(logOutput).toHaveLength(2);
        expect(logOutput[0]).toMatch(/TSINF/);
        expect(logOutput[1]).toMatch(/TSDBG/);
      });

      it("filter range passes messages within [min, max] regardless of current level", () => {
        Logger.loggingLevel = Logger.Levels.TestDebug;
        Logger.loggingFilter = { min: 20, max: 25 };

        Logger.writeLine(Logger.Levels.TestInformation, "pass — within level");
        Logger.writeLine(Logger.Levels.TestDebug, "pass — within level");
        Logger.writeLine(Logger.Levels.FrameworkInformation, "filtered — above level, outside range");
        Logger.writeLine(19, "filtered — below range");
        Logger.writeLine(20, "pass — range min");
        Logger.writeLine(25, "pass — range max");
        Logger.writeLine(26, "filtered — above range");

        expect(logOutput).toHaveLength(4);
        expect(logOutput[0]).toMatch(/TSINF/);
        expect(logOutput[1]).toMatch(/TSDBG/);
        expect(logOutput[2]).toMatch(/00020/);
        expect(logOutput[3]).toMatch(/00025/);
      });
    });

    it("logs to console.error when callback throws (throwErrorIfLogOutputFails=false)", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      Logger.logOutputCallback = () => { throw new Error("callback boom"); };

      Logger.writeLine(Logger.Levels.Error, "test");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Error thrown from Log Output Callback during writeLine/)
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/callback boom/)
      );
      consoleSpy.mockRestore();
    });

    it("re-throws when callback throws and throwErrorIfLogOutputFails=true", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      Logger.throwErrorIfLogOutputFails = true;
      Logger.logOutputCallback = () => { throw new Error("callback boom"); };

      expect(() => Logger.writeLine(Logger.Levels.Error, "test")).toThrow(
        /Error thrown from Log Output Callback during writeLine/
      );
      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // writeLine — panic mode
  // ---------------------------------------------------------------------------

  describe("writeLine — panic mode", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.panicMode = true;
      Logger.logOutputCallback = capture.callback;
    });

    it("prepends 'P' to each write-type label", () => {
      Logger.loggingLevel = Logger.Levels.Verbose;
      Logger.writeLine(Logger.Levels.Error, "error test");
      Logger.writeLine(Logger.Levels.Warning, "warn test");
      Logger.writeLine(Logger.Levels.FrameworkDebug, "framework debug test");
      Logger.writeLine(Logger.Levels.FrameworkInformation, "framework info test");
      Logger.writeLine(Logger.Levels.TestDebug, "test debug test");
      Logger.writeLine(Logger.Levels.TestInformation, "test info test");
      Logger.writeLine(20, "special stuff");

      expect(logOutput).toHaveLength(7);
      expect(logOutput[0]).toMatch(/Message: \[PERROR - /);
      expect(logOutput[1]).toMatch(/Message: \[PWARNG - /);
      expect(logOutput[2]).toMatch(/Message: \[PFKDBG - /);
      expect(logOutput[3]).toMatch(/Message: \[PFKINF - /);
      expect(logOutput[4]).toMatch(/Message: \[PTSDBG - /);
      expect(logOutput[5]).toMatch(/Message: \[PTSINF - /);
      expect(logOutput[6]).toMatch(/Message: \[P00020 - /);
    });

    it("outputs all messages regardless of current logging level", () => {
      Logger.loggingLevel = Logger.Levels.TestDebug;
      Logger.loggingFilter = { min: 20, max: 25 };

      Logger.writeLine(Logger.Levels.TestInformation, "should pass");
      Logger.writeLine(Logger.Levels.TestDebug, "should pass");
      Logger.writeLine(Logger.Levels.FrameworkInformation, "should pass — panic");
      Logger.writeLine(19, "should pass — panic");
      Logger.writeLine(20, "should pass");
      Logger.writeLine(25, "should pass");
      Logger.writeLine(26, "should pass — panic");

      expect(logOutput).toHaveLength(7);
    });

    it("NoOutput level is still suppressed in panic mode", () => {
      Logger.writeLine(Logger.Levels.NoOutput, "should still be silent");
      expect(logOutput).toHaveLength(1);
    });

    it("preamble still contains timestamp and elapsed time", () => {
      Logger.writeLine(Logger.Levels.Error, "panic timestamp test");
      expect(logOutput[0]).toMatch(/- \[\d{2}:\d{2}:\d{2}\]\[00:00\.\d{3}\] \[/);
    });

    it("preamble still shows the caller's file and location", () => {
      Logger.writeLine(Logger.Levels.Error, "panic caller test");
      expect(logOutput[0]).toMatch(
        /\[.*logger\.spec\.ts:\d{1,3}:\d{1,2}\]/
      );
    });

    it("custom timestamp and elapsed formats are applied in panic mode", () => {
      Logger.loggingLevel = Logger.Levels.Verbose;
      Logger.writeLineOptions.timeFormat = ">>'TIME:' yyyy<<";
      Logger.writeLineOptions.elapsedFormat = ">>'ELAP:' MMM<<";
      Logger.writeLine(Logger.Levels.Error, "format test");

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        /\[PERROR - \[>>TIME: 20\d{2}<<\]\[>>ELAP: Jan<<\]/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // writeLine — multiline
  // ---------------------------------------------------------------------------

  describe("writeLine — multiline", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = (message) => logOutput.push(message);
    });

    it("splits a two-line string into two separate log entries", () => {
      Logger.writeLine(Logger.Levels.Error, "line 1\nline 2");

      expect(logOutput).toHaveLength(2);
      expect(logOutput[0]).toMatch(/: line 1$/);
      expect(logOutput[1]).toMatch(/: line 2$/);
    });

    it("respects maxLines and inserts a truncation notice for skipped lines", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
        { maxLines: 4 }
      );

      expect(logOutput).toHaveLength(4);
      expect(logOutput[0]).toMatch(/: line 1$/);
      expect(logOutput[1]).toMatch(/: line 2$/);
      expect(logOutput[2]).toMatch(/\.\.\. \(Skipping some lines as total length \(6\) > 4!!\)$/);
      expect(logOutput[3]).toMatch(/: line 6$/);
    });

    it("maxLines of 1 is treated as 1 (not 0 or negative)", () => {
      Logger.writeLine(Logger.Levels.Error, "line 1\nline 2\nline 3\nline 4", {
        maxLines: 3,
      });
      // maxLines=1: first line becomes the truncation notice, last line is kept
      expect(logOutput).toHaveLength(3);
    });

    it("throws and logs an error when maxLines is less than 3", () => {
      expect(() => {
        Logger.writeLine(Logger.Levels.Error, "line 1\nline 2", { maxLines: 2 });
      }).toThrow("maxLines must be 3 or greater!  Number given was <2>");

      expect(logOutput.some((line) => line.includes("maxLines must be 3 or greater!  Number given was <2>"))).toBe(true);
    });

    it("outputs all lines when line count exactly equals maxLines", () => {
      Logger.writeLine(Logger.Levels.Error, "line 1\nline 2\nline 3", { maxLines: 3 });

      expect(logOutput).toHaveLength(3);
      expect(logOutput[0]).toMatch(/: line 1$/);
      expect(logOutput[1]).toMatch(/: line 2$/);
      expect(logOutput[2]).toMatch(/: line 3$/);
    });
  });

  // ---------------------------------------------------------------------------
  // writeLine — preamble suppression
  // ---------------------------------------------------------------------------

  describe("writeLine — preamble suppression", () => {
    let logOutput: string[];

    beforeEach(() => {
      logOutput = [];
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = (message) => logOutput.push(message);
    });

    it("suppressAllPreamble removes preamble from a single-line message", () => {
      Logger.writeLine(Logger.Levels.Error, "plain text", {
        suppressAllPreamble: true,
      });
      expect(logOutput[0]).toBe("plain text");
    });

    it("suppressAllPreamble removes preamble from every line of a multi-line message", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3",
        { suppressAllPreamble: true }
      );
      expect(logOutput[0]).toBe("line 1");
      expect(logOutput[1]).toBe("line 2");
      expect(logOutput[2]).toBe("line 3");
    });

    it("suppressMultilinePreamble keeps preamble on the first line only", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3",
        { suppressMultilinePreamble: true }
      );
      expect(logOutput[0]).toMatch(/^.*: line 1$/);
      expect(logOutput[1]).toBe("line 2");
      expect(logOutput[2]).toBe("line 3");
    });

    it("suppressAllPreamble takes precedence over suppressMultilinePreamble", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3",
        { suppressMultilinePreamble: true, suppressAllPreamble: true }
      );
      expect(logOutput[0]).toBe("line 1");
      expect(logOutput[1]).toBe("line 2");
      expect(logOutput[2]).toBe("line 3");
    });

    it("suppressAllPreamble with maxLines: truncation notice has no preamble", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
        { maxLines: 4, suppressAllPreamble: true }
      );
      expect(logOutput[0]).toBe("line 1");
      expect(logOutput[1]).toBe("line 2");
      expect(logOutput[2]).toMatch(/^\.\.\. \(Skipping/);
      expect(logOutput[3]).toBe("line 6");
    });

    it("suppressMultilinePreamble with maxLines: truncation notice has no preamble", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
        { maxLines: 4, suppressMultilinePreamble: true }
      );
      expect(logOutput[0]).toMatch(/^.*: line 1$/);
      expect(logOutput[1]).toBe("line 2");
      expect(logOutput[2]).toMatch(/^\.\.\. \(Skipping some lines as total length \(6\) > 4!!\)$/);
      expect(logOutput[3]).toBe("line 6");
    });

    it("both suppression flags with maxLines: all lines bare", () => {
      Logger.writeLine(
        Logger.Levels.Error,
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
        { maxLines: 4, suppressMultilinePreamble: true, suppressAllPreamble: true }
      );
      expect(logOutput[0]).toBe("line 1");
      expect(logOutput[1]).toBe("line 2");
      expect(logOutput[2]).toMatch(/^\.\.\. \(Skipping/);
      expect(logOutput[3]).toBe("line 6");
    });
  });

  // ---------------------------------------------------------------------------
  // Console output behaviour
  // ---------------------------------------------------------------------------

  describe("Console output", () => {
    let logSpy: MockInstance;
    let logOutput: string[];

    beforeEach(() => {
      logOutput = [];
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      Logger.loggingLevel = Logger.Levels.FrameworkDebug;
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it("logToConsole=true writes to console in addition to the callback", () => {
      Logger.logOutputCallback = (message) => logOutput.push(message);
      Logger.logToConsole = true;
      Logger.writeLine(Logger.Levels.TestInformation, "console test");

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/TSINF - \[.*console test/)
      );
      expect(logOutput).toHaveLength(1);
    });

    it("logToConsole=false does not write to console when callback is set", () => {
      Logger.logOutputCallback = (message) => logOutput.push(message);
      Logger.logToConsole = false;
      Logger.writeLine(Logger.Levels.TestInformation, "silent console");

      expect(logSpy).not.toHaveBeenCalled();
      expect(logOutput).toHaveLength(1);
    });

    it("with no callback and logToConsole=false, still writes to console as fallback", () => {
      Logger.clearOutputCallback();
      Logger.logToConsole = false;
      Logger.writeLine(Logger.Levels.TestInformation, "fallback console");

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/TSINF - \[.*fallback console/)
      );
    });

    it("with no callback and logToConsole=true, writes to console exactly once", () => {
      Logger.clearOutputCallback();
      Logger.logToConsole = true;
      Logger.writeLine(Logger.Levels.TestInformation, "once only");

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("logToConsole getter matches what was set", () => {
      Logger.logToConsole = true;
      expect(Logger.logToConsole).toBe(true);
      Logger.logToConsole = false;
      expect(Logger.logToConsole).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // attach()
  // ---------------------------------------------------------------------------

  describe("attach()", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = capture.callback;
    });

    it("passes data and mediaType through to the callback", () => {
      Logger.attach(Logger.Levels.Error, "<b>hi</b>", "text/html");
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/MediaType: \[text\/html\], Message: \[<b>hi<\/b>\]/);
    });

    it("is suppressed when logLevel is below the current logging level", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.attach(Logger.Levels.Warning, "should be filtered", "text/plain");
      expect(logOutput).toHaveLength(0);
    });

    it("logs an error when callback is not a function", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      Logger.clearOutputCallback();
      Logger.logToConsole = false;
      Logger.attach(Logger.Levels.Error, "test", "text/plain");
      // Output goes to console fallback since no callback is set
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Log Output callback is type \[undefined\]/)
      );
      consoleSpy.mockRestore();
    });

    it("when callback is set to a non-function, error is logged via console", () => {
      (Logger.logOutputCallback as any) = "not-a-function";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      Logger.attach(Logger.Levels.Error, "test", "text/plain");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Log Output callback is type \[string\]/)
      );
      consoleSpy.mockRestore();
    });

    it("non-string data is described correctly in the error message", () => {
      Logger.logOutputCallback = (message, mediaType) => {
        if (mediaType === "base64:image/png") throw new Error("deliberate");
        logOutput.push(`MediaType: [${mediaType ?? "Not Defined"}], Message: [${message}]`);
      };
      (Logger.attach as (l: number, d: any, m: string) => void)(
        Logger.Levels.Error,
        24,
        "base64:image/png"
      );
      // Error details are written back through writeLine -> logOutput
      const combined = logOutput.join("\n");
      expect(combined).toMatch(/Not a string! Is type number/);
    });

    it("long data strings are truncated in the error message", () => {
      Logger.logOutputCallback = (message, mediaType) => {
        if (mediaType === "base64:image/png") throw new Error("deliberate");
        logOutput.push(`MediaType: [${mediaType ?? "Not Defined"}], Message: [${message}]`);
      };
      Logger.attach(
        Logger.Levels.Error,
        "A very long text that will have to be truncated so that it doesnt overrun",
        "base64:image/png"
      );
      const combined = logOutput.join("\n");
      expect(combined).toMatch(/A very long text that wil\.\.\.run/);
    });

    it("throwErrorIfLogOutputFails=true re-throws callback errors", () => {
      Logger.throwErrorIfLogOutputFails = true;
      Logger.logOutputCallback = () => {
        throw new Error("callback failure");
      };
      expect(() =>
        Logger.attach(Logger.Levels.Error, "data", "text/plain")
      ).toThrow("callback failure");
    });
  });

  // ---------------------------------------------------------------------------
  // attachHTML()
  // ---------------------------------------------------------------------------

  describe("attachHTML()", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = capture.callback;
    });

    it("sends HTML content with text/html media type", () => {
      const html = "<div>hello</div>";
      Logger.attachHTML(Logger.Levels.Error, html);
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        new RegExp(
          `MediaType: \\[text/html\\], Message: \\[${html.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`
        )
      );
    });

    it("is suppressed when logLevel is below the current logging level", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.attachHTML(Logger.Levels.Warning, "<p>filtered</p>");
      expect(logOutput).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // attachScreenshot()
  // ---------------------------------------------------------------------------

  describe("attachScreenshot()", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = capture.callback;
    });

    it("attaches a Buffer as a base64-encoded PNG", () => {
      const buffer = Buffer.from("Test string", "utf8");
      const expected = buffer.toString("base64");
      Logger.attachScreenshot(Logger.Levels.Error, buffer);

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        new RegExp(
          `MediaType: \\[base64:image/png\\], Message: \\[${expected}\\]`
        )
      );
    });

    it("attaches a plain string by base64-encoding it", () => {
      const input = "Test string";
      const expected = Buffer.from(input, "utf8").toString("base64");
      Logger.attachScreenshot(Logger.Levels.Error, input);

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        new RegExp(
          `MediaType: \\[base64:image/png\\], Message: \\[${expected}\\]`
        )
      );
    });

    it("is suppressed when logLevel is below the current logging level", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.attachScreenshot(Logger.Levels.Warning, "filtered");
      expect(logOutput).toHaveLength(0);
    });

    it("processes callback errors via processError when callback throws", () => {
      const errorMessage = "reporter rejected";
      Logger.logOutputCallback = (message, mediaType) => {
        if (mediaType === "base64:image/png") throw new Error(errorMessage);
        logOutput.push(message);
      };
      Logger.attachScreenshot(Logger.Levels.Error, "test");

      const combined = logOutput.join("\n");
      expect(combined).toMatch(/Error thrown from Log Output Callback/);
      expect(combined).toMatch(new RegExp(errorMessage));
    });

    it("re-throws callback errors when throwErrorIfLogOutputFails=true", () => {
      const screenshot = "test-screenshot";
      Logger.throwErrorIfLogOutputFails = true;
      Logger.logOutputCallback = (_, mediaType) => {
        if (mediaType === "base64:image/png") throw new Error("No Like");
        logOutput.push(`MediaType: [${mediaType}]`);
      };

      let thrown = "";
      try {
        Logger.attachScreenshot(Logger.Levels.Error, screenshot);
      } catch (err) {
        thrown = (err as Error).message;
      }

      const lines = thrown.split("\n");
      expect(lines[0]).toMatch(/Error thrown from Log Output Callback/);
      expect(lines[1]).toMatch(/No Like/);
      expect(lines[3]).toMatch(
        new RegExp(Buffer.from(screenshot, "utf8").toString("base64"))
      );
      expect(lines[5]).toMatch(/base64:image\/png/);
    });
  });

  // ---------------------------------------------------------------------------
  // attachVideo() and attachVideoFile()
  // ---------------------------------------------------------------------------

  describe("attachVideo()", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = capture.callback;
    });

    it("wraps the buffer in a <video> tag with default options", () => {
      const buffer = Buffer.from("Test string", "utf8");
      const base64 = buffer.toString("base64");
      Logger.attachVideo(Logger.Levels.Error, buffer);

      const expected = `<video controls width="320" height="180"><source src="data:video/webm;base64,${base64}" type="video/webm">Video (Codec webm) not supported by browser</video>`;
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        new RegExp(
          `MediaType: \\[text/html\\], Message: \\[${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`
        )
      );
    });

    it("uses caller-supplied VideoOptions over the defaults", () => {
      const buffer = Buffer.from("Test string", "utf8");
      const base64 = buffer.toString("base64");
      Logger.attachVideo(Logger.Levels.Error, buffer, {
        width: 640,
        height: 360,
        videoCodec: "mp4",
      });

      const expected = `<video controls width="640" height="360"><source src="data:video/mp4;base64,${base64}" type="video/mp4">Video (Codec mp4) not supported by browser</video>`;
      expect(logOutput[0]).toMatch(
        new RegExp(
          `MediaType: \\[text/html\\], Message: \\[${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`
        )
      );
    });

    it("is suppressed when logLevel is below the current logging level", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.attachVideo(Logger.Levels.Warning, Buffer.from("x"));
      expect(logOutput).toHaveLength(0);
    });

    it("adds title='PANIC_MODE' to the video element when panicMode is active", () => {
      Logger.panicMode = true;
      const buffer = Buffer.from("test", "utf8");
      Logger.attachVideo(Logger.Levels.Error, buffer);
      expect(logOutput[0]).toMatch(/title="PANIC_MODE"/);
    });
  });

  describe("attachVideoFile()", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.logOutputCallback = capture.callback;
    });

    it("reads the file and attaches it as video", () => {
      const fileName = "testData/testData.txt";
      const buffer = readFileSync(fileName);
      const base64 = buffer.toString("base64");
      Logger.attachVideoFile(Logger.Levels.Error, fileName);

      const expected = `<video controls width="320" height="180"><source src="data:video/webm;base64,${base64}" type="video/webm">Video (Codec webm) not supported by browser</video>`;
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(
        new RegExp(
          `MediaType: \\[text/html\\], Message: \\[${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`
        )
      );
    });

    it("logs an error when the file does not exist", () => {
      Logger.attachVideoFile(Logger.Levels.Error, "testData/does-not-exist.txt");
      expect(logOutput).toHaveLength(2);
      expect(logOutput[0]).toMatch(/\[ERROR.*Error thrown reading video data/);
      expect(logOutput[1]).toMatch(/ENOENT.*no such file or directory/);
    });

    it("is suppressed when logLevel is below the current logging level", () => {
      Logger.loggingLevel = Logger.Levels.Error;
      Logger.attachVideoFile(Logger.Levels.Warning, "testData/testData.txt");
      expect(logOutput).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // videoOptions getter/setter
  // ---------------------------------------------------------------------------

  describe("videoOptions", () => {
    let logOutput: string[];

    beforeEach(() => {
      const capture = makeLogCapture();
      logOutput = capture.logOutput;
      Logger.loggingLevel = Logger.Levels.Warning;
      Logger.logOutputCallback = capture.callback;
      Logger.videoOptions = { height: 180, width: 320 };
    });

    it("accepts valid dimensions within limits", () => {
      Logger.videoOptions = { height: 181, width: 320 };
      expect(logOutput).toHaveLength(0);
      expect(Logger.videoOptions).toEqual({ videoCodec: "webm", height: 181, width: 320 });
    });

    it("accepts a codec-only change without altering dimensions", () => {
      Logger.videoOptions = { videoCodec: "mp4" };
      expect(logOutput).toHaveLength(0);
      expect(Logger.videoOptions).toEqual({ videoCodec: "mp4", height: 180, width: 320 });
    });

    it("accepts a height-only change without altering width", () => {
      Logger.videoOptions = { height: 200 };
      expect(logOutput).toHaveLength(0);
      expect(Logger.videoOptions).toEqual({ videoCodec: "webm", height: 200, width: 320 });
    });

    it("accepts a width-only change without altering height", () => {
      Logger.videoOptions = { width: 640 };
      expect(logOutput).toHaveLength(0);
      expect(Logger.videoOptions).toEqual({ videoCodec: "webm", height: 180, width: 640 });
    });

    it("rejects both dimensions when height is too low; existing values are preserved", () => {
      Logger.videoOptions = { height: 179, width: 319 };
      expect(logOutput).toHaveLength(2);
      expect(logOutput[0]).toMatch(/WARNG.*Invalid video window height \[179\]/);
      expect(logOutput[1]).toMatch(/WARNG.*Invalid video window width \[319\]/);
      expect(Logger.videoOptions).toEqual({ videoCodec: "webm", height: 180, width: 320 });
    });

    it("rejects both dimensions when height is too high; existing values are preserved", () => {
      Logger.videoOptions = { height: 4321, width: 7681 };
      expect(logOutput).toHaveLength(2);
      expect(logOutput[0]).toMatch(/WARNG.*Invalid video window height \[4321\]/);
      expect(logOutput[1]).toMatch(/WARNG.*Invalid video window width \[7681\]/);
    });

    it("rejects only width when width is invalid; height and width both preserved", () => {
      Logger.videoOptions = { height: 1000, width: 3 };
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/WARNG.*Invalid video window width \[3\]/);
      expect(Logger.videoOptions).toEqual({ videoCodec: "webm", height: 180, width: 320 });
    });

    it("rejects only height when height is invalid; height and width both preserved", () => {
      Logger.videoOptions = { height: 2, width: 1000 };
      expect(logOutput).toHaveLength(1);
      expect(logOutput[0]).toMatch(/WARNG.*Invalid video window height \[2\]/);
      expect(Logger.videoOptions).toEqual({ videoCodec: "webm", height: 180, width: 320 });
    });

    it("throws when a non-number is passed as a resolution value", () => {
      expect(() => {
        (Logger as any).isValidVideoResolutionNumber(
          "not-a-number",
          180,
          4320,
          "bad value"
        );
      }).toThrow(/Resolution number given was a <string>/);
    });
  });
});