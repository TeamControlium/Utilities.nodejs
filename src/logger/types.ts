/**
 * A numeric log level value, as defined by {@link Logger.Levels}.
 */
export type LogLevel = number;

/**
 * Options controlling how attached video content is encoded and sized.
 *
 * All fields are optional — omitted values fall back to the Logger's
 * current video defaults. Use {@link ResolvedVideoOptions} where all
 * fields are guaranteed to be present (i.e. after merging with defaults).
 */
export interface VideoOptions {
  /**
   * Video codec identifier embedded in the `<video>` tag's MIME type.
   *
   * @example "webm"
   * @example "mp4"
   */
  videoCodec?: string;

  /**
   * Output video width in pixels.
   * Must fall within the Logger's internal min/max resolution limits.
   * If invalid, both width and height are ignored and the current defaults are kept.
   */
  width?: number;

  /**
   * Output video height in pixels.
   * Must fall within the Logger's internal min/max resolution limits.
   * If invalid, both width and height are ignored and the current defaults are kept.
   */
  height?: number;
}

/**
 * A fully-resolved video options object in which all fields are guaranteed present.
 *
 * Used internally by `Logger` after merging any user-supplied {@link VideoOptions}
 * with the configured defaults. Stored on {@link Options.video} so read sites
 * never need to null-guard individual fields.
 */
export interface ResolvedVideoOptions {
  /**
   * Video codec identifier embedded in the `<video>` tag's MIME type.
   *
   * @example "webm"
   * @example "mp4"
   */
  videoCodec: string;

  /** Output video width in pixels. */
  width: number;

  /** Output video height in pixels. */
  height: number;
}

/**
 * Controls how {@link Logger.writeLine} formats and emits its output.
 *
 * All fields are optional — omitted values fall back to the Logger's
 * current `writeLineOptions` defaults. Options can be supplied per-call
 * to override defaults for a single `writeLine` invocation.
 */
export interface WriteLineOptions {
  /**
   * Maximum number of lines emitted from a multi-line input string.
   *
   * When the input contains more lines than this limit, intermediate lines
   * are dropped and replaced with a single truncation notice showing how
   * many lines were skipped. The first and last lines are always preserved.
   *
   * A value less than `1` is treated as `1`.
   */
  maxLines?: number;

  /**
   * When `true`, the preamble is suppressed for every line after the first
   * in a multi-line message. The first line still receives a full preamble.
   *
   * Has no effect when {@link suppressAllPreamble} is `true`.
   */
  suppressMultilinePreamble?: boolean;

  /**
   * When `true`, the preamble is suppressed for every output line,
   * whether the input is single-line or multi-line.
   *
   * Takes precedence over {@link suppressMultilinePreamble}.
   */
  suppressAllPreamble?: boolean;

  /**
   * When `true`, the wall-clock timestamp is omitted from the preamble.
   *
   * Has no effect when {@link suppressAllPreamble} is `true`.
   */
  suppressTimeStamp?: boolean;

  /**
   * When `true`, the elapsed-time value is omitted from the preamble.
   *
   * Has no effect when {@link suppressAllPreamble} is `true`.
   */
  suppressElapsed?: boolean;

  /**
   * When `true`, the level label (e.g. `TSINF`) is omitted from the preamble.
   *
   * Has no effect when {@link suppressAllPreamble} is `true`.
   */
  suppressLevel?: boolean;

  /**
   * When `true`, the call-site label (the `[MethodName (file:line:col)]` segment)
   * is omitted from the preamble.
   *
   * Has no effect when {@link suppressAllPreamble} is `true`.
   */
  suppressSource?: boolean;

  /**
   * Format string for the wall-clock timestamp, using date-fns syntax.
   *
   * Has no effect when {@link suppressTimeStamp} or {@link suppressAllPreamble}
   * is `true`.
   *
   * @example "HH:mm:ss"
   */
  timeFormat?: string;

  /**
   * Format string for the elapsed time since the logger was started or last
   * reset, using date-fns syntax.
   *
   * Has no effect when {@link suppressElapsed} or {@link suppressAllPreamble}
   * is `true`.
   *
   * @example "mm:ss.SSS"
   */
  elapsedFormat?: string;

  /**
   * Number of additional call-stack frames to skip when determining the
   * call-site label shown in the preamble.
   *
   * By default (`0` or `undefined`), the preamble shows the location of the
   * `writeLine` call itself. Increase this when `writeLine` is invoked from
   * inside a helper or wrapper and you want the preamble to reflect where
   * *that wrapper* was called from rather than the wrapper's own location.
   *
   * @example
   * // Without stackOffset the preamble shows the helper's location:
   * //   "myLogHelper (myLogHelper.ts:12:5)"
   * //
   * // With stackOffset = 1 it shows the helper's caller instead:
   * //   "MyTest.someStep (myTest.ts:45:3)"
   * Logger.writeLine(Logger.Levels.TestInformation, message, { stackOffset: 1 });
   *
   * Values less than 1 are treated as 0 (no offset). Values that would exceed
   * the available stack depth are clipped to the outermost frame.
   *
   */
  stackOffset?: number;
}

/**
 * General logging behaviour configuration used internally by `Logger`.
 *
 * Consumers should not construct this type directly. Use `Logger.reset()` to
 * initialise the logger and the public getters/setters to modify individual
 * settings at runtime.
 */
export interface Options {
  /**
   * The currently active log level.
   *
   * Messages whose level is less than or equal to this value are output
   * (unless overridden by {@link filterMinCurrentLevel}/{@link filterMaxCurrentLevel}
   * or {@link panicMode}).
   */
  loggingCurrentLevel: number;

  /**
   * Lower bound of the optional level-filter range (inclusive).
   *
   * Messages whose level falls within `[filterMinCurrentLevel, filterMaxCurrentLevel]`
   * are output regardless of {@link loggingCurrentLevel}.
   * Set to `Logger.Levels.NoOutput` when no filter is active.
   */
  filterMinCurrentLevel: number;

  /**
   * Upper bound of the optional level-filter range (inclusive).
   *
   * Messages whose level falls within `[filterMinCurrentLevel, filterMaxCurrentLevel]`
   * are output regardless of {@link loggingCurrentLevel}.
   * Set to `Logger.Levels.NoOutput` when no filter is active.
   */
  filterMaxCurrentLevel: number;

  /**
   * When `true`, log lines are also written to `console.log()` in addition
   * to any configured {@link LogOutputCallbackSignature output callback}.
   * When `false`, output goes only to the callback (if one is set).
   */
  logToConsole: boolean;

  /**
   * When `true`, any error thrown inside the output callback is re-thrown
   * to the caller after being logged internally.
   * When `false`, callback errors are suppressed and only logged internally.
   */
  throwErrorIfLogOutputFails: boolean;

  /**
   * When `true`, the current log level is ignored and every output call
   * produces output — equivalent to setting {@link loggingCurrentLevel}
   * to `Number.MAX_SAFE_INTEGER`.
   */
  panicMode: boolean;

  /**
   * Short prefix code prepended to the write-type label in each preamble
   * when {@link panicMode} is active.
   *
   * @example "P"
   */
  panicCodePreamble: string;

  /**
   * Longer descriptor prefix prepended to level-description strings
   * when {@link panicMode} is active.
   *
   * @example "P: "
   */
  panicDescriptorPreamble: string;

  /** Active formatting options applied by {@link Logger.writeLine}. */
  writeLine: WriteLineOptions;

  /**
   * Active video attachment options.
   *
   * Stored as {@link ResolvedVideoOptions} (all fields required) so that
   * read sites inside `Logger` never need to null-guard individual properties.
   */
  video: ResolvedVideoOptions;
}

/**
 * Signature of the callback invoked for every log output line or data attachment.
 *
 * Assign an implementation to `Logger.logOutputCallback` to receive all log
 * output through a custom handler (e.g. a test reporter's `attach` method).
 *
 * If the callback throws, `Logger` catches the error and handles it according
 * to the {@link Options.throwErrorIfLogOutputFails} setting.
 *
 * @param message - The fully formatted log line, or the raw data payload for
 *   attachments (screenshot, video, HTML).
 * @param mediaType - Optional MIME-type-style content descriptor indicating how
 *   `message` should be interpreted. Examples:
 *   - `"text/plain"` — a normal formatted log line (default when omitted)
 *   - `"text/html"` — an HTML attachment
 *   - `"base64:image/png"` — a base64-encoded PNG screenshot
 *
 * @example
 * Logger.logOutputCallback = (message, mediaType) => {
 *   myReporter.attach(message, { contentType: mediaType ?? "text/plain" });
 * };
 */
export interface LogOutputCallbackSignature {
  (message: string, mediaType?: string): void;
}