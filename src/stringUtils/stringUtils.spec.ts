import { StringUtils } from "./stringUtils.js";

describe("StringUtils.wrapLines", () => {

  it("leaves a line within the width completely unchanged", () => {
    expect(StringUtils.wrapLines("short", 100)).toBe("short");
  });

  it("splits a single over-length line at a hard character boundary", () => {
    expect(StringUtils.wrapLines("a".repeat(10), 4)).toBe("aaaa\naaaa\naa");
  });

  it("preserves existing line breaks, wrapping only the lines that actually need it", () => {
    expect(StringUtils.wrapLines("abc\n" + "b".repeat(10), 4)).toBe("abc\nbbbb\nbbbb\nbb");
  });

  it("an empty string stays empty", () => {
    expect(StringUtils.wrapLines("", 10)).toBe("");
  });

  it("a line exactly at the width is left untouched", () => {
    expect(StringUtils.wrapLines("abcd", 4)).toBe("abcd");
  });

  it("rejects a non-positive width", () => {
    expect(() => StringUtils.wrapLines("text", 0)).toThrow(/\[width\] must be a positive integer/);
  });

  it("rejects a non-integer width", () => {
    expect(() => StringUtils.wrapLines("text", 4.5)).toThrow(/\[width\] must be a positive integer/);
  });
});

describe("StringUtils.resolveLineEndingEscape", () => {

  it("undefined (no override) resolves to a plain newline", () => {
    expect(StringUtils.resolveLineEndingEscape(undefined)).toBe("\n");
  });

  it("single-letter escapes: /n /r /t /b /f /v /0", () => {
    expect(StringUtils.resolveLineEndingEscape("/n/r/t/b/f/v/0")).toBe("\n\r\t\b\f\v\0");
  });

  it("multi-escape clause composes in order", () => {
    expect(StringUtils.resolveLineEndingEscape("/r/t")).toBe("\r\t");
  });

  it("// resolves to a literal slash", () => {
    expect(StringUtils.resolveLineEndingEscape("//")).toBe("/");
  });

  it("/#<number>; is decimal by default", () => {
    expect(StringUtils.resolveLineEndingEscape("/#65;")).toBe("A");
  });

  it("/#<number>; 0x/0o/0b prefixes opt into hex/octal/binary", () => {
    expect(StringUtils.resolveLineEndingEscape("/#0x41;")).toBe("A");
    expect(StringUtils.resolveLineEndingEscape("/#0o101;")).toBe("A");
    expect(StringUtils.resolveLineEndingEscape("/#0b1000001;")).toBe("A");
  });

  it("a character not preceded by / is copied through verbatim", () => {
    expect(StringUtils.resolveLineEndingEscape("a/nb")).toBe("a\nb");
  });

  it("rejects an unrecognised escape", () => {
    expect(() => StringUtils.resolveLineEndingEscape("/z")).toThrow(/unrecognised escape/);
  });

  it("rejects an unterminated /# numeric escape", () => {
    expect(() => StringUtils.resolveLineEndingEscape("/#65")).toThrow(/unterminated/);
  });

  it("rejects a /# numeric escape that is not a valid non-negative integer", () => {
    expect(() => StringUtils.resolveLineEndingEscape("/#-5;")).toThrow(/not a valid character code/);
    expect(() => StringUtils.resolveLineEndingEscape("/#;")).toThrow(/not a valid character code/);
  });

  it("rejects a trailing, unterminated /", () => {
    expect(() => StringUtils.resolveLineEndingEscape("a/")).toThrow(/unrecognised escape/);
  });
});
