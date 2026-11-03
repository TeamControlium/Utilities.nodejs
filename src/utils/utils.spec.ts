import path from "path";

import { Logger } from "../logger/logger.js";
import { Utils } from "./utils.js";

const LogLevels = Logger.Levels;

// =============================================================================
// Utils.resolveTestDataPath
// =============================================================================

describe("Utils.resolveTestDataPath", () => {

  afterEach(() => {
    delete process.env.CONTROLIUM_TEST_DATA_PATH;
    delete process.env.npm_package_config_testDataPath;
    vi.restoreAllMocks();
  });

  it("defaults to <cwd>/testdata when nothing is configured", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/suite/root");
    expect(Utils.resolveTestDataPath("headers/auth.json")).toBe(path.join("/suite/root", "testdata", "headers/auth.json"));
  });

  it("prefers the CONTROLIUM_TEST_DATA_PATH env var over the default", () => {
    process.env.CONTROLIUM_TEST_DATA_PATH = "/configured/root";
    expect(Utils.resolveTestDataPath("headers/auth.json")).toBe(path.join("/configured/root", "headers/auth.json"));
  });

  it("falls back to the npm package config value when the env var is not set", () => {
    process.env.npm_package_config_testDataPath = "/npm/configured/root";
    expect(Utils.resolveTestDataPath("headers/auth.json")).toBe(path.join("/npm/configured/root", "headers/auth.json"));
  });

  it("the env var takes priority over the npm package config value", () => {
    process.env.CONTROLIUM_TEST_DATA_PATH = "/env/root";
    process.env.npm_package_config_testDataPath = "/npm/root";
    expect(Utils.resolveTestDataPath("x.json")).toBe(path.join("/env/root", "x.json"));
  });

  it("rejects a non-string relativePath", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => Utils.resolveTestDataPath(42 as any)).toThrow(/\[relativePath\] not a valid 'nonEmptyString'/);
  });

  it("rejects an empty relativePath", () => {
    expect(() => Utils.resolveTestDataPath("")).toThrow(/\[relativePath\] not a valid 'nonEmptyString'/);
  });

  it("a bare filename resolves directly under the configured root, no './' needed", () => {
    process.env.CONTROLIUM_TEST_DATA_PATH = "/configured/root";
    expect(Utils.resolveTestDataPath("hello.txt")).toBe(path.join("/configured/root", "hello.txt"));
  });

  it("'..' segments intentionally escape upward, relative to the configured root", () => {
    process.env.CONTROLIUM_TEST_DATA_PATH = "/configured/root";
    expect(Utils.resolveTestDataPath("../anotherFolder/hello.txt")).toBe(path.join("/configured", "anotherFolder", "hello.txt"));
  });

  it("a leading '/' never produces a true filesystem-absolute path — it's glued onto the root", () => {
    process.env.CONTROLIUM_TEST_DATA_PATH = "/configured/root";
    expect(Utils.resolveTestDataPath("/etc/passwd")).toBe(path.join("/configured/root", "etc/passwd"));
  });
});

// =============================================================================
// Utils.getSetting — notFoundIsExpected
// =============================================================================

describe("Utils.getSetting — notFoundIsExpected", () => {

  let capturedLines: string[] = [];

  beforeEach(() => {
    capturedLines = [];
    Logger.loggingLevel = LogLevels.FrameworkDebug;
    Logger.logOutputCallback = (text) => { capturedLines.push(text); };
  });

  afterEach(() => {
    Logger.clearOutputCallback();
  });

  it("logs at Error level when nothing resolves and notFoundIsExpected is omitted (unchanged default behaviour)", () => {
    const result = Utils.getSetting(LogLevels.TestInformation, "someSetting", {});
    expect(result).toEqual({ value: undefined, source: "Not found" });
    expect(capturedLines.some((line) => line.startsWith("ERROR") && line.includes("Unable to determine value for setting [someSetting]"))).toBe(true);
  });

  it("logs calmly at the caller's logLevel, not Error, when notFoundIsExpected is true", () => {
    const result = Utils.getSetting(LogLevels.TestInformation, "someSetting", { notFoundIsExpected: true });
    expect(result).toEqual({ value: undefined, source: "Not found" });
    expect(capturedLines.some((line) => line.startsWith("ERROR"))).toBe(false);
    expect(capturedLines.some((line) => line.includes("Setting [someSetting] not configured — no value to return."))).toBe(true);
  });

  it("notFoundIsExpected has no effect when a defaultValue resolves — still the calm 'default value' path", () => {
    const result = Utils.getSetting(LogLevels.TestInformation, "someSetting", { notFoundIsExpected: true, defaultValue: "fallback" });
    expect(result).toEqual({ value: "fallback", source: "Default value" });
    expect(capturedLines.some((line) => line.startsWith("ERROR"))).toBe(false);
  });
});

// =============================================================================
// Utils.timeoutPromise / withTimeout
// =============================================================================

describe("Utils.timeoutPromise", () => {
  beforeAll(() => {
    Logger.logToConsole = false;
  });

  afterEach(() => {
    Utils.resetPromiseCount();
    vi.useRealTimers();
  });

  it("resolves with the wrapped promise's value when it settles before the timeout", async () => {
    await expect(
      Utils.timeoutPromise(Promise.resolve("done"), { timeoutMS: 50 })
    ).resolves.toBe("done");
  });

  it("rejects with the wrapped promise's error when it rejects before the timeout", async () => {
    await expect(
      Utils.timeoutPromise(Promise.reject(new Error("boom")), { timeoutMS: 50 })
    ).rejects.toThrow("boom");
  });

  it("rejects with a timeout error when the promise does not settle in time", async () => {
    const neverSettles = new Promise<void>(() => { /* deliberately never settles */ });
    await expect(
      Utils.timeoutPromise(neverSettles, { timeoutMS: 20, friendlyName: "myOp" })
    ).rejects.toThrow(/myOp: Timeout after 20 ms/);
  });

  // ---------------------------------------------------------------------------
  // Regression: the losing setTimeout must always be cleared, otherwise it keeps
  // Node's event loop open for the full timeoutMS even after the real operation
  // has already finished. Confirmed in production via framework's API_AUTWrapper
  // (Utils.timeoutPromise wrapping bootstrapper/closeHandler/getUrlHandler calls)
  // leaving a Cucumber-JS process hanging for ~30s (the default timeout) after all
  // scenarios had already passed.
  // ---------------------------------------------------------------------------
  describe("timer cleanup (regression)", () => {
    it("clears the pending timeout once the wrapped promise resolves first", async () => {
      vi.useFakeTimers();
      const result = await Utils.timeoutPromise(Promise.resolve("fast"), { timeoutMS: 30_000 });
      expect(result).toBe("fast");
      // Before the fix, the losing setTimeout(..., 30000) would still be sat in the
      // fake-timer queue here, holding the event loop open in a real run.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the pending timeout once the wrapped promise rejects first", async () => {
      vi.useFakeTimers();
      await expect(
        Utils.timeoutPromise(Promise.reject(new Error("boom")), { timeoutMS: 30_000 })
      ).rejects.toThrow("boom");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("still fires the timeout (and clears its own handle) when the promise never settles", async () => {
      vi.useFakeTimers();
      const neverSettles = new Promise<void>(() => { /* deliberately never settles */ });
      const resultPromise = Utils.timeoutPromise(neverSettles, { timeoutMS: 1_000 });
      const assertion = expect(resultPromise).rejects.toThrow(/Timeout after 1000 ms/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
