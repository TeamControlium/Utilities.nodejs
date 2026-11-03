import { Detokeniser } from "../detokeniser/detokeniser.js";
import { Utils } from "../utils/utils.js";
import { isCastVerb, ValueExpression } from "./valueExpression.js";

// A known-safe token — resolves via a default rather than a real env var, so these tests
// never depend on anything actually being set in the environment. Same convention already
// used by detokeniser.spec.ts.
const TOKEN = (fallback: string) =>
  `[[setting|processEnvName: "VALUE_EXPRESSION_SPEC_DEFINITELY_NOT_SET_XYZ", defaultValue: "${fallback}"]]`;

describe("ValueExpression.parse", () => {

  afterEach(() => {
    Detokeniser.reset();
    vi.restoreAllMocks();
  });

  // ─── Inline, no recognised verb — the literal, unstructured case ────────────

  it("returns a plain inline string verbatim, with no verbs at all", async () => {
    await expect(ValueExpression.parse("Bearer abc123")).resolves.toBe("Bearer abc123");
  });

  it("treats an unrecognised word before a colon as incidental — the whole thing stays literal", async () => {
    await expect(ValueExpression.parse("SomeScheme:abc123")).resolves.toBe("SomeScheme:abc123");
  });

  it("a URL survives untouched — 'http' is not a recognised verb", async () => {
    await expect(ValueExpression.parse("http://example.com")).resolves.toBe("http://example.com");
  });

  it("detokenises even the plain literal case", async () => {
    await expect(ValueExpression.parse(`Bearer ${TOKEN("abc123")}`)).resolves.toBe("Bearer abc123");
  });

  // ─── number: ──────────────────────────────────────────────────────────────

  it("number: casts to a finite number", async () => {
    await expect(ValueExpression.parse("number:42")).resolves.toBe(42);
  });

  it("number: trims surrounding whitespace before parsing", async () => {
    await expect(ValueExpression.parse("number: 42 ")).resolves.toBe(42);
  });

  it("number: detokenises the argument before casting", async () => {
    await expect(ValueExpression.parse(`number:${TOKEN("42")}`)).resolves.toBe(42);
  });

  it("number: rejects an empty value (not 0 — Number('') is a known JS gotcha)", async () => {
    await expect(ValueExpression.parse("number:")).rejects.toThrow(/not a valid finite number/);
  });

  it("number: rejects a non-numeric value", async () => {
    await expect(ValueExpression.parse("number:notanumber")).rejects.toThrow(/not a valid finite number/);
  });

  // ─── boolean: ─────────────────────────────────────────────────────────────

  it("boolean: casts 'true'/'false' exactly", async () => {
    await expect(ValueExpression.parse("boolean:true")).resolves.toBe(true);
    await expect(ValueExpression.parse("boolean:false")).resolves.toBe(false);
  });

  it("boolean: rejects anything other than an exact lowercase 'true'/'false'", async () => {
    await expect(ValueExpression.parse("boolean:TRUE")).rejects.toThrow(/must be exactly 'true' or 'false'/);
    await expect(ValueExpression.parse("boolean:1")).rejects.toThrow(/must be exactly 'true' or 'false'/);
    await expect(ValueExpression.parse("boolean:yes")).rejects.toThrow(/must be exactly 'true' or 'false'/);
  });

  // ─── json: ────────────────────────────────────────────────────────────────

  it("json: parses a JSON object", async () => {
    await expect(ValueExpression.parse('json:{"a":1}')).resolves.toEqual({ a: 1 });
  });

  it("json: tolerates its own colons and commas inside the value — only the first colon is a delimiter", async () => {
    await expect(ValueExpression.parse('json:{"a":"x,y:z"}')).resolves.toEqual({ a: "x,y:z" });
  });

  it("json: rejects invalid JSON", async () => {
    await expect(ValueExpression.parse("json:{not valid")).rejects.toThrow(/not valid JSON/);
  });

  it("json: still rejects JSON5-only syntax (unquoted key) when useJson5 is omitted — defaults to strict", async () => {
    await expect(ValueExpression.parse("json:{a:1}")).rejects.toThrow(/not valid JSON/);
  });

  it("json: with useJson5 true, accepts unquoted keys/single-quoted strings/trailing commas", async () => {
    await expect(ValueExpression.parse("json:{a:1,}", { useJson5: true })).resolves.toEqual({ a: 1 });
    await expect(ValueExpression.parse("json:{'a':'x'}", { useJson5: true })).resolves.toEqual({ a: "x" });
  });

  it("json: with useJson5 true, still parses plain strict JSON the same as always", async () => {
    await expect(ValueExpression.parse('json:{"a":1}', { useJson5: true })).resolves.toEqual({ a: 1 });
  });

  it("json: with useJson5 true, still rejects genuinely malformed input, and the error says JSON5", async () => {
    await expect(ValueExpression.parse("json:{not valid", { useJson5: true })).rejects.toThrow(/not valid JSON5/);
  });

  // ─── file: (mocked filesystem) ────────────────────────────────────────────

  describe("file: source", () => {

    beforeEach(() => {
      vi.spyOn(Utils, "resolveTestDataPath").mockImplementation((relativePath) => `/resolved/${relativePath}`);
    });

    it("loads and trims file contents, returned as a plain string when no cast is given", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue("  hello from file  \n");
      await expect(ValueExpression.parse("file:xyzzy.txt")).resolves.toBe("hello from file");
      expect(Utils.resolveTestDataPath).toHaveBeenCalledWith("xyzzy.txt");
    });

    it("file,number: loads file contents and casts them to a number", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue("42\n");
      await expect(ValueExpression.parse("file,number:xyzzy.num")).resolves.toBe(42);
    });

    it("file,boolean: loads file contents and casts them to a boolean", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue("true\n");
      await expect(ValueExpression.parse("file,boolean:flag.txt")).resolves.toBe(true);
    });

    it("file,json: loads file contents and casts them to parsed JSON", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue('{"a":1}');
      await expect(ValueExpression.parse("file,json:payload.json")).resolves.toEqual({ a: 1 });
    });

    it("file,json: with useJson5 true, accepts JSON5 file contents (unquoted key)", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue("{a:1}");
      await expect(ValueExpression.parse("file,json:payload.json", { useJson5: true })).resolves.toEqual({ a: 1 });
    });

    it("detokenises the path before resolving it", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue("content");
      await ValueExpression.parse(`file:${TOKEN("resolved-name.txt")}`);
      expect(Utils.resolveTestDataPath).toHaveBeenCalledWith("resolved-name.txt");
    });

    it("detokenises the loaded content separately from the path — two independent passes", async () => {
      vi.spyOn(Utils, "getFileContents").mockReturnValue(TOKEN("content-value"));
      await expect(ValueExpression.parse("file:xyzzy.txt")).resolves.toBe("content-value");
    });
  });

  // ─── Verb-combination validation ──────────────────────────────────────────

  it("rejects the source verb repeated", async () => {
    await expect(ValueExpression.parse("file,file:xyzzy.txt")).rejects.toThrow(/repeats the 'file' verb/);
  });

  it("rejects two conflicting cast verbs", async () => {
    await expect(ValueExpression.parse("number,boolean:42")).rejects.toThrow(/conflicting cast verbs/);
  });

  it("rejects a non-string expression", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(ValueExpression.parse(42 as any)).rejects.toThrow(/\[expression\] not 'string' type/);
  });
});

// ─── isCastVerb — the runtime guard splitVerbs uses instead of an unchecked type assertion
//
// Unreachable through ValueExpression.parse's own public surface by design (see that
// function's own doc comment) — tested directly here since that's the only way to exercise
// it at all.
describe("isCastVerb", () => {

  it("returns true for each real cast verb", () => {
    expect(isCastVerb("number")).toBe(true);
    expect(isCastVerb("boolean")).toBe(true);
    expect(isCastVerb("json")).toBe(true);
  });

  it("returns false for the source verb — 'file' is not a cast verb", () => {
    expect(isCastVerb("file")).toBe(false);
  });

  it("returns false for an unrecognised string", () => {
    expect(isCastVerb("yaml")).toBe(false);
    expect(isCastVerb("")).toBe(false);
  });
});
