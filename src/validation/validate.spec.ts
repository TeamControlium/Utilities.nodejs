import { JsonUtils } from "../jsonUtils/jsonUtils.js";
import { Validate } from "./validate.js";

describe("Validate.normalizeCompareTypes", () => {

  it("undefined resolves to an empty Set", () => {
    expect(Validate.normalizeCompareTypes(undefined, new Set(["equals"]))).toEqual(new Set());
  });

  it("a blank/whitespace-only string resolves to an empty Set", () => {
    expect(Validate.normalizeCompareTypes("   ", new Set(["equals"]))).toEqual(new Set());
  });

  it("splits a comma-separated string, trimming whitespace and lowercasing each item", () => {
    expect(Validate.normalizeCompareTypes(" Equals , CaseSensitive ", new Set(["equals", "casesensitive"]))).toEqual(
      new Set(["equals", "casesensitive"])
    );
  });

  it("accepts an already-built Set, still validated item by item", () => {
    expect(Validate.normalizeCompareTypes(new Set(["equals"]), new Set(["equals"]))).toEqual(new Set(["equals"]));
  });

  it("accepts a plain array too, not just a Set", () => {
    expect(Validate.normalizeCompareTypes(["equals"], new Set(["equals"]))).toEqual(new Set(["equals"]));
  });

  it("rejects an item outside the given vocabulary, string or Set alike", () => {
    expect(() => Validate.normalizeCompareTypes("casesensitive", new Set(["equals"]))).toThrow(/\[casesensitive\] is not a recognised compare type/);
    expect(() => Validate.normalizeCompareTypes(new Set(["casesensitive"]), new Set(["equals"]))).toThrow(/\[casesensitive\] is not a recognised compare type/);
  });
});

describe("Validate.text", () => {

  it("matches equal text case-insensitively by default", () => {
    expect(Validate.text("Hello", "hello", "t")).toBe(true);
  });

  it("fails equal-but-different-case text under 'casesensitive'", () => {
    expect(Validate.text("Hello", "hello", "t", "casesensitive,noassert")).toBe(false);
  });

  it("'contains' passes when the substring is present anywhere", () => {
    expect(Validate.text("ell", "Hello", "t", "contains")).toBe(true);
  });

  it("'startswith' and 'endswith' combine into a sandwich match", () => {
    expect(Validate.text("He", "Hello", "t", "startswith")).toBe(true);
    expect(Validate.text("lo", "Hello", "t", "endswith")).toBe(true);
    expect(Validate.text("H", "Hello", "t", "startswith,endswith,noassert")).toBe(false);
    expect(Validate.text("He", "HelloHe", "t", "startswith,endswith")).toBe(true);
  });

  it("'regexp' treats expected as a regular expression", () => {
    expect(Validate.text("^h.*o$", "Hello", "t", "regexp")).toBe(true);
  });

  it("'trim' ignores leading/trailing whitespace on both sides", () => {
    expect(Validate.text("  hello  ", "hello", "t", "trim")).toBe(true);
  });

  it("an undefined actual is compared against the literal text '<UNDEFINED>'", () => {
    expect(Validate.text("<UNDEFINED>", undefined, "t")).toBe(true);
  });

  it("'not' inverts the result", () => {
    expect(Validate.text("hello", "hello", "t", "not,noassert")).toBe(false);
    expect(Validate.text("hello", "goodbye", "t", "not")).toBe(true);
  });

  it("'noassert' returns false instead of throwing on a mismatch", () => {
    expect(Validate.text("a", "b", "t", "noassert")).toBe(false);
  });

  it("without 'noassert', a failing comparison throws, carrying both expected and actual", () => {
    expect(() => Validate.text("a", "b", "my field")).toThrow(/my field/);
  });

  it("'regexp' cannot be combined with any other mode flag", () => {
    expect(() => Validate.text("a", "a", "t", "regexp,contains")).toThrow(/'regexp' cannot be combined/);
  });

  it("'equals' cannot be combined with 'startswith'/'endswith'/'contains'", () => {
    expect(() => Validate.text("a", "a", "t", "equals,contains")).toThrow(/'equals' cannot be combined/);
  });
});

describe("Validate.number", () => {

  describe("comparator mode", () => {
    it("supports <, <=, >, >=, = and their worded spellings", () => {
      expect(Validate.number("5", 4, "t", "<")).toBe(true);
      expect(Validate.number("5", 5, "t", "lessthanorequalto")).toBe(true);
      expect(Validate.number("5", 6, "t", ">")).toBe(true);
      expect(Validate.number("5", 5, "t", "greaterthanorequalto")).toBe(true);
      expect(Validate.number("5", 5, "t", "equalto")).toBe(true);
    });

    it("'divisibleby' passes only for an integer actual evenly divisible by the divisor", () => {
      expect(Validate.number("3", 9, "t", "divisibleby")).toBe(true);
      expect(Validate.number("3", 10, "t", "divisibleby,noassert")).toBe(false);
      expect(Validate.number("3", 9.5, "t", "divisibleby,noassert")).toBe(false);
    });

    it("'integer' additionally requires a whole-number actual", () => {
      expect(Validate.number("5", 5, "t", "<=,integer")).toBe(true);
      expect(Validate.number("5", 4.5, "t", "<=,integer,noassert")).toBe(false);
    });

    it("accepts the signed-infinity keyword as a threshold", () => {
      expect(Validate.number("Infinity", 1000000, "t", "<")).toBe(true);
      expect(Validate.number("-Infinity", -1000000, "t", ">")).toBe(true);
    });

    it("rejects more than one comparator flag", () => {
      expect(() => Validate.number("5", 5, "t", "<,>")).toThrow(/more than one comparator flag/);
    });

    it("rejects a non-single-number expected alongside a comparator", () => {
      expect(() => Validate.number("1-5", 3, "t", "<")).toThrow(/requires \[expected\] to be a single number/);
    });

    it("rejects 'integer' with no comparator present", () => {
      expect(() => Validate.number("5", 5, "t", "integer")).toThrow(/'integer' requires a comparator flag/);
    });

    it("rejects 'excludelower'/'excludeupper' alongside a comparator", () => {
      expect(() => Validate.number("5", 5, "t", "<,excludelower")).toThrow(/cannot be combined with a comparator/);
    });

    it("rejects a non-integer or zero divisor for 'divisibleby'", () => {
      expect(() => Validate.number("1.5", 3, "t", "divisibleby")).toThrow(/divisor must be an integer/);
      expect(() => Validate.number("0", 3, "t", "divisibleby")).toThrow(/cannot use a divisor of 0/);
    });
  });

  describe("default list/range mode", () => {
    it("passes if actual equals any plain value in a comma-separated list", () => {
      expect(Validate.number("1,2,3", 2, "t")).toBe(true);
      expect(Validate.number("1,2,3", 4, "t", "noassert")).toBe(false);
    });

    it("a real range ('min-max') is inclusive on both ends by default", () => {
      expect(Validate.number("1-5", 1, "t")).toBe(true);
      expect(Validate.number("1-5", 5, "t")).toBe(true);
      expect(Validate.number("1-5", 3.5, "t")).toBe(true);
    });

    it("an integer range ('min..max') additionally requires a whole-number actual", () => {
      expect(Validate.number("1..5", 3, "t")).toBe(true);
      expect(Validate.number("1..5", 3.5, "t", "noassert")).toBe(false);
    });

    it("mixes plain values and ranges freely in one list", () => {
      expect(Validate.number("1,10-20,100", 15, "t")).toBe(true);
      expect(Validate.number("1,10-20,100", 100, "t")).toBe(true);
      expect(Validate.number("1,10-20,100", 50, "t", "noassert")).toBe(false);
    });

    it("'excludelower'/'excludeupper' make a range's bound(s) exclusive", () => {
      expect(Validate.number("1-5", 1, "t", "excludelower,noassert")).toBe(false);
      expect(Validate.number("1-5", 5, "t", "excludeupper,noassert")).toBe(false);
      expect(Validate.number("1-5", 1, "t", "excludeupper")).toBe(true);
    });

    it("rejects 'excludelower'/'excludeupper' when expected has no range at all", () => {
      expect(() => Validate.number("1,2,3", 2, "t", "excludelower")).toThrow(/require \[expected\] to contain at least one range/);
    });

    it("rejects a malformed list item", () => {
      expect(() => Validate.number("1,abc,3", 2, "t")).toThrow(/is not a valid number/);
    });

    it("rejects a backwards range", () => {
      expect(() => Validate.number("5-1", 2, "t")).toThrow(/backwards range/);
    });

    it("rejects a range whose upper bound is -Infinity, or whose lower bound is +Infinity", () => {
      expect(() => Validate.number("1--Infinity", 2, "t")).toThrow(/upper bound can never be -Infinity/);
      expect(() => Validate.number("Infinity-5", 2, "t")).toThrow(/lower bound can never be \+Infinity/);
    });
  });

  it("rejects a NaN actual outright, regardless of noassert", () => {
    expect(() => Validate.number("1-5", Number.NaN, "t", "noassert")).toThrow(/\[actual\] is NaN/);
  });

  it("rejects an expected that is neither a number nor a string", () => {
    expect(() => Validate.number(true as unknown as number, 1, "t")).toThrow(/\[expected\] must be a number or string/);
  });

  it("'not' inverts the final result", () => {
    expect(Validate.number("1-5", 3, "t", "not,noassert")).toBe(false);
    expect(Validate.number("1-5", 10, "t", "not")).toBe(true);
  });

  it("without 'noassert', a failing comparison throws", () => {
    expect(() => Validate.number("1-5", 10, "my field")).toThrow(/my field/);
  });
});

describe("Validate.boolean", () => {

  it("matches a real boolean against another real boolean", () => {
    expect(Validate.boolean(true, true, "t")).toBe(true);
    expect(Validate.boolean(false, false, "t")).toBe(true);
    expect(Validate.boolean(true, false, "t", "noassert")).toBe(false);
  });

  it("resolves 'true'/'y'/'1'/'yes'/'positive' (case-insensitive) as true, everything else as false", () => {
    for (const truthy of ["true", "TRUE", "y", "1", "yes", "positive"]) {
      expect(Validate.boolean(truthy, true, "t")).toBe(true);
    }
    expect(Validate.boolean("nope", false, "t")).toBe(true);
  });

  it("'not' inverts the result", () => {
    expect(Validate.boolean(true, true, "t", "not,noassert")).toBe(false);
  });

  it("rejects a non-boolean actual outright", () => {
    expect(() => Validate.boolean(true, "true" as unknown as boolean, "t")).toThrow(/not 'boolean' type/);
  });

  it("'noassert' returns false instead of throwing on a mismatch", () => {
    expect(Validate.boolean(true, false, "t", "noassert")).toBe(false);
  });

  it("without 'noassert', a failing comparison throws", () => {
    expect(() => Validate.boolean(true, false, "my field")).toThrow(/my field/);
  });
});

describe("Validate.array", () => {

  it("matches equal-length arrays element by element, in order, by default", () => {
    expect(Validate.array([1, "a", true], [1, "a", true], "t")).toBe(true);
  });

  it("fails when element order differs, by default", () => {
    expect(Validate.array([false, true], [true, false], "t", "noassert")).toBe(false);
  });

  it("fails on a length mismatch, ordered or unordered", () => {
    expect(Validate.array([1, 2], [1, 2, 3], "t", "noassert")).toBe(false);
    expect(Validate.array([1, 2], [1, 2, 3], "t", "unordered,noassert")).toBe(false);
  });

  it("'unordered' matches the same multiset in any arrangement", () => {
    expect(Validate.array([1, 2, 3], [3, 1, 2], "t", "unordered")).toBe(true);
  });

  it("'unordered' still requires duplicates to balance on both sides", () => {
    // Exact case from the spec: two falses + one true on both sides is a pass; three falses
    // vs two falses + one true is not, even though both are length 3.
    expect(Validate.array([false, true, false], [true, false, false], "t", "unordered")).toBe(true);
    expect(Validate.array([false, false, true], [true, false, true], "t", "unordered,noassert")).toBe(false);
  });

  it("string elements compare case-insensitively by default, case-sensitively opt-in", () => {
    expect(Validate.array(["ABC"], ["abc"], "t")).toBe(true);
    expect(Validate.array(["ABC"], ["abc"], "t", "casesensitive,noassert")).toBe(false);
  });

  it("without 'equivalent', a type mismatch between elements fails even if the text matches", () => {
    expect(Validate.array([true, false], ["true", "false"], "t", "noassert")).toBe(false);
  });

  it("'equivalent' lets a primitive match once stringified, regardless of type", () => {
    expect(Validate.array([true, false], ["TRUE", "False"], "t", "equivalent")).toBe(true);
    expect(Validate.array([1, 2], ["1", "2"], "t", "equivalent")).toBe(true);
  });

  it("'equivalent' still respects 'casesensitive' for the stringified comparison", () => {
    expect(Validate.array([true], ["TRUE"], "t", "equivalent,casesensitive,noassert")).toBe(false);
  });

  it("'equivalent' never relaxes an object/array element pair — those always need exact structural equality", () => {
    expect(Validate.array([{ a: 1 }], [{ a: 1 }], "t", "equivalent")).toBe(true);
    expect(Validate.array([{ a: 1 }], [{ a: 2 }], "t", "equivalent,noassert")).toBe(false);
    expect(Validate.array([[1, 2]], [[1, 2]], "t")).toBe(true);
  });

  it("'not' inverts the result", () => {
    expect(Validate.array([1, 2], [1, 2], "t", "not,noassert")).toBe(false);
  });

  it("rejects a non-array expected or actual, regardless of what TypeScript's own types promise", () => {
    expect(() => Validate.array("not an array" as unknown as unknown[], [1], "t")).toThrow(/\[expected\] must be an array/);
    expect(() => Validate.array([1], "not an array" as unknown as unknown[], "t")).toThrow(/\[actual\] must be an array/);
  });

  it("'noassert' returns false instead of throwing on a mismatch", () => {
    expect(Validate.array([1], [2], "t", "noassert")).toBe(false);
  });

  it("without 'noassert', a failing comparison throws", () => {
    expect(() => Validate.array([1], [2], "my field")).toThrow(/my field/);
  });
});

describe("Validate.type", () => {

  it.each([
    ["null", null, true],
    ["null", undefined, false],
    ["undefined", undefined, true],
    ["undefined", null, false],
    ["nullish", null, true],
    ["nullish", undefined, true],
    ["nullish", 0, false],
    ["string", "a", true],
    ["number", 1, true],
    ["boolean", true, true],
    ["bigint", BigInt(1), true],
    ["symbol", Symbol("s"), true],
    ["function", () => {}, true],
    ["object", {}, true],
    ["object", [], false],
    ["object", null, false],
    ["array", [], true],
    ["array", {}, false],
  ] as const)("expected=%s, actual=%p -> %s", (expected, actual, expectedResult) => {
    expect(Validate.type(expected, actual, "t", "noassert")).toBe(expectedResult);
  });

  it("'not' inverts the result", () => {
    expect(Validate.type("string", "a", "t", "not,noassert")).toBe(false);
  });

  it("rejects an unrecognised type name", () => {
    expect(() => Validate.type("date" as never, new Date(), "t")).toThrow(/\[expected\] must be one of/);
  });

  it("without 'noassert', a failing comparison throws", () => {
    expect(() => Validate.type("string", 1, "my field")).toThrow(/my field/);
  });
});

describe("Validate.jsonObject", () => {

  it("passes for structurally identical objects, keys in any order", () => {
    expect(Validate.jsonObject({ a: 1, b: 2 }, { b: 2, a: 1 }, "t")).toBe(true);
  });

  it("fails when actual is missing an expected property", () => {
    expect(Validate.jsonObject({ a: 1, b: 2 }, { a: 1 }, "t", "noassert")).toBe(false);
  });

  it("fails on an extra property in actual by default; passes under 'contains'", () => {
    expect(Validate.jsonObject({ a: 1 }, { a: 1, b: 2 }, "t", "noassert")).toBe(false);
    expect(Validate.jsonObject({ a: 1 }, { a: 1, b: 2 }, "t", "contains")).toBe(true);
  });

  it("compares array elements by position by default; fails on reordering", () => {
    expect(Validate.jsonObject([1, 2, 3], [3, 2, 1], "t", "noassert")).toBe(false);
  });

  it("'unorderedarrays' allows array elements in any arrangement, same multiset", () => {
    expect(Validate.jsonObject([1, 2, 3], [3, 1, 2], "t", "unorderedarrays")).toBe(true);
  });

  it("'contains' on a nested array lets actual carry extra elements", () => {
    expect(Validate.jsonObject([1, 2], [1, 2, 3], "t", "contains")).toBe(true);
  });

  it("recurses into nested structures at every depth", () => {
    expect(Validate.jsonObject({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }, "t")).toBe(true);
    expect(Validate.jsonObject({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }, "t", "noassert")).toBe(false);
  });

  it("treats NaN as equal to itself", () => {
    expect(Validate.jsonObject(Number.NaN, Number.NaN, "t")).toBe(true);
  });

  it("'not' inverts the result", () => {
    expect(Validate.jsonObject({ a: 1 }, { a: 1 }, "t", "not,noassert")).toBe(false);
  });

  it("'noassert' returns false instead of throwing on a mismatch", () => {
    expect(Validate.jsonObject({ a: 1 }, { a: 2 }, "t", "noassert")).toBe(false);
  });

  it("without 'noassert', a failing comparison throws", () => {
    expect(() => Validate.jsonObject({ a: 1 }, { a: 2 }, "my field")).toThrow(/my field/);
  });
});

describe("Validate.jsonProperty", () => {

  const sample = { a: { b: 1 }, list: [{ id: 1 }, { id: 2 }, { id: 2 }] };

  it("sentinel SENTINEL_UNDEFINED passes only when the path matches nothing", () => {
    expect(Validate.jsonProperty(sample, "$.nope", JsonUtils.SENTINEL_UNDEFINED, "t")).toBe(true);
    expect(Validate.jsonProperty(sample, "$.a.b", JsonUtils.SENTINEL_UNDEFINED, "t", "noassert")).toBe(false);
  });

  it("'count' compares the match count via Validate.number, ignoring content", () => {
    expect(Validate.jsonProperty(sample, "$.list[*].id", "3", "t", "count")).toBe(true);
    expect(Validate.jsonProperty(sample, "$.list[*].id", "99", "t", "count,noassert")).toBe(false);
  });

  it("'exists' passes if one or more properties matched, ignoring content and count", () => {
    expect(Validate.jsonProperty(sample, "$.a.b", "ignored", "t", "exists")).toBe(true);
    expect(Validate.jsonProperty(sample, "$.nope", "ignored", "t", "exists,noassert")).toBe(false);
  });

  it("'any' passes if any one match satisfies expected", () => {
    expect(Validate.jsonProperty(sample, "$.list[*].id", 2, "t", "any")).toBe(true);
    expect(Validate.jsonProperty(sample, "$.list[*].id", 99, "t", "any,noassert")).toBe(false);
  });

  it("'any' with zero matches is a plain fail, not a throw", () => {
    expect(Validate.jsonProperty(sample, "$.nope", 1, "t", "any,noassert")).toBe(false);
  });

  it("rejects 'any' combined with 'count'", () => {
    expect(() => Validate.jsonProperty(sample, "$.a.b", 1, "t", "any,count")).toThrow(/'any' and 'count' cannot be combined/);
  });

  it("default mode picks match[index] (0 unless given) and compares only that one value", () => {
    expect(Validate.jsonProperty(sample, "$.list[*].id", 2, "t", undefined, 1)).toBe(true);
    expect(Validate.jsonProperty(sample, "$.list[*].id", 1, "t", "noassert")).toBe(true);
  });

  it("dispatches a matched object value to Validate.jsonObject", () => {
    expect(Validate.jsonProperty(sample, "$.a", { b: 1 }, "t")).toBe(true);
  });

  it("dispatches a matched boolean value to Validate.boolean", () => {
    const withBool = { flag: true };
    expect(Validate.jsonProperty(withBool, "$.flag", true, "t")).toBe(true);
    expect(Validate.jsonProperty(withBool, "$.flag", false, "t", "noassert")).toBe(false);
  });

  it("default mode with zero matches is a plain fail, not a throw", () => {
    expect(Validate.jsonProperty(sample, "$.nope", 1, "t", "noassert")).toBe(false);
  });

  it("an out-of-range index throws unconditionally, even under 'noassert'", () => {
    expect(() => Validate.jsonProperty(sample, "$.list[*].id", 1, "t", "noassert", 99)).toThrow(/is out of range/);
  });

  it("SENTINEL_NULL asserts the matched value is a real null, via Validate.type", () => {
    const withNull = { a: null };
    expect(Validate.jsonProperty(withNull, "$.a", JsonUtils.SENTINEL_NULL, "t")).toBe(true);
    expect(Validate.jsonProperty(sample, "$.a.b", JsonUtils.SENTINEL_NULL, "t", "noassert")).toBe(false);
  });

  it("forwards mode flags (e.g. 'casesensitive') to whichever delegate ends up comparing the matched value", () => {
    const withText = { name: "Hello" };
    expect(Validate.jsonProperty(withText, "$.name", "hello", "t")).toBe(true);
    expect(Validate.jsonProperty(withText, "$.name", "hello", "t", "casesensitive,noassert")).toBe(false);
  });

  it("'not' inverts whichever strategy's result was computed", () => {
    expect(Validate.jsonProperty(sample, "$.a.b", 1, "t", "not,noassert")).toBe(false);
  });

  it("without 'noassert', a failing comparison throws", () => {
    expect(() => Validate.jsonProperty(sample, "$.a.b", 2, "my field")).toThrow(/my field/);
  });
});
