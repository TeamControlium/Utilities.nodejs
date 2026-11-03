import { JsonUtils } from "./jsonUtils.js";

// =============================================================================
// JsonUtils.resolveSentinels
// =============================================================================

describe("JsonUtils.resolveSentinels", () => {

  it("removes a top-level property whose value is the SENTINEL_UNDEFINED sentinel", () => {
    const result = JsonUtils.resolveSentinels({ Authorization: "_undefined", "X-Trace": "abc" });
    expect(result).toEqual({ "X-Trace": "abc" });
  });

  it("substitutes a real null for a value that is the SENTINEL_NULL sentinel", () => {
    const result = JsonUtils.resolveSentinels({ "X-Trace": "_null" });
    expect(result).toEqual({ "X-Trace": null });
    expect(result["X-Trace"]).toBeNull();
  });

  it("leaves ordinary string values completely unchanged", () => {
    const result = JsonUtils.resolveSentinels({ Authorization: "Bearer abc123", Count: "3" });
    expect(result).toEqual({ Authorization: "Bearer abc123", Count: "3" });
  });

  it("resolves sentinels nested arbitrarily deep within an object", () => {
    const result = JsonUtils.resolveSentinels({
      user: { name: "Alice", nickname: "_undefined", trace: "_null" },
    });
    expect(result).toEqual({ user: { name: "Alice", trace: null } });
  });

  it("resolves sentinels within array elements", () => {
    const result = JsonUtils.resolveSentinels({ tags: ["a", "_null", "_undefined"] });
    // "_undefined" has no owning property to remove at array-element level, so it is left
    // as a literal string there — removal only applies to named object properties.
    expect(result).toEqual({ tags: ["a", null, "_undefined"] });
  });

  it("does not mutate the original object", () => {
    const original = { Authorization: "_undefined", "X-Trace": "_null" };
    JsonUtils.resolveSentinels(original);
    expect(original).toEqual({ Authorization: "_undefined", "X-Trace": "_null" });
  });

  it("is exact-match only — a similar-looking string is left untouched", () => {
    const result = JsonUtils.resolveSentinels({
      a: "_null ",
      b: "_NULL",
      c: "_undefined_extra",
    });
    expect(result).toEqual({ a: "_null ", b: "_NULL", c: "_undefined_extra" });
  });

  it("passes non-string, non-object primitives through unchanged", () => {
    expect(JsonUtils.resolveSentinels(42)).toBe(42);
    expect(JsonUtils.resolveSentinels(true)).toBe(true);
    expect(JsonUtils.resolveSentinels(null)).toBeNull();
    expect(JsonUtils.resolveSentinels(undefined)).toBeUndefined();
  });

  it("returns an empty object when every property is SENTINEL_UNDEFINED", () => {
    const result = JsonUtils.resolveSentinels({ a: "_undefined", b: "_undefined" });
    expect(result).toEqual({});
  });

  it("a bare top-level SENTINEL_UNDEFINED string has no property to remove, so passes through as text", () => {
    expect(JsonUtils.resolveSentinels("_undefined")).toBe("_undefined");
  });

  it("a bare top-level SENTINEL_NULL string still resolves to a real null", () => {
    expect(JsonUtils.resolveSentinels("_null")).toBeNull();
  });

  it("returns the exact same object reference when nothing within it needed resolving", () => {
    const input = { Authorization: "Bearer abc123", nested: { a: 1 } };
    expect(JsonUtils.resolveSentinels(input)).toBe(input);
  });

  it("returns the exact same array reference when nothing within it needed resolving", () => {
    const input = ["a", "b", { x: 1 }];
    expect(JsonUtils.resolveSentinels(input)).toBe(input);
  });

  it("rebuilds only the branch containing a sentinel, leaving sibling branches as the same reference", () => {
    const untouchedSibling = { a: 1 };
    const input = { keep: untouchedSibling, drop: "_undefined" };
    const result = JsonUtils.resolveSentinels(input);
    expect(result).not.toBe(input);
    expect(result.keep).toBe(untouchedSibling);
    expect(result).toEqual({ keep: untouchedSibling });
  });

  it("does not stack-overflow on a circular reference, and leaves it unprocessed", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => JsonUtils.resolveSentinels({ weird: circular })).not.toThrow();
  });

  it("preserves the exact circular reference when nothing inside it needed resolving", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = { a: 1 };
    circular.self = circular;
    const result = JsonUtils.resolveSentinels({ weird: circular });
    expect(result.weird).toBe(circular);
  });

  it("still resolves a sentinel sitting alongside a circular reference in the same object", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = { a: 1 };
    circular.self = circular;
    const result = JsonUtils.resolveSentinels({ weird: circular, drop: "_undefined", keep: "_null" });
    expect(result).toEqual({ weird: circular, keep: null });
  });
});

// =============================================================================
// JsonUtils.buildObjectFromRows
// =============================================================================

describe("JsonUtils.buildObjectFromRows", () => {

  it("flattens rows into a flat object keyed by the key column, valued by the value column", () => {
    const result = JsonUtils.buildObjectFromRows(
      [
        { "Header Key": "Authorization", "Value": "Bearer abc" },
        { "Header Key": "X-Trace", "Value": "123" },
      ],
      "Header Key",
      "Value"
    );
    expect(result).toEqual({ Authorization: "Bearer abc", "X-Trace": "123" });
  });

  it("returns an empty object for an empty rows array", () => {
    expect(JsonUtils.buildObjectFromRows([], "Header Key", "Value")).toEqual({});
  });

  it("does not interpret sentinel-looking or non-string-looking values — passes them through raw", () => {
    const result = JsonUtils.buildObjectFromRows(
      [{ "Header Key": "a", "Value": "_undefined" }, { "Header Key": "b", "Value": "_null" }],
      "Header Key",
      "Value"
    );
    expect(result).toEqual({ a: "_undefined", b: "_null" });
  });

  it("rejects a non-array rows argument", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => JsonUtils.buildObjectFromRows({} as any, "Header Key", "Value")).toThrow(/\[rows\] must be an array/);
  });

  it("rejects a row that is not a non-null object", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => JsonUtils.buildObjectFromRows(["not an object"] as any, "Header Key", "Value")).toThrow(/row \[0\] is not a non-null object/);
  });

  it("rejects a row that is an array", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => JsonUtils.buildObjectFromRows([["a", "b"]] as any, "Header Key", "Value")).toThrow(/row \[0\] is not a non-null object/);
  });

  it("rejects a row missing the key column", () => {
    expect(() => JsonUtils.buildObjectFromRows([{ "Value": "x" }], "Header Key", "Value")).toThrow(/row \[0\] has no column \[Header Key\]/);
  });

  it("rejects a row missing the value column", () => {
    expect(() => JsonUtils.buildObjectFromRows([{ "Header Key": "a" }], "Header Key", "Value")).toThrow(/row \[0\] has no column \[Value\]/);
  });

  it("rejects a blank key-column value", () => {
    expect(() => JsonUtils.buildObjectFromRows([{ "Header Key": "  ", "Value": "x" }], "Header Key", "Value")).toThrow(/row \[0\]'s \[Header Key\] is blank/);
  });

  it("rejects the same key appearing in more than one row", () => {
    expect(() =>
      JsonUtils.buildObjectFromRows(
        [{ "Header Key": "a", "Value": "1" }, { "Header Key": "a", "Value": "2" }],
        "Header Key",
        "Value"
      )
    ).toThrow(/key \[a\] appears in more than one row/);
  });

  it("rejects a blank keyColumnName", () => {
    expect(() => JsonUtils.buildObjectFromRows([], "", "Value")).toThrow(/\[keyColumnName\] not a valid 'nonEmptyString'/);
  });

  it("rejects a blank valueColumnName", () => {
    expect(() => JsonUtils.buildObjectFromRows([], "Header Key", "")).toThrow(/\[valueColumnName\] not a valid 'nonEmptyString'/);
  });
});

// =============================================================================
// JsonUtils.updateJSONObject
// =============================================================================

describe("JsonUtils.updateJSONObject", () => {

  describe("one match — update", () => {

    it("updates an existing top-level property's value", () => {
      const result = JsonUtils.updateJSONObject({ a: 1, b: 2 }, "$.a", 42);
      expect(result).toEqual({ a: 42, b: 2 });
    });

    it("updates an existing nested property's value", () => {
      const result = JsonUtils.updateJSONObject({ user: { name: "Bob" } }, "$.user.name", "Sandra");
      expect(result).toEqual({ user: { name: "Sandra" } });
    });

    it("does not mutate the original object", () => {
      const original = { a: 1 };
      JsonUtils.updateJSONObject(original, "$.a", 42);
      expect(original).toEqual({ a: 1 });
    });
  });

  describe("zero matches — add", () => {

    it("adds a new top-level property with the given value, using a $.-rooted path", () => {
      const result = JsonUtils.updateJSONObject({ a: 1 }, "$.b", "hello");
      expect(result).toEqual({ a: 1, b: "hello" });
    });

    it("adds a new top-level property with the given value, using a bare key path", () => {
      const result = JsonUtils.updateJSONObject({ a: 1 }, "b", "hello");
      expect(result).toEqual({ a: 1, b: "hello" });
    });

    it("adds a new nested property, using a $.-rooted path", () => {
      const result = JsonUtils.updateJSONObject({ user: { name: "Bob" } }, "$.user.age", 30);
      expect(result).toEqual({ user: { name: "Bob", age: 30 } });
    });
  });

  describe("multiple matches — throws, regardless of operation", () => {

    it("throws when updating a path that matches more than one property", () => {
      expect(() => JsonUtils.updateJSONObject({ items: [{ a: 1 }, { a: 2 }] }, "$.items[*].a", 99))
        .toThrow(/matched \[2\]!  Expected zero or one match/);
    });

    it("throws when deleting a path that matches more than one property", () => {
      expect(() => JsonUtils.updateJSONObject({ items: [{ a: 1 }, { a: 2 }] }, "$.items[*].a", JsonUtils.SENTINEL_UNDEFINED))
        .toThrow(/matched \[2\]!  Expected zero or one match/);
    });
  });

  describe("delete (SENTINEL_UNDEFINED)", () => {

    it("still deletes a property when given the SENTINEL_UNDEFINED constant's value", () => {
      const result = JsonUtils.updateJSONObject({ a: 1, b: 2 }, "$.a", JsonUtils.SENTINEL_UNDEFINED);
      expect(result).toEqual({ b: 2 });
    });

    it("deleting a property that does not exist is a no-op — 'ensure it is not there', not an error", () => {
      const result = JsonUtils.updateJSONObject({ a: 1 }, "$.b", JsonUtils.SENTINEL_UNDEFINED);
      expect(result).toEqual({ a: 1 });
    });

    it("deleting an already-absent nested property is also a no-op", () => {
      const result = JsonUtils.updateJSONObject({ user: { name: "Bob" } }, "$.user.age", JsonUtils.SENTINEL_UNDEFINED);
      expect(result).toEqual({ user: { name: "Bob" } });
    });

    it("removes an array element by index when the matched property is an array element", () => {
      const result = JsonUtils.updateJSONObject({ items: [1, 2, 3] }, "$.items[1]", JsonUtils.SENTINEL_UNDEFINED);
      expect(result).toEqual({ items: [1, 3] });
    });
  });
});

describe("JsonUtils.assertPlainObject", () => {
  it("passes through a plain object unchanged", () => {
    expect(JsonUtils.assertPlainObject({ a: 1 }, "ctx")).toEqual({ a: 1 });
  });

  it("passes through an empty object", () => {
    expect(JsonUtils.assertPlainObject({}, "ctx")).toEqual({});
  });

  it("rejects null", () => {
    expect(() => JsonUtils.assertPlainObject(null, "ctx")).toThrow(/ctx: must be a JSON object/);
  });

  it("rejects an array", () => {
    expect(() => JsonUtils.assertPlainObject([1, 2], "ctx")).toThrow(/ctx: must be a JSON object/);
  });

  it("rejects a primitive", () => {
    expect(() => JsonUtils.assertPlainObject("hello", "ctx")).toThrow(/ctx: must be a JSON object/);
    expect(() => JsonUtils.assertPlainObject(42, "ctx")).toThrow(/ctx: must be a JSON object/);
    expect(() => JsonUtils.assertPlainObject(undefined, "ctx")).toThrow(/ctx: must be a JSON object/);
  });

  it("includes the given context in the error message", () => {
    expect(() => JsonUtils.assertPlainObject(null, "request headers")).toThrow(/request headers:/);
  });
});

describe("JsonUtils.parseObjectLiteral", () => {
  it("parses strict JSON into a plain object", () => {
    expect(JsonUtils.parseObjectLiteral('{"a":1}', "ctx")).toEqual({ a: 1 });
  });

  it("parses JSON5 when useJson5 is true (unquoted keys, trailing commas)", () => {
    expect(JsonUtils.parseObjectLiteral("{a:1, b:2,}", "ctx", true)).toEqual({ a: 1, b: 2 });
  });

  it("rejects JSON5 syntax when useJson5 is false/omitted", () => {
    expect(() => JsonUtils.parseObjectLiteral("{a:1}", "ctx")).toThrow(/ctx: not valid JSON:/);
  });

  it("rejects text that parses to an array", () => {
    expect(() => JsonUtils.parseObjectLiteral("[1,2]", "ctx")).toThrow(/ctx: must be a JSON object/);
  });

  it("rejects text that parses to a primitive", () => {
    expect(() => JsonUtils.parseObjectLiteral("42", "ctx")).toThrow(/ctx: must be a JSON object/);
  });

  it("rejects malformed text, with the useJson5 flag reflected in the error wording", () => {
    expect(() => JsonUtils.parseObjectLiteral("{not json", "ctx")).toThrow(/ctx: not valid JSON:/);
    expect(() => JsonUtils.parseObjectLiteral("{not json", "ctx", true)).toThrow(/ctx: not valid JSON5:/);
  });

  it("includes the given context in both error paths", () => {
    expect(() => JsonUtils.parseObjectLiteral("{bad", "request headers")).toThrow(/request headers:/);
    expect(() => JsonUtils.parseObjectLiteral("[1]", "request headers")).toThrow(/request headers:/);
  });
});
