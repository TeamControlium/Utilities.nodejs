import { StringUtils } from "./stringUtils.js";

describe("StringUtils.split", () => {

  it("keeps a bare newline in the input intact — regression: the dotAll-less token regex used to silently drop line-terminator characters, fusing the characters either side of them together", () => {
    expect(StringUtils.split("a\nb,c", ",")).toEqual(["a\nb", "c"]);
  });

  it("still respects quoting around a separator when quote-awareness is requested (the default)", () => {
    expect(StringUtils.split('a,"b,c",d', ",")).toEqual(["a", "b,c", "d"]);
  });

  it("with quote-awareness turned off, splits on every separator including ones inside quotes", () => {
    expect(StringUtils.split('a,"b,c",d', ",", false)).toEqual(["a", '"b', 'c"', "d"]);
  });
});

describe("StringUtils.splitRemainingQuoted", () => {

  it("behaves exactly like plain splitRemaining when no field is quoted", () => {
    expect(StringUtils.splitRemainingQuoted("a|b|c", "|", 2)).toEqual(["a", "b|c"]);
    expect(StringUtils.splitRemainingQuoted("a|b|c", "|", 3)).toEqual(["a", "b", "c"]);
  });

  it("a quoted field protects a literal separator inside it", () => {
    expect(StringUtils.splitRemainingQuoted("'a|b'|c", "|", 2)).toEqual(["a|b", "c"]);
  });

  it("double quotes work the same way as single quotes", () => {
    expect(StringUtils.splitRemainingQuoted('"a|b"|c', "|", 2)).toEqual(["a|b", "c"]);
  });

  it("a doubled same-kind quote inside a quoted field is a literal quote character", () => {
    expect(StringUtils.splitRemainingQuoted("'it''s a test'|c", "|", 2)).toEqual(["it's a test", "c"]);
    expect(StringUtils.splitRemainingQuoted('"a""b"|c', "|", 2)).toEqual(['a"b', "c"]);
  });

  it("the opposite quote kind is just literal text inside a quoted field, no escaping needed", () => {
    expect(StringUtils.splitRemainingQuoted(`'she said "hi"'|c`, "|", 2)).toEqual(['she said "hi"', "c"]);
  });

  it("text immediately after a closing quote is appended onto the field (shell-style adjacency), not an error", () => {
    expect(StringUtils.splitRemainingQuoted("'abc'def|c", "|", 2)).toEqual(["abcdef", "c"]);
  });

  it("an empty quoted field is valid and yields an empty string", () => {
    expect(StringUtils.splitRemainingQuoted("''|c", "|", 2)).toEqual(["", "c"]);
  });

  it("a stray quote character mid-field, not at the start, is ordinary literal text — unaffected, same as plain splitRemaining", () => {
    expect(StringUtils.splitRemainingQuoted("ab'cd|e", "|", 2)).toEqual(["ab'cd", "e"]);
  });

  it("the final, absorbed field is never quote-processed, even if it starts with a quote character", () => {
    expect(StringUtils.splitRemainingQuoted("a|'b|c'", "|", 2)).toEqual(["a", "'b|c'"]);
  });

  it("an unterminated quote throws a clear error", () => {
    expect(() => StringUtils.splitRemainingQuoted("'unterminated|b", "|", 2)).toThrow(/unterminated/);
  });

  it("returns fewer than `limit` elements when the input doesn't have enough separators, matching splitRemaining — never pads with empty strings", () => {
    expect(StringUtils.splitRemainingQuoted("a", "|", 3)).toEqual(["a"]);
    expect(StringUtils.splitRemainingQuoted("", "|", 2)).toEqual([""]);
  });

  it("a trailing separator with nothing after it still produces one further, empty field", () => {
    expect(StringUtils.splitRemainingQuoted("a|", "|", 2)).toEqual(["a", ""]);
  });
});

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

describe("StringUtils.truncateIfNeeded", () => {

  it("leaves text unchanged when it already fits", () => {
    expect(StringUtils.truncateIfNeeded("short", 100)).toBe("short");
  });

  it("leaves text unchanged when it's exactly at maxLength", () => {
    expect(StringUtils.truncateIfNeeded("a".repeat(50), 50)).toBe("a".repeat(50));
  });

  it("truncates over-length text to exactly maxLength", () => {
    const result = StringUtils.truncateIfNeeded("x".repeat(200), 80);
    expect(result).toHaveLength(80);
  });

  it("truncates over-length text that is nonetheless shorter than maxLength plus the marker — regression: used to be left unchanged, or even grown, instead of capped", () => {
    // 70 characters comfortably fits under maxLength 100, so this must NOT truncate at all —
    // this is the exact case the original buggy guard (`textLength <= maxLength -
    // truncationText.length`) got wrong, truncating text that already fit.
    expect(StringUtils.truncateIfNeeded("x".repeat(70), 100)).toBe("x".repeat(70));
  });

  it("preserves the final 16 characters of the original text", () => {
    const text = `${"x".repeat(200)}END-MARKER-16CH-`;
    const result = StringUtils.truncateIfNeeded(text, 80);
    expect(result.endsWith("END-MARKER-16CH-")).toBe(true);
  });

  it("the truncation marker reports the original length", () => {
    const result = StringUtils.truncateIfNeeded("x".repeat(500), 80);
    expect(result).toContain("truncated as 500 too long");
  });

  it("never returns a result longer than maxLength — regression: negative slice indices used to balloon the result past maxLength (and past the original length)", () => {
    const result = StringUtils.truncateIfNeeded("x".repeat(1000), 60);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("rejects a non-positive maxLength", () => {
    expect(() => StringUtils.truncateIfNeeded("text", 0)).toThrow(/\[maxLength\] must be a positive integer/);
  });

  it("rejects a non-integer maxLength", () => {
    expect(() => StringUtils.truncateIfNeeded("text", 4.5)).toThrow(/\[maxLength\] must be a positive integer/);
  });

  it("falls back to a plain hard cut (never throws) when maxLength is too small to fit the marker plus the kept end-text", () => {
    expect(StringUtils.truncateIfNeeded("x".repeat(1000), 5)).toBe("xxxxx");
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

describe("StringUtils.cleanControlChars", () => {

  it("leaves text with no control characters completely unchanged, for every mode", () => {
    expect(StringUtils.cleanControlChars("plain text", "escape")).toBe("plain text");
    expect(StringUtils.cleanControlChars("plain text", "hex")).toBe("plain text");
    expect(StringUtils.cleanControlChars("plain text", "strip")).toBe("plain text");
  });

  it("'escape' mode uses familiar named escapes for CR/LF/tab", () => {
    expect(StringUtils.cleanControlChars("a\r\nb\tc", "escape")).toBe("a\\r\\nb\\tc");
  });

  it("defaults to 'escape' mode when mode is omitted", () => {
    expect(StringUtils.cleanControlChars("a\r\nb\tc")).toBe("a\\r\\nb\\tc");
  });

  it("'escape' mode uses named escapes for \\0, \\b, \\v, \\f too", () => {
    expect(StringUtils.cleanControlChars("\0\b\v\f", "escape")).toBe("\\0\\b\\v\\f");
  });

  it("'escape' mode falls back to \\xNN (always two digits) for a control char with no named escape", () => {
    expect(StringUtils.cleanControlChars("a\x01b", "escape")).toBe("a\\x01b");
    expect(StringUtils.cleanControlChars("a\x1Fb", "escape")).toBe("a\\x1Fb");
  });

  it("'escape' mode escapes DEL (0x7F) via the hex fallback — it has no named escape", () => {
    expect(StringUtils.cleanControlChars("a\x7Fb", "escape")).toBe("a\\x7Fb");
  });

  it("'hex' mode replaces every control char with literal 0xNN text, not a backslash escape", () => {
    expect(StringUtils.cleanControlChars("a\r\nb", "hex")).toBe("a0x0D0x0Ab");
  });

  it("'hex' mode always zero-pads to exactly two digits", () => {
    expect(StringUtils.cleanControlChars("\x01", "hex")).toBe("0x01");
  });

  it("'strip' mode removes every control character outright", () => {
    expect(StringUtils.cleanControlChars("a\r\nb\tc\x01d", "strip")).toBe("abcd");
  });

  it("does not touch C1 control characters (0x80-0x9F) — only C0 + DEL are in scope", () => {
    const c1Char = String.fromCharCode(0x85);
    expect(StringUtils.cleanControlChars(`a${c1Char}b`, "escape")).toBe(`a${c1Char}b`);
  });

  it("does not touch ordinary whitespace that isn't a control character (e.g. a plain space)", () => {
    expect(StringUtils.cleanControlChars("a b", "strip")).toBe("a b");
  });

  it("handles multiple control characters of different kinds in one string", () => {
    expect(StringUtils.cleanControlChars("start\r\nmiddle\x01end\x7F.", "escape")).toBe("start\\r\\nmiddle\\x01end\\x7F.");
  });

  it("rejects a non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => StringUtils.cleanControlChars(42 as any, "escape")).toThrow();
  });

  it("rejects an unrecognised mode", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => StringUtils.cleanControlChars("text", "bogus" as any)).toThrow(/mode.*must be 'escape', 'hex' or 'strip'/);
  });
});
