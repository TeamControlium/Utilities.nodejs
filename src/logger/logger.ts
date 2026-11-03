import { readFileSync, existsSync } from "fs";
import { dirname, basename, join } from "path";
import { fileURLToPath } from "url";
import { format } from "date-fns";
import {
  VideoOptions,
  WriteLineOptions,
  Options,
  LogOutputCallbackSignature
} from "./types.js";

// ----------------------------
// Module-level defaults
// ----------------------------
const DEFAULT_VIDEO_CODEC = "webm";
const DEFAULT_VIDEO_WIDTH = 320;
const DEFAULT_VIDEO_HEIGHT = 180;
const DEFAULT_WRITELINE_MAX_LINES = 55;
const DEFAULT_WRITELINE_SUPPRESS_ELAPSED = false;
const DEFAULT_WRITELINE_SUPPRESS_TIME = false;
const DEFAULT_WRITELINE_SUPPRESS_ALL = false;
const DEFAULT_WRITELINE_SUPPRESS_MULTI = false;
const DEFAULT_WRITELINE_SUPPRESS_LEVEL = false;
const DEFAULT_WRITELINE_SUPPRESS_SOURCE = false;
const DEFAULT_WRITELINE_FORMAT_TIME = "HH:mm:ss";
const DEFAULT_WRITELINE_FORMAT_ELAPSED = "mm:ss.SSS";
const DEFAULT_LOG_LEVEL = 6; // Framework debug
const DEFAULT_LOG_TO_CONSOLE = false;
const DEFAULT_THROW_ERROR_LOG_FAIL = false;
const DEFAULT_PANIC_MODE = false;
const DEFAULT_PANIC_CODE = "P";
const DEFAULT_PANIC_DESCRIPTOR = "P: ";

// ----------------------------
// Internal constants
// ----------------------------

/** Maximum length of a data/mediaType string shown in error messages before truncation. */
const ERROR_DISPLAY_STRING_MAX_LENGTH = 30;

/** Number of characters kept from the start of a truncated error-display string. */
const ERROR_DISPLAY_STRING_HEAD_LENGTH = 25;

/** Number of characters kept from the end of a truncated error-display string. */
const ERROR_DISPLAY_STRING_TAIL_LENGTH = 3;

/** Minimum character-width used when zero-padding the write-type label. */
const WRITE_TYPE_PAD_WIDTH = 5;

/**
 * Stack-frame substring used to identify internal Logger frames and skip them — this file's
 * own compiled filename at runtime ("logger.js" in the published/compiled build everything
 * outside this package actually runs, "logger.ts" when running directly from source e.g.
 * under a test runner with sourcemap-aware stack traces). Computed from `import.meta.url`
 * rather than hardcoded, specifically so this keeps working after a build — a hardcoded
 * "logger.ts" literal would never match a single frame in a compiled "logger.js", silently
 * disabling the whole skip-internal-frames mechanism for every real consumer of this package.
 */
const LOGGER_STACK_FRAME_MARKER = basename(fileURLToPath(import.meta.url));

/**
 * Cache of "directory → nearest @controlium/* package's short tag, or null if none" used by
 * {@link Logger.resolveControliumPackageTag}. Keyed by directory (not by individual file) since
 * every file in the same directory shares the same nearest-package.json answer — this keeps the
 * filesystem walk-and-read to once per distinct directory ever seen, for the lifetime of the
 * process, rather than once per log line.
 */
const CONTROLIUM_PACKAGE_TAG_CACHE = new Map<string, string | null>();

export class Logger {
  /**
   * Numeric log level constants used to control and filter log output.
   *
   * Levels are ordered from highest verbosity to lowest:
   * - `Maximum` / `Verbose` — log everything
   * - `FrameworkDebug` — internal framework debug messages
   * - `FrameworkInformation` — internal framework info messages
   * - `TestDebug` — test-level debug messages
   * - `TestInformation` — test-level info messages
   * - `Warning` — warnings and errors
   * - `Error` — errors only
   * - `NoOutput` — suppress all output
   *
   * @example
   * Logger.loggingLevel = Logger.Levels.TestInformation;
   */
  public static readonly Levels = {
    /** Maximum verbosity. Same numeric value as `Verbose`. */
    Maximum: Number.MAX_SAFE_INTEGER,

    /** Verbose logging. Same numeric value as `Maximum`. */
    Verbose: Number.MAX_SAFE_INTEGER,

    /** Framework-level debug logs. */
    FrameworkDebug: 6,

    /** Framework-level informational logs. */
    FrameworkInformation: 5,

    /** Test-level debug logs. */
    TestDebug: 4,

    /** Test-level informational logs. */
    TestInformation: 3,

    /** Warnings (and errors). */
    Warning: 2,

    /** Errors only. */
    Error: 1,

    /** No log output is allowed at this level. */
    NoOutput: 0
  } as const;

  // ----------------------------
  // Private Static Properties
  // ----------------------------
  private static readonly videoResolutionLimits = {
    minHeight: 180,
    maxHeight: 4320,
    minWidth: 320,
    maxWidth: 7680
  };

  private static options: Options = Logger.buildDefaultOptions();
  private static startTime: number = Date.now();

  // ----------------------------
  // Public Static Properties
  // ----------------------------

  /**
   * Callback invoked for every log output (after formatting and preamble generation).
   *
   * If defined, the logger calls this function with:
   *  - `message`: The final formatted log line or attached payload.
   *  - `mediaType`: Optional MIME-type-style string.
   *      Examples:
   *        - `"text/plain"` for normal log lines
   *        - `"text/html"` for HTML attachments
   *        - `"base64:image/png"` for screenshots
   *
   * If the callback throws, the logger catches the error and processes it,
   * reporting to the test suite if required.
   *
   * Set this to `undefined` (or call `Logger.clearOutputCallback()`) to disable callback output.
   *
   * @example
   * Logger.logOutputCallback = (message, mediaType) => {
   *   myReporter.attach(message, mediaType ?? "text/plain");
   * };
   */
  public static logOutputCallback: LogOutputCallbackSignature | undefined =
    undefined;

  /**
   * Resets the logger to its default configuration.
   *
   * Clears the output callback and restores all options to their default values.
   * Optionally resets the elapsed-time start point to the current moment.
   *
   * @param resetStartTime - When `true`, the start time used for elapsed-time
   *   calculation is reset to now. When `false` (the default), the existing
   *   start time is preserved so elapsed time continues from the original baseline.
   *
   * @example
   * Logger.reset();       // Reset options only, keep elapsed-time baseline
   * Logger.reset(true);   // Reset options and restart the elapsed timer
   */
  public static reset(resetStartTime: boolean = false): void {

    ////////////////////////////////////////////////////
    //
    // Restores the logger to a clean default state: always clears the output callback and
    // rebuilds the options object from scratch, and optionally rebases the elapsed-time
    // baseline too, depending on what the caller asked for.

    // Caller explicitly asked for the elapsed-time baseline to be rebased to now — otherwise
    // leave startTime untouched so elapsed time keeps counting from wherever it started.
    if (resetStartTime) {
      this.startTime = Date.now();
    }

    // Drop any configured output callback — after reset, nothing is listening until the
    // caller sets a new one.
    this.clearOutputCallback();
    // Rebuild options from the one shared defaults factory, discarding whatever was
    // previously configured (level, filters, writeLine/video settings, etc.).
    this.options = Logger.buildDefaultOptions();
  }

  // ----------------------------
  // Public Getters/Setters
  // ----------------------------

  /**
   * Controls whether log output is written to the console.
   *
   * When `true`, every log line is written to `console.log()` in addition
   * to any configured {@link logOutputCallback}.
   * When `false`, output is sent only to the callback (if defined).
   *
   * @example
   * Logger.logToConsole = true;
   */
  public static set logToConsole(value: boolean) {
    this.options.logToConsole = value;
  }

  /**
   * Returns whether log output is currently being written to the console.
   *
   * @returns `true` if console logging is enabled; otherwise `false`.
   */
  public static get logToConsole(): boolean {
    return this.options.logToConsole;
  }

  /**
   * Enables or disables Panic Mode.
   *
   * When `true`, the current log level is ignored and all log calls produce
   * output — equivalent to setting the log level to `Verbose`.
   * When `false`, normal log-level filtering applies.
   *
   * @example
   * Logger.panicMode = true; // Force all output regardless of log level
   */
  public static set panicMode(value: boolean) {
    this.options.panicMode = value;
  }

  /**
   * Returns whether Panic Mode is currently active.
   *
   * When `true`, all log output is written regardless of the configured log level.
   *
   * @returns `true` if Panic Mode is enabled; otherwise `false`.
   */
  public static get panicMode(): boolean {
    return this.options.panicMode;
  }

  /**
   * Controls whether an exception is thrown when a log-output operation fails.
   *
   * When `true`, any error raised while executing the configured
   * {@link logOutputCallback} is re-thrown to the caller.
   * When `false`, such errors are suppressed and logged internally instead.
   *
   * @example
   * Logger.throwErrorIfLogOutputFails = true;
   */
  public static set throwErrorIfLogOutputFails(value: boolean) {
    this.options.throwErrorIfLogOutputFails = value;
  }

  /**
   * Returns whether log-output failures are re-thrown as exceptions.
   *
   * @returns `true` if logging errors are propagated to the caller;
   *   `false` if they are suppressed and logged internally.
   */
  public static get throwErrorIfLogOutputFails(): boolean {
    return this.options.throwErrorIfLogOutputFails;
  }

  /**
   * Returns the current global logging level.
   *
   * Only messages with a level less than or equal to this value
   * (or within the configured {@link loggingFilter} range) will be output.
   *
   * @returns The current numeric log level.
   *
   * @see {@link Levels} for named level constants.
   */
  public static get loggingLevel(): number {
    return this.options.loggingCurrentLevel;
  }

  /**
   * Sets the global logging level.
   *
   * Accepts a named level string (case-insensitive, spaces ignored),
   * or a non-negative integer. Unknown strings and invalid numbers
   * fall back to `FrameworkDebug` and emit a warning.
   *
   * @param requiredLevel - The desired level as a `Levels` constant, number, or string.
   *
   * @example
   * Logger.loggingLevel = Logger.Levels.Warning;
   * Logger.loggingLevel = 3;
   * Logger.loggingLevel = "TestInformation";
   */
  public static set loggingLevel(requiredLevel: string | number) {

    ////////////////////////////////////////////////////
    //
    // Accepts either a named level string or a raw numeric level, resolves it to the
    // internal numeric level, and falls back to FrameworkDebug (with a warning) for
    // anything that doesn't resolve cleanly.

    if (typeof requiredLevel === "string") {
      // String given — delegate to levelFromText, which itself already falls back to
      // FrameworkDebug (and warns) for unrecognised text.
      this.options.loggingCurrentLevel = this.levelFromText(requiredLevel);
    } else {
      // Number given — only accept a non-negative integer as a valid level.
      if (Number.isInteger(requiredLevel) && requiredLevel >= 0) {
        this.options.loggingCurrentLevel = requiredLevel;
      } else {
        // Invalid number (negative, non-integer, NaN, etc.) — fall back to
        // FrameworkDebug and tell the caller why, rather than silently keeping a bad value.
        this.options.loggingCurrentLevel = this.Levels.FrameworkDebug;
        Logger.writeLine(
          this.Levels.Warning,
          `Invalid Log Level [${requiredLevel}] (Must be integer greater than zero). Defaulting to Framework Debug!`
        );
      }
    }
  }

  /**
   * Returns the current logging level as a human-readable string.
   *
   * @returns A descriptive string for the current log level,
   *   e.g. `"Test information (TSINF)"`.
   */
  public static get loggingLevelText(): string {
    return this.levelToText(this.loggingLevel);
  }

  /**
   * Builds a human-readable description of the active logging configuration,
   * combining the current level with any active filter range.
   *
   * Includes a Panic Mode preamble prefix when {@link panicMode} is active.
   *
   * @param level - The current logging level.
   * @param minLevel - The minimum level of the active filter range (`NoOutput` if no filter).
   * @param maxLevel - The maximum level of the active filter range (`NoOutput` if no filter).
   * @returns A descriptive string. Returns the plain level name when no valid
   *   filter range is active.
   *
   * @example
   * Logger.loggingLevelDescription(Logger.Levels.FrameworkDebug, Logger.Levels.NoOutput, Logger.Levels.NoOutput);
   * // => "Framework debug (FKDBG)"
   */
  public static loggingLevelDescription(
    level: number,
    minLevel: number,
    maxLevel: number
  ): string {

    ////////////////////////////////////////////////////
    //
    // Builds a human-readable description of the active level/filter combination, working
    // out which of three shapes applies: no filter, a single-level filter (min === max), or
    // a genuine min/max range — each gets its own wording, all prefixed with the Panic Mode
    // descriptor when active.

    // All three parameters must actually be numbers before anything else happens.
    this.assertParamType(level, "number", "Logger.loggingLevelDescription", "level");
    this.assertParamType(minLevel, "number", "Logger.loggingLevelDescription", "minLevel");
    this.assertParamType(maxLevel, "number", "Logger.loggingLevelDescription", "maxLevel");
    const currentLevelText = this.levelToText(level);
    // Panic Mode prefixes every description with its own descriptor text; otherwise no prefix.
    const preamble = this.options.panicMode
      ? this.options.panicDescriptorPreamble
      : "";

    // If a valid min/max range is set (neither is NoOutput AND min <= max)
    if (minLevel !== this.Levels.NoOutput && maxLevel !== this.Levels.NoOutput) {
      if (minLevel === maxLevel) {
        // Degenerate range — min and max are the same single level, so describe it as
        // "this one extra level" alongside the current level, not as a "between" range.
        return (
          preamble +
          `Levels [${this.levelToText(minLevel)}] and [${currentLevelText}]`
        );
      } else if (minLevel <= maxLevel) {
        // Genuine range — describe it as "between X and Y" alongside the current level.
        return (
          preamble +
          `Between levels [${this.levelToText(minLevel)} and ${this.levelToText(maxLevel)}] and level ${currentLevelText}`
        );
      }
      // minLevel > maxLevel here (inverted range) — falls through to the plain fallback below.
    }

    // Fallback: no filter range active, or inverted range — return plain level name
    return preamble + currentLevelText;
  }

  /**
   * Returns the current log-level filter range.
   *
   * When both `min` and `max` are `NoOutput` (i.e. `0`), no filter is active
   * and only {@link loggingLevel} controls output.
   * When a valid range is set, messages whose level falls within
   * `[min, max]` are also output regardless of the current logging level.
   *
   * @returns An object with `min` and `max` numeric level values.
   */
  public static get loggingFilter(): { min: number; max: number } {
    return {
      min: this.options.filterMinCurrentLevel,
      max: this.options.filterMaxCurrentLevel
    };
  }

  /**
   * Sets a log-level filter range for additional output inclusion.
   *
   * Messages whose level falls within `[min, max]` will be output even if
   * they fall outside the current {@link loggingLevel}. Pass `NoOutput` (or
   * omit) for either bound to disable that side of the filter.
   *
   * Both bounds accept a named level string or a non-negative integer.
   * Invalid values fall back to `NoOutput` and emit a warning.
   *
   * @param min - Lower bound of the filter range (inclusive).
   * @param max - Upper bound of the filter range (inclusive).
   *
   * @example
   * Logger.loggingFilter = { min: Logger.Levels.Error, max: Logger.Levels.Warning };
   */
  public static set loggingFilter({
    min,
    max
  }: {
    min?: string | number;
    max?: string | number;
  }) {

    ////////////////////////////////////////////////////
    //
    // Resolves min and max independently, each following the same string/number rules as
    // the loggingLevel setter above — either bound left undefined collapses to NoOutput via
    // the ?? below, before this code ever sees it.

    // Resolve the min bound.
    if (typeof min === "string") {
      // Named level string — delegate to levelFromText (which itself falls back to
      // FrameworkDebug + warns on unrecognised text).
      this.options.filterMinCurrentLevel = this.levelFromText(min);
    } else {
      // Numeric bound — only accept a non-negative integer.
      if (Number.isInteger(min) && Number(min) >= 0) {
        this.options.filterMinCurrentLevel = min!;
      } else {
        // Invalid number — fall back to NoOutput (i.e. "this bound is disabled") and warn.
        this.options.filterMinCurrentLevel = this.Levels.NoOutput;
        Logger.writeLine(
          this.Levels.Warning,
          `Invalid Log Level [${min}] (Must be integer greater than zero). Defaulting to NoOutput!`
        );
      }
    }

    // Resolve the max bound — same string/number/fallback logic as min, independently.
    if (typeof max === "string") {
      this.options.filterMaxCurrentLevel = this.levelFromText(max);
    } else {
      if (Number.isInteger(max) && Number(max) >= 0) {
        this.options.filterMaxCurrentLevel = max!;
      } else {
        this.options.filterMaxCurrentLevel = this.Levels.NoOutput;
        Logger.writeLine(
          this.Levels.Warning,
          `Invalid Log Level [${max}] (Must be integer greater than zero). Defaulting to NoOutput!`
        );
      }
    }
  }

  /**
   * Returns the current `writeLine` formatting options.
   *
   * These control preamble suppression, max lines, timestamp format,
   * and elapsed time format for log lines written via {@link writeLine}.
   *
   * @returns The active {@link WriteLineOptions} configuration object.
   */
  public static get writeLineOptions(): WriteLineOptions {
    return this.options.writeLine;
  }

  /**
   * The default maximum number of lines {@link writeLine} outputs for any one call before
   * truncating the rest (see that method's own doc comment for the truncation behaviour) —
   * applied whenever a call doesn't supply its own `options.maxLines` override. A single
   * focused property for the one field of {@link writeLineOptions} that's actually meant
   * to be tuned at runtime (e.g. by a test runner driver resolving it from settings), rather
   * than requiring a caller to reach into the whole options object just to change it.
   *
   * @throws {Error} If set below 3 — matches {@link writeLine}'s own validation for a
   *   per-call override, applied here too so a bad global value fails immediately when
   *   set, not confusingly on whatever unrelated log call happens to trigger it next.
   *
   * @example
   * Logger.maxLines = 200;
   */
  public static set maxLines(value: number) {
    // value must actually be a number before anything else happens.
    this.assertParamType(value, "number", "Logger.maxLines", "value");
    // Reject anything below the floor writeLine itself enforces per-call, so a bad global
    // value fails immediately here rather than on whatever log call happens to use it next.
    if (value < 3) {
      Logger.logErrorAndThrow(`maxLines must be 3 or greater! Number given was <${value}>`);
    }
    this.options.writeLine.maxLines = value;
  }
  /** @see {@link maxLines} setter */
  public static get maxLines(): number {
    return this.options.writeLine.maxLines as number;
  }

  /**
   * Returns the current video attachment options.
   *
   * These defaults are used by {@link attachVideo} and {@link attachVideoFile}
   * when no explicit options are provided.
   *
   * @returns The active {@link VideoOptions} configuration object.
   */
  public static get videoOptions(): VideoOptions {
    return this.options.video;
  }

  /**
   * Sets the video attachment options used when attaching video to log output.
   *
   * Provided values are merged with the current options. If `height` or `width`
   * fall outside the valid resolution limits, both dimensions are ignored and
   * the existing values are retained.
   *
   * @param options - Partial or full {@link VideoOptions} to apply.
   *
   * @example
   * Logger.videoOptions = { videoCodec: "mp4", width: 1280, height: 720 };
   */
  public static set videoOptions(options: VideoOptions) {
    // Merge the given options over the current ones: codec falls back to whatever's
    // already configured if not given, and width/height are resolved (and validated) by
    // checkAndGetVideoResolution, which itself falls back to the current values on any
    // invalid dimension.
    this.options.video = {
      videoCodec: options.videoCodec ?? this.options.video.videoCodec,
      ...this.checkAndGetVideoResolution(options)
    };
  }

  /**
   * Clears the {@link logOutputCallback}, disabling callback-based log output.
   *
   * After calling this, log output will only go to the console
   * (if {@link logToConsole} is `true`), or be silently dropped.
   *
   * @example
   * Logger.clearOutputCallback();
   */
  public static clearOutputCallback(): void {
    this.logOutputCallback = undefined;
  }

  // ----------------------------
  // Public Attach Methods
  // ----------------------------

  /**
   * Attaches a screenshot to the log output at the specified log level.
   *
   * The screenshot is base64-encoded and passed to {@link logOutputCallback}
   * with a media type of `"base64:image/png"`. Accepts either a raw `Buffer`
   * or an existing base64 string.
   *
   * Has no effect if the given `logLevel` does not pass the current level filter.
   *
   * @param logLevel - The log level at which to attach the screenshot.
   * @param screenshot - A `Buffer` containing raw PNG data, or a base64-encoded string.
   *
   * @example
   * Logger.attachScreenshot(Logger.Levels.TestDebug, screenshotBuffer);
   */
  public static attachScreenshot(
    logLevel: number,
    screenshot: Buffer | string
  ): void {

    ////////////////////////////////////////////////////
    //
    // Normalises either a raw Buffer or an already-base64 string down to a base64 string,
    // then hands it off to attach() with the PNG-specific media type — but only actually
    // does any of that if the current level filter allows this logLevel through.

    // logLevel must actually be a number.
    this.assertParamType(logLevel, "number", "Logger.attachScreenshot", "logLevel");
    // screenshot must be one of the two accepted shapes — reject anything else up front.
    if (!Buffer.isBuffer(screenshot) && typeof screenshot !== "string") {
      const errorText = `Cannot Logger.attachScreenshot as [screenshot] must be a Buffer or string. Is [${typeof screenshot}]`;
      Logger.logErrorAndThrow(errorText);
    }
    // Only do any encoding/attach work at all if this logLevel would actually be output.
    if (this.logLevelOk(logLevel)) {
      if (typeof screenshot === "string") {
        // Already a string — treat it as raw bytes and re-encode to base64 (NOT assumed to
        // already be base64 itself).
        screenshot = Buffer.from(screenshot).toString("base64");
      } else {
        // Raw Buffer — encode directly to base64.
        screenshot = screenshot.toString("base64");
      }
      this.attach(logLevel, screenshot, "base64:image/png");
    }
  }

  /**
   * Attaches an HTML string to the log output at the specified log level.
   *
   * The HTML is passed to {@link logOutputCallback} with a media type of `"text/html"`.
   * Useful for attaching rich content such as tables or styled reports.
   *
   * Has no effect if the given `logLevel` does not pass the current level filter.
   *
   * @param logLevel - The log level at which to attach the HTML.
   * @param htmlString - A valid HTML string to attach.
   *
   * @example
   * Logger.attachHTML(Logger.Levels.TestInformation, "<b>Test passed</b>");
   */
  public static attachHTML(logLevel: number, htmlString: string): void {
    // Validate both parameter types, then delegate straight to attach() with the HTML
    // media type — attach() itself handles the level-filter check and callback dispatch.
    this.assertParamType(logLevel, "number", "Logger.attachHTML", "logLevel");
    this.assertParamType(htmlString, "string", "Logger.attachHTML", "htmlString");
    this.attach(logLevel, htmlString, "text/html");
  }

  /**
   * Reads a video file from disk and attaches it to the log output.
   *
   * The file at `videoFilePath` is read as a `Buffer` and passed to
   * {@link attachVideo}. If the file cannot be read, an error is processed
   * via {@link throwErrorIfLogOutputFails}.
   *
   * Has no effect if the given `logLevel` does not pass the current level filter.
   *
   * @param logLevel - The log level at which to attach the video.
   * @param videoFilePath - Absolute or relative path to the video file.
   * @param options - Optional {@link VideoOptions} overriding the current defaults.
   *
   * @example
   * Logger.attachVideoFile(Logger.Levels.TestDebug, "./recordings/run.webm");
   */
  public static attachVideoFile(
    logLevel: number,
    videoFilePath: string,
    options: VideoOptions = this.videoOptions
  ): void {

    ////////////////////////////////////////////////////
    //
    // Reads the video file from disk into a Buffer, then delegates to attachVideo() to do
    // the actual base64-encoding and attach(). A read failure is reported via processError
    // rather than thrown/crashed past, consistent with this framework's "never let a
    // reporting-layer failure take down the test run" stance.

    this.assertParamType(logLevel, "number", "Logger.attachVideoFile", "logLevel");
    this.assertParamType(videoFilePath, "string", "Logger.attachVideoFile", "videoFilePath");
    // Only attempt the file read at all if this logLevel would actually be output.
    if (this.logLevelOk(logLevel)) {
      let videoBuffer: Buffer;
      try {
        // Read the whole file synchronously as raw bytes.
        videoBuffer = readFileSync(videoFilePath);
      } catch (err) {
        // File couldn't be read (missing, permissions, etc.) — report via processError and
        // bail out, since there's no buffer to pass on to attachVideo.
        const errText = `Error thrown reading video data from given file path:-\n${this.errorMessage(err)}`;
        this.processError(errText);
        return;
      }
      // Read succeeded — hand the raw buffer off to attachVideo for encoding/attaching.
      this.attachVideo(logLevel, videoBuffer, options);
    }
  }

  /**
   * Attaches a video buffer to the log output at the specified log level.
   *
   * The video is base64-encoded and wrapped in an HTML `<video>` element,
   * then passed to {@link logOutputCallback} with a media type of `"text/html"`.
   * When {@link panicMode} is active, the video element is given a
   * `title="PANIC_MODE"` attribute.
   *
   * Has no effect if the given `logLevel` does not pass the current level filter.
   *
   * @param logLevel - The log level at which to attach the video.
   * @param video - A `Buffer` containing the raw video data.
   * @param options - Optional {@link VideoOptions} overriding the current defaults.
   *
   * @example
   * Logger.attachVideo(Logger.Levels.TestDebug, videoBuffer, { width: 640, height: 360 });
   */
  public static attachVideo(
    logLevel: number,
    video: Buffer,
    options?: VideoOptions
  ): void {

    ////////////////////////////////////////////////////
    //
    // Resolves the effective video options (given options merged over current defaults, or
    // the current defaults outright if none given), base64-encodes the video buffer into a
    // data: URI, builds an HTML <video> element wrapping it (tagged PANIC_MODE if active),
    // and attaches the resulting HTML. The data URI is built separately from the surrounding
    // HTML template and spliced in afterwards, purely so the (very long) base64 payload
    // never has to appear inline in the template-literal source itself.

    this.assertParamType(logLevel, "number", "Logger.attachVideo", "logLevel");
    // video must actually be a Buffer — reject anything else up front.
    if (!Buffer.isBuffer(video)) {
      const errorText = `Cannot Logger.attachVideo as [video] must be a Buffer. Is [${typeof video}]`;
      Logger.logErrorAndThrow(errorText);
    }
    // No options given — use the current defaults outright. Options given — merge codec
    // (falling back to current default) and validate/resolve width/height the same way the
    // videoOptions setter does.
    const actualOptions =
      options == null
        ? this.options.video
        : {
          videoCodec: options.videoCodec ?? this.options.video.videoCodec,
          ...this.checkAndGetVideoResolution(options)
        };

    // Base64-encode the raw video bytes into a data: URI using the resolved codec.
    const videoSourceString =
      `data:video/${actualOptions.videoCodec};base64,` +
      video.toString("base64");

    // Build the HTML <video> element with a placeholder in place of the (very long) data
    // URI, so the template literal above stays readable; title is set only in Panic Mode,
    // to flag the attachment as part of a panic-mode run.
    const videoStringNoData = `<video controls width="${actualOptions.width}" height="${actualOptions.height}"${this.panicMode ? ` title="PANIC_MODE"` : ""}><source src="<Video Data>" type="video/${actualOptions.videoCodec}">Video (Codec ${actualOptions.videoCodec}) not supported by browser</video>`;

    // Splice the actual data URI into the placeholder left in the template above.
    const videoString = videoStringNoData.replace(
      "<Video Data>",
      videoSourceString
    );
    this.attach(logLevel, videoString, "text/html");
  }

  /**
   * Passes arbitrary data to the {@link logOutputCallback} at the specified log level.
   *
   * If the callback is not set, an error is logged instead. If the callback throws,
   * the error is processed via {@link throwErrorIfLogOutputFails}.
   *
   * Has no effect if the given `logLevel` does not pass the current level filter.
   *
   * @param logLevel - The log level at which to attach the data.
   * @param dataString - The data payload to pass to the callback.
   * @param mediaType - A MIME-type-style string describing the data
   *   (e.g. `"text/html"`, `"base64:image/png"`).
   *
   * @example
   * Logger.attach(Logger.Levels.TestDebug, myPayload, "text/plain");
   */
  public static attach(
    logLevel: number,
    dataString: string,
    mediaType: string
  ): void {

    ////////////////////////////////////////////////////
    //
    // Dispatches an already-prepared payload straight to the output callback (if the level
    // filter allows it and a callback is actually configured), catching and reporting via
    // processError if the callback itself throws, and logging an error instead if no
    // callback is configured at all.

    this.assertParamType(logLevel, "number", "Logger.attach", "logLevel");
    // Note: dataString is deliberately not type-checked here — attach() tolerates
    // non-string payloads (see truncateForDisplay), so callback errors can still
    // describe what was actually passed instead of crashing before reaching it.
    this.assertParamType(mediaType, "string", "Logger.attach", "mediaType");
    // Only attempt to dispatch anything if this logLevel would actually be output.
    if (this.logLevelOk(logLevel)) {
      if (typeof this.logOutputCallback === "function") {
        try {
          // Call the configured callback with the payload and media type.
          this.logOutputCallback(dataString, mediaType);
        } catch (err) {
          // Callback itself threw — report via processError rather than letting the
          // exception propagate up through attach()'s own caller.
          const errText = `Error thrown from Log Output Callback:-\n${this.errorMessage(err)}\nwhen called with data string:-\n${this.truncateForDisplay(dataString)}\nand mediaType:-\n${this.truncateForDisplay(mediaType)}`;
          this.processError(errText);
        }
      } else {
        // No callback configured (or it's not actually a function) — nothing to attach to,
        // so log an error describing why instead of silently doing nothing.
        Logger.writeLine(
          this.Levels.Error,
          `Log Output callback is type [${typeof this.logOutputCallback}].  Must be type [function].  No attach performed.`
        );
      }
    }
  }

  // ----------------------------
  // Public writeLine
  // ----------------------------

  /**
   * Writes a log line (or multiple lines) at the specified log level.
   *
   * Multi-line strings are split and each line is written individually.
   * If the total number of lines exceeds `maxLines`, intermediate lines
   * are replaced with a single truncation notice.
   *
   * Each line is prefixed with a preamble (timestamp, elapsed time, calling method,
   * and level label) unless suppressed via `options` or the global
   * {@link writeLineOptions} configuration.
   *
   * Has no effect if the given `logLevel` does not pass the current level filter
   * (unless {@link panicMode} is active).
   *
   * @param logLevel - The log level at which to write the message.
   * @param textString - The message to log. May contain newlines.
   * @param options - Optional per-call overrides for {@link WriteLineOptions}.
   *
   * @example
   * Logger.writeLine(Logger.Levels.TestInformation, "Test started");
   * Logger.writeLine(Logger.Levels.Warning, "Something looks off", { suppressAllPreamble: true });
   */
  public static writeLine(
    logLevel: number,
    textString: string,
    options?: WriteLineOptions
  ): void {

    ////////////////////////////////////////////////////
    //
    // Resolves every formatting option (per-call override, falling back to the global
    // writeLine config), captures the caller's stack-frame identity for the preamble, splits
    // the message into individual lines, and writes each line (or a truncation notice in
    // place of a run of skipped lines) via doWriteLine — unless this call is itself
    // originating from inside doWriteLine, in which case nothing is written at all (see the
    // stack check below, which guards against that specific internal-recursion case).

    this.assertParamType(logLevel, "number", "Logger.writeLine", "logLevel");
    this.assertParamType(textString, "string", "Logger.writeLine", "textString");
    // Capture a stack trace rooted at this call (skipping writeLine's own frame), so
    // callingMethodDetails can walk past Logger's own internal frames to find the real
    // caller for the preamble's [source] segment.
    const stackObj: unknown = {};
    Error.captureStackTrace(stackObj as object, this.writeLine);
    const stack = (stackObj as Error)?.stack ?? "[Unknown]";
    const callingMethodDetails = this.callingMethodDetails(stack, options?.stackOffset ?? 0);

    // Resolve every formatting option: a per-call override in `options` wins; otherwise
    // fall back to the equivalent global writeLine setting.
    const maxLines =
      options?.maxLines ?? (this.options.writeLine.maxLines as number);
    const suppressAllPreamble =
      options?.suppressAllPreamble ??
      this.options.writeLine.suppressAllPreamble;
    const suppressMultilinePreamble =
      options?.suppressMultilinePreamble ??
      this.options.writeLine.suppressMultilinePreamble;
    const suppressTimeStamp =
      options?.suppressTimeStamp ?? this.options.writeLine.suppressTimeStamp;
    const suppressElapsed =
      options?.suppressElapsed ?? this.options.writeLine.suppressElapsed;
    const suppressLevel =
      options?.suppressLevel ?? this.options.writeLine.suppressLevel ?? false;
    const suppressSource =
      options?.suppressSource ?? this.options.writeLine.suppressSource ?? false;
    // timeFormat/elapsedFormat collapse to undefined when their respective suppress flag is
    // set — getPreAmble reads an undefined format as "omit this segment entirely".
    const timeFormat = suppressTimeStamp
      ? undefined
      : (options?.timeFormat ?? this.options.writeLine.timeFormat);
    const elapsedFormat = suppressElapsed
      ? undefined
      : (options?.elapsedFormat ?? this.options.writeLine.elapsedFormat);

    // Guard against writeLine being re-entered from inside doWriteLine itself (e.g. a
    // warning logged while already mid-write) — if the captured stack shows doWriteLine is
    // already on it, skip writing anything at all rather than recursing.
    if (!stack.includes(".doWriteLine")) {
      // maxLines below 1 would make every single line "too many" — floor it at 1 so the
      // truncation logic below always has at least one line to show.
      const normalizedMaxLines = maxLines < 1 ? 1 : maxLines;
      // Multi-line messages are split on any CRLF or LF boundary and written one line at a time.
      const textArray = textString.split(/\r?\n/);
      let isFirstLine = true;

      // maxLines must be at least 3 (one line, one truncation notice, one last line) for the
      // truncation logic below to make sense at all — reject anything lower immediately.
      if (normalizedMaxLines < 3) {
        const errorMessage = `maxLines must be 3 or greater!  Number given was <${maxLines}>`
        Logger.logErrorAndThrow(errorMessage);
      }

      // Walk every split line, deciding for each whether to write it as-is, replace it (and
      // the lines around it) with a single truncation notice, or skip it entirely.
      textArray.forEach((line: string, index: number) => {
        if (
          textArray.length <= normalizedMaxLines ||
          index < normalizedMaxLines - 2 ||
          index === textArray.length - 1
        ) {
          // Either the whole message already fits within maxLines, or this line is within
          // the kept "head" portion, or it's the very last line (always kept so the message
          // visibly ends) — write it normally. The preamble is suppressed on this line only
          // if suppressAllPreamble is set, or suppressMultilinePreamble is set and this isn't
          // the first line of the message.
          this.doWriteLine(
            !(suppressAllPreamble || (suppressMultilinePreamble && !isFirstLine)),
            callingMethodDetails,
            logLevel,
            line,
            { time: timeFormat, elapsed: elapsedFormat, suppressLevel, suppressSource }
          );
        } else if (index === normalizedMaxLines - 2) {
          // This is the one line immediately after the kept "head" portion — instead of
          // writing it (and all the other skipped lines in between), write a single
          // truncation notice here that reports how many lines were actually skipped.
          this.doWriteLine(
            !(suppressAllPreamble || (suppressMultilinePreamble && !isFirstLine)),
            callingMethodDetails,
            logLevel,
            `... (Skipping some lines as total length (${textArray.length}) > ${normalizedMaxLines}!!)`,
            { time: timeFormat, elapsed: elapsedFormat, suppressLevel, suppressSource }
          );
        }
        // Any other index falls through both branches above and is silently skipped — it's
        // one of the lines already accounted for by the truncation notice.

        isFirstLine = false;
      });
    }
  }

  /**
   * Builds an `Error` from `message`, logs it at {@link Levels.Error}, and throws it —
   * collapsing the "build message, log it, throw it" pattern used throughout this package
   * into one call. Typed `never` so TypeScript still treats code after the call as
   * unreachable, exactly as it would after a bare `throw` — this holds even for a bare
   * statement call, no `throw` keyword needed at the call site, as long as the call is the
   * last thing in that code path.
   *
   * No manual `stackOffset` bump needed here — {@link callingMethodDetails}'s own
   * internal-frame skip already walks past this method's frame (and any other Logger-internal
   * frame, however many deep) automatically, since it recognises any frame whose file is this
   * same module. `options.stackOffset`, if the caller passes it, is still honoured as-is —
   * that's for a *caller's own* generic-helper chain (outside this file, which this method's
   * internal-frame skip has no way to recognise), not for this method's own frame.
   *
   * @param message - The error message. Logged as-is, then used to construct the thrown `Error`.
   * @param options - Same {@link WriteLineOptions} as {@link writeLine}.
   * @throws {Error} Always — this function never returns.
   *
   * @example
   * if (bad) Logger.logErrorAndThrow(`Cannot frobnicate as [x] is bad`);
   * // equivalent to, but replaces:
   * //   const errText = `Cannot frobnicate as [x] is bad`;
   * //   Logger.writeLine(Logger.Levels.Error, errText);
   * //   throw new Error(errText);
   */
  public static logErrorAndThrow(message: string, options?: WriteLineOptions): never {
    // Log the message at Error level first — see this method's own doc comment above for why
    // no stackOffset bump is needed for this method's own frame specifically.
    Logger.writeLine(this.Levels.Error, message, options);
    // Then throw, so callers get the usual `never`-typed unreachable-after-this-call behaviour.
    throw new Error(message);
  }

  // ----------------------------
  // Private Utilities
  // ----------------------------

  /** Builds a fresh default options object. Extracted so both the field initialiser and reset() share one source of truth. */
  private static buildDefaultOptions(): Options {
    return {
      loggingCurrentLevel: DEFAULT_LOG_LEVEL,
      filterMinCurrentLevel: Logger.Levels.NoOutput,
      filterMaxCurrentLevel: Logger.Levels.NoOutput,
      logToConsole: DEFAULT_LOG_TO_CONSOLE,
      throwErrorIfLogOutputFails: DEFAULT_THROW_ERROR_LOG_FAIL,
      panicMode: DEFAULT_PANIC_MODE,
      panicCodePreamble: DEFAULT_PANIC_CODE,
      panicDescriptorPreamble: DEFAULT_PANIC_DESCRIPTOR,
      writeLine: {
        maxLines: DEFAULT_WRITELINE_MAX_LINES,
        suppressTimeStamp: DEFAULT_WRITELINE_SUPPRESS_TIME,
        suppressElapsed: DEFAULT_WRITELINE_SUPPRESS_ELAPSED,
        suppressLevel: DEFAULT_WRITELINE_SUPPRESS_LEVEL,
        suppressSource: DEFAULT_WRITELINE_SUPPRESS_SOURCE,
        suppressAllPreamble: DEFAULT_WRITELINE_SUPPRESS_ALL,
        suppressMultilinePreamble: DEFAULT_WRITELINE_SUPPRESS_MULTI,
        timeFormat: DEFAULT_WRITELINE_FORMAT_TIME,
        elapsedFormat: DEFAULT_WRITELINE_FORMAT_ELAPSED
      },
      video: {
        videoCodec: DEFAULT_VIDEO_CODEC,
        width: DEFAULT_VIDEO_WIDTH,
        height: DEFAULT_VIDEO_HEIGHT
      }
    };
  }

  /** Maps a numeric level to its human-readable description — the inverse of {@link levelFromText}'s named-level cases. */
  private static levelToText(level: number): string {
    switch (level) {
      // Each of the named levels maps to its own fixed descriptive string, including the
      // short bracketed code used elsewhere (e.g. the write-type label in getPreAmble).
      case this.Levels.FrameworkDebug:
        return "Framework debug (FKDBG)";
      case this.Levels.FrameworkInformation:
        return "Framework information (FKINF)";
      case this.Levels.TestDebug:
        return "Test debug (TSDBG)";
      case this.Levels.TestInformation:
        return "Test information (TSINF)";
      case this.Levels.Warning:
        return "Errors (ERROR) & Warnings (WARNING) only";
      case this.Levels.Error:
        return "Errors only (ERROR)";
      case this.Levels.NoOutput:
        return "No output from Log (NOOUT)";
      default:
        // Not one of the named levels — a negative number is always invalid ("Unknown!"),
        // while a non-negative-but-unrecognised number is treated as a legitimate custom
        // ("special") level and described using the currently configured level value.
        return level < 0
          ? "Unknown!"
          : `Special Level - (${this.options.loggingCurrentLevel})`;
    }
  }

  /** Maps a named level string (case/whitespace-insensitive) to its numeric level — the inverse of {@link levelToText}. */
  private static levelFromText(text: string): number {
    // Strip all whitespace so e.g. "Framework Debug", "frameworkdebug", "framework debug" all match
    switch (text.toLowerCase().replace(/\s+/g, "")) {
      // "Maximum verbosity" has several accepted spellings, all mapping to the same sentinel value.
      case "special":
      case "verbose":
      case "maximum":
      case "max":
        return Number.MAX_SAFE_INTEGER;
      // Each named level accepts both its full name and its short bracketed code.
      case "frameworkdebug":
      case "fkdbg":
        return this.Levels.FrameworkDebug;
      case "frameworkinformation":
      case "fkinf":
        return this.Levels.FrameworkInformation;
      case "testdebug":
      case "tsdbg":
        return this.Levels.TestDebug;
      case "testinformation":
      case "tsinf":
        return this.Levels.TestInformation;
      case "warn":
      case "warng":
      case "warning":
        return this.Levels.Warning;
      case "error":
        return this.Levels.Error;
      case "nooutput":
      case "noout":
        return this.Levels.NoOutput;
      default: {
        // Unrecognised text — warn and fall back to FrameworkDebug. The warning itself is
        // logged via writeLine, which would otherwise be filtered by whatever level is
        // currently configured, so the current level is temporarily swapped to FrameworkDebug
        // (guaranteeing the warning is actually seen) and restored again immediately after.
        const actualLevel = this.options.loggingCurrentLevel;
        this.options.loggingCurrentLevel = this.Levels.FrameworkDebug;
        Logger.writeLine(
          this.Levels.Warning,
          `Unknown Log Level [${text}]. Defaulting to Framework Debug!`
        );
        this.options.loggingCurrentLevel = actualLevel;
        return this.Levels.FrameworkDebug;
      }
    }
  }

  private static checkAndGetVideoResolution(resolution: {
    height?: number;
    width?: number;
  }): { height: number; width: number } {

    ////////////////////////////////////////////////////
    //
    // Resolves a final height/width pair from a partial resolution override: each dimension
    // individually defaults to the current value if omitted, but if either given dimension
    // fails validation, BOTH dimensions fall back to current values — a resolution override
    // is accepted as a matched pair or not at all, never applied half-valid/half-stale.

    // height is only checked if actually given (undefined/null is always "valid" — it just
    // means "keep the current height"). isValidVideoResolutionNumber itself warns on failure.
    const heightValid =
      resolution.height == null ||
      this.isValidVideoResolutionNumber(
        resolution.height,
        this.videoResolutionLimits.minHeight,
        this.videoResolutionLimits.maxHeight,
        `Invalid video window height [${resolution.height}]: must be number equal or between ${this.videoResolutionLimits.minHeight} and ${this.videoResolutionLimits.maxHeight}. Height (and width if set) ignored`
      );
    // Same validation, independently, for width.
    const widthValid =
      resolution.width == null ||
      this.isValidVideoResolutionNumber(
        resolution.width,
        this.videoResolutionLimits.minWidth,
        this.videoResolutionLimits.maxWidth,
        `Invalid video window width [${resolution.width}]: must be number equal or between ${this.videoResolutionLimits.minWidth} and ${this.videoResolutionLimits.maxWidth}. Width (and height if set) ignored`
      );

    // height resolves to: current value if omitted; the new value if given AND both
    // dimensions passed validation; otherwise the current value (validation failure on
    // either side falls both dimensions back, not just the invalid one).
    const height = (
      resolution.height == null
        ? this.options.video.height
        : heightValid && widthValid
          ? resolution.height
          : this.options.video.height
    ) as number;
    // Same resolution logic, independently, for width.
    const width = (
      resolution.width == null
        ? this.options.video.width
        : heightValid && widthValid
          ? resolution.width
          : this.options.video.width
    ) as number;
    return { height, width };
  }

  private static doWriteLine(
    doPreamble: boolean,
    callingMethodDetails: string,
    logLevel: number,
    textString: string,
    formatOptions: { time?: string; elapsed?: string; suppressLevel: boolean; suppressSource: boolean }
  ): void {

    ////////////////////////////////////////////////////
    //
    // Writes exactly one already-split line: builds the preamble (if requested), writes to
    // the console (if enabled) and the output callback (if configured) independently, and
    // guarantees the line reaches the console as a last resort if neither destination
    // actually wrote it — so a line is never silently dropped just because both outputs
    // happen to be unavailable/misconfigured.

    if (this.logLevelOk(logLevel)) {
      const callBackGood = typeof this.logOutputCallback === "function";
      // Build the preamble only if doPreamble says to — otherwise this line gets no prefix at all.
      const preAmble = doPreamble
        ? this.getPreAmble(callingMethodDetails, logLevel, formatOptions)
        : "";
      const textToWrite = preAmble + textString;
      let doneConsoleWrite = false;
      let doneCallbackWrite = false;

      // Console output is independent of, and in addition to, any configured callback.
      if (this.options.logToConsole) {
        console.log(textToWrite);
        doneConsoleWrite = true;
      }

      if (callBackGood) {
        try {
          // Plain writeLine output passes only the formatted text — no mediaType, unlike attach().
          this.logOutputCallback!(textToWrite);
          doneCallbackWrite = true;
        } catch (err) {
          const errText = `Error thrown from Log Output Callback during writeLine:-\n${this.errorMessage(err)}`;
          // Avoid infinite recursion: log directly to console rather than calling processError -> writeLine
          console.error(errText);
          // Only re-throw if explicitly configured to — otherwise the failure is reported
          // (above) but swallowed, so one bad callback doesn't take down the whole test run.
          if (this.options.throwErrorIfLogOutputFails) {
            throw new Error(errText);
          }
        }
      }

      // Neither the console write nor the callback write actually happened (e.g. logToConsole
      // is off and no callback is configured) — fall back to console.log as a last resort so
      // the line is never silently lost.
      if (!doneConsoleWrite && !doneCallbackWrite) {
        console.log(textToWrite);
      }
    }
  }

  private static getPreAmble(
    methodBase: string,
    typeOfWrite: number,
    timeFormat: { time?: string; elapsed?: string; suppressLevel: boolean; suppressSource: boolean }
  ): string {

    ////////////////////////////////////////////////////
    //
    // Builds the full preamble string prefixed to a log line: write-type label (with Panic
    // Mode prefix), timestamp, elapsed time, and calling-method source — each segment
    // independently omitted (as an empty string) when its corresponding suppress option is
    // active, then joined into one fixed-shape string.

    // suppressLevel omits the write-type label itself (e.g. "TSINF") — panicMode's prefix
    // rides along with it, since a suppressed level label has nothing to prefix.
    const writeType = timeFormat.suppressLevel
      ? ""
      : (this.options.panicMode ? this.options.panicCodePreamble : "") +
        this.getWriteTypeString(typeOfWrite);

    // timeFormat.time is undefined when suppressTimeStamp is active
    const timeStamp =
      timeFormat.time === undefined
        ? ""
        : `[${format(Date.now(), timeFormat.time)}]`;

    // timeFormat.elapsed is undefined when suppressElapsed is active
    const diff = Date.now() - this.startTime;
    const utcDate = new Date(diff);
    utcDate.setMinutes(utcDate.getMinutes() + utcDate.getTimezoneOffset());
    const elapsedTime =
      timeFormat.elapsed === undefined
        ? ""
        : `[${format(utcDate, timeFormat.elapsed)}]`;

    // The source segment's own leading space lives inside this conditional (rather than as
    // a fixed literal in the template below) so suppressing it doesn't leave a stray space
    // before the trailing ": " — e.g. "TSINF - [12:15:17][00:00.245]: " not "...245] : ".
    const source = timeFormat.suppressSource ? "" : ` [${methodBase}]`;

    // Join every segment into the final fixed-shape preamble string.
    return `${writeType} - ${timeStamp}${elapsedTime}${source}: `;
  }

  /**
   * Left-pads a number (or numeric string) with zeroes to reach the required minimum length.
   * Kept private and self-contained so `logger.ts` has no external utility dependencies.
   */
  private static getWriteTypeString(levelOfWrite: number): string {
    switch (levelOfWrite) {
      // Each named level maps to its fixed 5-character code, used as the preamble's
      // write-type label.
      case this.Levels.Error:
        return "ERROR";
      case this.Levels.Warning:
        return "WARNG";
      case this.Levels.FrameworkDebug:
        return "FKDBG";
      case this.Levels.FrameworkInformation:
        return "FKINF";
      case this.Levels.TestDebug:
        return "TSDBG";
      case this.Levels.TestInformation:
        return "TSINF";
      default:
        // Not a named level (e.g. a custom/"special" level) — show the raw number,
        // zero-padded to the same width as the named codes above, so columns still line up.
        return String(levelOfWrite).padStart(WRITE_TYPE_PAD_WIDTH, "0");
    }
  }

  private static callingMethodDetails(methodBase: string, stackOffset = 0): string {

    ////////////////////////////////////////////////////
    //
    // Parses a captured V8 stack-trace string to find the "real" caller's method name (plus,
    // where it can be extracted, its source file/line), skipping past Logger's own internal
    // stack frames first (however many deep — see LOGGER_STACK_FRAME_MARKER), then skipping
    // stackOffset further frames past that for a caller with its OWN generic-helper chain
    // outside this file, which the marker has no way to recognise.

    let methodName = "<Unknown>";
    let typeName = "";
    if (methodBase) {
      // Line 0 of a captured stack is just "Error" / the message — the actual frames start at line 1.
      const methodBaseLines = methodBase.split("\n");
      if (methodBaseLines.length > 1) {
        // Skip past internal Logger stack frames to find the real caller
        let indexOfFirstNonLogLine = methodBaseLines
          .slice(1)
          .findIndex((item) => !item.includes(LOGGER_STACK_FRAME_MARKER));
        // findIndex returns -1 if every remaining frame is a Logger frame (shouldn't normally
        // happen) — fall back to the first frame after the header line in that case.
        indexOfFirstNonLogLine =
          indexOfFirstNonLogLine === -1 ? 1 : indexOfFirstNonLogLine + 1;
        // stackOffset lets a generic helper attribute the log line further up the stack, past
        // its own frame — never negative, and never past the end of the captured stack.
        const safeOffset = Math.max(0, stackOffset);
        const targetIndex = Math.min(indexOfFirstNonLogLine + safeOffset, methodBaseLines.length - 1);
        // Collapse any run of internal whitespace down to a single space, then trim the ends.
        methodName = methodBaseLines[targetIndex]
          .replace(/\s\s+/g, " ")
          .trim();
        if (methodName.startsWith("at ")) {
          // Strip the "at " prefix — what's left is one of two V8 frame shapes: a named
          // function/method with its location in parens ("FuncName (file:line:col)"), or —
          // when V8 can't resolve a function name at all (e.g. top-level module-scope code) —
          // just the bare location with no parens ("file:line:col"). Both need handling; a
          // frame with no resolvable name is common, not an edge case to ignore.
          const rest = methodName.slice(3).trim();
          const parenMatch = rest.match(/^(.+)\s\((.+)\)$/);
          // Named-function shape gives a real function name; the bare shape has none at all.
          methodName = parenMatch ? parenMatch[1] : "";
          const rawLocation = parenMatch ? parenMatch[2] : rest;
          typeName = this.formatFrameLocation(rawLocation);
        }
      }
    }
    // Combine method name with the extracted file segment (if any) as "methodName(typeName)" —
    // or just the bare file segment if no function name was resolvable at all.
    return methodName === "" ? typeName : `${methodName}(${typeName})`;
  }

  /**
   * Converts a V8 stack frame's raw location text (e.g.
   * `"file:///home/.../dist/esm/apiUtils/APIUtils.js:237:22"`) into a short display form:
   * just the filename and line/column, prefixed with the nearest enclosing `@controlium/*`
   * package's short tag when the file lives inside one (e.g. `"controlium/utils:APIUtils.js:237:22"`,
   * `"controlium/framework:lifecycle.js:62:9"`) — or just the bare filename:line:col when it
   * doesn't (the caller's own test/application code, a third-party dependency, etc.).
   *
   * Falls back to returning `rawLocation` completely unchanged if it doesn't match the
   * expected `<path-or-url>:<line>:<col>` shape at all (e.g. a native/internal V8 frame) —
   * this is cosmetic formatting for a log line, never worth throwing over.
   */
  private static formatFrameLocation(rawLocation: string): string {
    // Expect the location to end in ":<line>:<col>" — anything else (native frames, eval
    // frames, etc.) isn't a shape this can usefully shorten, so it's shown as-is.
    const locationMatch = rawLocation.match(/^(.*):(\d+):(\d+)$/);
    if (!locationMatch) return rawLocation;
    const [, pathOrUrl, line, col] = locationMatch;

    let absolutePath: string;
    try {
      // ESM frames are "file://" URLs, not plain paths — fileURLToPath handles the scheme
      // (and percent-decoding) correctly; a plain path (seen in some frame shapes) is used
      // as-is since there's nothing to convert.
      absolutePath = pathOrUrl.startsWith("file://") ? fileURLToPath(pathOrUrl) : pathOrUrl;
    } catch {
      // Malformed URL for whatever reason — degrade gracefully to the original text rather
      // than letting a logging-formatting quirk throw.
      return rawLocation;
    }

    const fileName = basename(absolutePath);
    const packageTag = this.resolveControliumPackageTag(dirname(absolutePath));
    return packageTag ? `${packageTag}:${fileName}:${line}:${col}` : `${fileName}:${line}:${col}`;
  }

  /**
   * Walks upward from `startDir` looking for the nearest `package.json`, and returns that
   * package's short tag (e.g. `"controlium/utils"` for `@controlium/utils`) if its `name`
   * starts with `@controlium/` — or `null` if the nearest `package.json` belongs to some
   * other package entirely, or none is found before reaching the filesystem root.
   *
   * Deliberately does NOT look for any particular path substring (`"utils/"`,
   * `"node_modules/@controlium/"`, etc.) — that would only work for whichever install/link
   * topology it was written against. A package's own `package.json` `name` field is the one
   * thing that's actually true regardless of topology: an npm/pnpm workspace symlink (Node
   * resolves/loads the real, symlink-target file, so its real path's directory structure
   * still leads to that same real `package.json`), a genuine `node_modules` install, or
   * running straight from this monorepo's own source — all three lead to the same file.
   *
   * Results are cached per-directory in {@link CONTROLIUM_PACKAGE_TAG_CACHE} — this walk (and
   * the `package.json` read/parse) only ever happens once per distinct directory seen, for
   * the life of the process, not once per log line.
   */
  private static resolveControliumPackageTag(startDir: string): string | null {
    const cached = CONTROLIUM_PACKAGE_TAG_CACHE.get(startDir);
    if (cached !== undefined) return cached;

    let tag: string | null = null;
    let dir = startDir;
    // Walk up one directory at a time until a package.json turns up, or there's nowhere
    // further up to go (dirname of the filesystem root returns the root itself, unchanged).
    // Terminates via the explicit `break`s below, not the loop condition itself.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        try {
          const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown };
          // Only a genuine @controlium/* package gets a tag — anything else (the caller's
          // own project, a third-party dependency) is intentionally left untagged.
          if (typeof pkg.name === "string" && pkg.name.startsWith("@controlium/")) {
            // "@controlium/utils" -> "controlium/utils" — just the leading "@" dropped.
            tag = pkg.name.slice(1);
          }
        } catch {
          // Malformed/unreadable package.json — treat exactly like "not found", not an error
          // worth surfacing over a cosmetic log-formatting detail.
        }
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached the filesystem root with no package.json at all
      dir = parent;
    }

    CONTROLIUM_PACKAGE_TAG_CACHE.set(startDir, tag);
    return tag;
  }

  private static isValidVideoResolutionNumber(
    val: number,
    min: number,
    max: number,
    errorMessage: string
  ): boolean {

    ////////////////////////////////////////////////////
    //
    // Validates a single video dimension value: a wrong-type value is a hard failure
    // (warns at Error level and throws), while an in-type-but-out-of-range value is a soft
    // failure (warns and returns false, letting the caller fall back to the current value
    // rather than aborting entirely).

    if (typeof val === "number") {
      // In range and a whole number — valid.
      if (Number.isInteger(val) && val >= min && val <= max) return true;
      // Right type, but out of range or not an integer — warn and let the caller fall back.
      Logger.writeLine(this.Levels.Warning, errorMessage);
      return false;
    } else {
      // Wrong type entirely — this is a caller bug (TypeScript's own type promises weren't
      // honoured at runtime), so this is treated as fatal rather than a soft fallback.
      Logger.writeLine(this.Levels.Error, errorMessage);
      throw new Error(
        `Resolution number given was a <${typeof val}>!  Must only be a number!`
      );
    }
  }

  private static logLevelOk(passedInLogLevel: number): boolean {

    ////////////////////////////////////////////////////
    //
    // Decides whether a message at passedInLogLevel should actually be output, by checking
    // Panic Mode first, then NoOutput, then whether the level passes either the main
    // threshold or the separate min/max filter range (either one passing is enough).

    // Panic Mode overrides every other check — everything is output regardless of level.
    if (this.panicMode === true) return true;
    // NoOutput as the level being checked always means "never output this", regardless of
    // the current threshold or filter range.
    if (passedInLogLevel === this.Levels.NoOutput) return false;
    // Passes the main threshold if its level is at or below the currently configured level.
    const withinCurrentLevel =
      passedInLogLevel <= this.options.loggingCurrentLevel;
    // Separately, also passes if it falls within the configured min/max filter range — this
    // lets specific levels be included even when they'd otherwise fail the main threshold.
    const withinFilterRange =
      passedInLogLevel >= this.options.filterMinCurrentLevel &&
      passedInLogLevel <= this.options.filterMaxCurrentLevel;
    // Either check passing is sufficient for output.
    return withinCurrentLevel || withinFilterRange;
  }

  /**
   * Local equivalent of `Utils.assertType`, duplicated for the same reason as
   * {@link errorMessage} below — `Logger` sits below `Utils` in the module dependency
   * graph and must not import it back. Throws a logged error if `value` isn't of
   * `expectedType`; the caller cannot be trusted to have actually passed what its
   * TypeScript signature promises.
   */
  private static assertParamType(value: unknown, expectedType: "string" | "number", funcName: string, paramName: string): void {
    // Only acts when the runtime type doesn't match what was promised — otherwise a no-op.
    if (typeof value !== expectedType) {
      const errorText = `Cannot ${funcName} as [${paramName}] not '${expectedType}' type. Is [${typeof value}]`;
      // No manual stackOffset needed — this method's own frame (and logErrorAndThrow's) are
      // both inside this same module, so callingMethodDetails's internal-frame skip walks
      // past both automatically, however many Logger-internal frames deep this chain goes
      // (e.g. this helper reused from writeLine/attach*/loggingLevelDescription).
      Logger.logErrorAndThrow(errorText);
    }
  }

  /**
   * Safely extracts a human-readable message from a caught value of unknown shape, without
   * throwing itself (a bare `(err as Error).message` cast throws a new, unrelated `TypeError`
   * when `err` isn't actually an `Error`, masking the original failure). Duplicated from
   * `Utils.errorMessage` rather than imported — `Logger` sits below `Utils` in the module
   * dependency graph and must not import it back.
   */
  private static errorMessage(err: unknown): string {
    // Real Error instance — use its own message directly.
    if (err instanceof Error) return err.message;
    // Already a plain string — use it as-is.
    if (typeof err === "string") return err;
    // Anything else (object, number, etc.) — try to render it as JSON for a readable
    // message; JSON.stringify returning undefined (e.g. for a function) falls back to
    // String(err), and a thrown stringify (e.g. a circular reference) is caught below.
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      return String(err);
    }
  }

  private static processError(errorText: string): void {
    // Caller has opted in to hard failure on output errors — throw rather than just logging.
    if (this.options.throwErrorIfLogOutputFails) {
      throw new Error(errorText);
    } else {
      // Default behaviour — log the error (with per-line preamble suppressed, since
      // errorText is often itself a multi-line message) rather than crashing the caller.
      Logger.writeLine(this.Levels.Error, errorText, {
        suppressMultilinePreamble: true
      });
    }
  }

  /**
   * Truncates a string for safe display in error messages.
   * Shows the first {@link ERROR_DISPLAY_STRING_HEAD_LENGTH} characters, an ellipsis,
   * and the last {@link ERROR_DISPLAY_STRING_TAIL_LENGTH} characters when the string
   * exceeds {@link ERROR_DISPLAY_STRING_MAX_LENGTH}.
   */
  private static truncateForDisplay(value: unknown): string {
    // Not actually a string (attach() deliberately doesn't type-check its dataString param,
    // see attach()'s own comment) — describe its type instead of trying to slice it.
    if (typeof value !== "string") {
      return `<Not a string! Is type ${typeof value}>`;
    }
    // Long enough to need truncating — keep a head and tail portion with an ellipsis between.
    if (value.length > ERROR_DISPLAY_STRING_MAX_LENGTH) {
      return (
        value.slice(0, ERROR_DISPLAY_STRING_HEAD_LENGTH) +
        "..." +
        value.slice(-ERROR_DISPLAY_STRING_TAIL_LENGTH)
      );
    }
    // Short enough already — return unchanged.
    return value;
  }
}