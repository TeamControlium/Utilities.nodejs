import { LogLevel } from "../index.js";
import { Utils, SettingResult, SettingsContext } from "../index.js";

/**
 * Thin, test-runner-agnostic layer on top of {@link Utils.getSetting}. Remembers the
 * "current" {@link SettingsContext} (e.g. a Cucumber World) so callers elsewhere — code that
 * never received the World directly, bootstrapping logic, `Detokeniser.doSettingToken`,
 * anything — can still resolve a `profileParameterName`-sourced setting without needing it
 * threaded through explicitly.
 *
 * Deliberately does **not** cache resolved setting *values* — only the context used to resolve
 * them. Every {@link get} call re-resolves from scratch via `Utils.getSetting`, so an env var
 * a test sets mid-run (already the highest-precedence source) is picked up immediately, with
 * no separate "override" mechanism needed.
 *
 * Typical use: a test-runner-specific `Before`/`beforeEach` hook calls {@link setContext} once
 * per test with whatever context object the runner provides; an `After`/`afterEach` hook (or
 * the next test's `Before`) calls {@link clearContext}.
 *
 * @example
 * // In a Cucumber Before hook:
 * Cucumber.Before(function (this: MyWorld) {
 *   Settings.setContext({ sourceName: "World", parameters: this });
 * });
 * Cucumber.After(function () {
 *   Settings.clearContext();
 * });
 *
 * // Anywhere else, without needing the World passed in:
 * const { value, source } = Settings.get(LogLevels.TestInformation, "apiUrl", {
 *   processEnvName: "API_URL",
 *   profileParameterName: "$.eaTest.apiUrl",
 *   defaultValue: "http://localhost:3000",
 * });
 */
export class Settings {
    private static _current: SettingsContext | undefined = undefined;

    /**
     * Sets the context used to resolve `profileParameterName` in subsequent {@link get} calls,
     * until the next {@link setContext} or {@link clearContext}.
     *
     * @param contextParameters - The context to use (e.g. `{ sourceName: "World", parameters: this }`
     *   from a Cucumber `Before` hook). Pass `undefined` to clear it (equivalent to {@link clearContext}).
     */
    public static setContext(contextParameters?: SettingsContext): void {
        Settings._current = contextParameters;
    }

    /**
     * Clears the current context — equivalent to `setContext(undefined)`. Subsequent
     * {@link get} calls with a `profileParameterName` will find no context to resolve it
     * against (falling back to `defaultValue`, same as {@link Utils.getSetting} always does
     * when no context is available).
     */
    public static clearContext(): void {
        Settings._current = undefined;
    }

    /**
     * Resolves a named setting via {@link Utils.getSetting}, using whatever {@link SettingsContext}
     * was last set via {@link setContext} (or none, if never set/cleared). Never caches the
     * result — every call re-resolves from scratch, so an env var set between calls (already
     * the highest-precedence source) takes effect immediately.
     *
     * @param logLevel - Log level used when reporting where the setting was found.
     * @param settingName - Human-readable name for the setting, used in log messages.
     * @param sources - Same shape as {@link Utils.getSetting}'s `sources` parameter.
     * @returns `{ value, source }` — see {@link Utils.getSetting}.
     */
    public static get<returnType>(
        logLevel: LogLevel,
        settingName: string,
        sources: {
            processEnvName?: string | undefined;
            npmPackageConfigName?: string | undefined;
            profileParameterName?: string | undefined;
            defaultValue?: returnType | undefined;
            notFoundIsExpected?: boolean;
        },
    ): SettingResult<returnType> {
        return Utils.getSetting(logLevel, settingName, sources, Settings._current);
    }
}
