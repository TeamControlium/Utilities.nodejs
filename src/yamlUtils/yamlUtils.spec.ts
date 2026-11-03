import { YamlUtils } from "./yamlUtils.js";

// =============================================================================
// YamlUtils.parse
// =============================================================================

describe("YamlUtils.parse", () => {

  it("parses a simple mapping", () => {
    expect(YamlUtils.parse("a: 1\nb: two\n")).toEqual({ a: 1, b: "two" });
  });

  it("parses a sequence", () => {
    expect(YamlUtils.parse("- 1\n- 2\n- 3\n")).toEqual([1, 2, 3]);
  });

  it("parses nested structures", () => {
    expect(YamlUtils.parse("a:\n  b: 1\n  c:\n    - x\n    - y\n")).toEqual({ a: { b: 1, c: ["x", "y"] } });
  });

  it("parses scalars without any surrounding structure", () => {
    expect(YamlUtils.parse("42\n")).toBe(42);
    expect(YamlUtils.parse("true\n")).toBe(true);
    expect(YamlUtils.parse("null\n")).toBeNull();
  });

  it("rejects a non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => YamlUtils.parse(42 as any)).toThrow(/\[yaml\] not 'string' type/);
  });

  // ─── Strictness — malformed YAML always throws, never silently salvaged ────────────────
  //
  // Confirmed directly against the `yaml` package itself: `strict: true` is its own
  // default, but pinned explicitly here (rather than relied on implicitly) so a future
  // library version bump can never silently loosen this. A test deliberately sending
  // broken YAML wants that caught loudly, same as every other cast in this codebase.
  describe("strictness", () => {

    it("rejects an unclosed flow sequence", () => {
      expect(() => YamlUtils.parse("a: [1, 2")).toThrow(/as YAML:/);
    });

    it("rejects inconsistent mapping indentation", () => {
      expect(() => YamlUtils.parse("a:\n  b: 1\n c: 2")).toThrow(/as YAML:/);
    });

    it("rejects a plain scalar starting with a reserved character", () => {
      expect(() => YamlUtils.parse("a: @not-a-valid-start")).toThrow(/as YAML:/);
    });

    it("rejects a nested mapping in compact form", () => {
      expect(() => YamlUtils.parse("key: : value")).toThrow(/as YAML:/);
    });
  });
});

// =============================================================================
// YamlUtils.stringify
// =============================================================================

describe("YamlUtils.stringify", () => {

  it("serialises a plain object to a YAML mapping", () => {
    expect(YamlUtils.stringify({ a: 1, b: "two" })).toBe("a: 1\nb: two\n");
  });

  it("serialises an array to a YAML sequence", () => {
    expect(YamlUtils.stringify([1, 2, 3])).toBe("- 1\n- 2\n- 3\n");
  });

  it("round-trips through parse/stringify", () => {
    const original = { a: 1, b: { c: ["x", "y"] } };
    expect(YamlUtils.parse(YamlUtils.stringify(original))).toEqual(original);
  });
});

// =============================================================================
// YamlUtils.isYaml
// =============================================================================

describe("YamlUtils.isYaml", () => {

  it("returns true for a mapping", () => {
    expect(YamlUtils.isYaml("a: 1")).toBe(true);
  });

  it("returns true for a sequence", () => {
    expect(YamlUtils.isYaml("- 1\n- 2")).toBe(true);
  });

  it("returns false for a bare scalar — a single word, a number, a boolean", () => {
    expect(YamlUtils.isYaml("hello")).toBe(false);
    expect(YamlUtils.isYaml("42")).toBe(false);
    expect(YamlUtils.isYaml("true")).toBe(false);
  });

  it("returns false for malformed YAML", () => {
    expect(YamlUtils.isYaml("a: [1, 2")).toBe(false);
  });

  it("returns false for undefined/null", () => {
    expect(YamlUtils.isYaml(undefined)).toBe(false);
    expect(YamlUtils.isYaml(null)).toBe(false);
  });

  it("returns true for a JSON object string too — JSON is a YAML 1.2 subset", () => {
    expect(YamlUtils.isYaml('{"a":1}')).toBe(true);
  });
});
