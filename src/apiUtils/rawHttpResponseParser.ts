/**
 * The parsed shape {@link RawHttpResponseParser.parse} produces — deliberately not
 * `APIUtils.HTTPResponse` itself (that type also carries `rawRequestBytes`/
 * `rawResponseBytes`, which this parser never sees — it only ever sees the response
 * bytes). `APIUtils.performRawHTTPOperation` combines this with those two raw buffers to
 * build the real `HTTPResponse` it returns. Keeping this type local (rather than
 * importing `APIUtils.HTTPResponse` here) avoids a circular import between this file and
 * `APIUtils.ts`.
 */
export interface ParsedRawResponse {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: string;
  bodyBuffer: Buffer;
}

/**
 * Parses a raw HTTP/1.1 response — exactly the bytes a socket actually received, status
 * line, headers, and body — into structured form. The counterpart, on the response side,
 * to the request-building this package already does by hand elsewhere.
 *
 * Built specifically for a test framework's own requirement (see
 * `~/repos/controlium/PRINCIPLES.md`'s "this is a test framework, not a standard
 * application" principle): an AUT under test may be catastrophically broken, so this
 * class **never throws**, regardless of input. Every method degrades gracefully —
 * `parse()`'s own doc comment below spells out exactly what each malformed shape
 * produces, so "what does a half-broken response look like" is a documented contract, not
 * an accident of whatever the code happens to do.
 *
 * All methods are static — no instantiation required.
 */
export class RawHttpResponseParser {
  /**
   * Parses the full raw response. Never throws.
   *
   * - Zero bytes received → `status: 0`, `statusMessage: ''`, `headers: {}`, empty body.
   * - Doesn't start with a recognisable `HTTP/<ver> <3-digit-code>[ <reason>]` status line
   *   at all (including a technically-`HTTP/`-prefixed but malformed one, e.g. a
   *   non-3-digit code) → `status: 0`, `headers: {}`, `body`/`bodyBuffer` = the *entire*
   *   raw response, verbatim — no attempt to guess a header/body split out of bytes that
   *   don't look like HTTP at all.
   * - Status line parses, but the header block's terminating blank line never arrives →
   *   the real `status`/`statusMessage`, whatever complete `Key: Value` lines appeared
   *   before the bytes ran out, and an empty body (no principled header/body boundary to
   *   slice a body from).
   * - Status line + complete header block, with `Content-Length`/`Transfer-Encoding`
   *   framing → body sliced per that framing (see {@link decodeChunked} and the
   *   `Content-Length` handling below for their own malformed-input behaviour).
   * - Status line + complete header block, neither framing header present → everything
   *   after the header block, verbatim, to EOF (the "connection close signals the end"
   *   case).
   *
   * `Content-Length` behaviour: fewer bytes arrived than declared → take exactly what
   * arrived, no padding. More bytes arrived than declared → `body`/`bodyBuffer` is exactly
   * the first N bytes; any surplus is visible only via the caller's own
   * `rawResponseBytes`, never folded into `body`. Not a valid non-negative integer →
   * treated as absent (falls through to the no-framing "verbatim to EOF" case).
   *
   * If **both** `Content-Length` and `Transfer-Encoding: chunked` are present — invalid
   * per RFC 7230 §3.3.3, but a legitimate *deliberate*-misbehaviour test case —
   * `Transfer-Encoding` wins, matching real servers' own request-smuggling-defense
   * precedent. A deliberate choice, not an oversight.
   *
   * Trailer headers after a chunked terminator are explicitly out of scope — never merged
   * into `headers`. A documented limitation, not a gap to discover later.
   *
   * Tolerates bare `\n` line endings throughout, not just `\r\n` — a test may deliberately
   * send either.
   */
  public static parse(raw: Buffer): ParsedRawResponse {

    ////////////////////////////////////////////////////
    //
    // Parses a raw response buffer in stages, each one degrading gracefully rather than
    // throwing: empty input, then "does it even start with a status line", then "is the
    // header block complete", then — only once all of that is known-good — decode the
    // body according to whatever framing (chunked/Content-Length/neither) the headers
    // declared.

    // No bytes at all — nothing to parse, return the all-empty shape immediately.
    if (raw.length === 0) {
      return { status: 0, statusMessage: "", headers: {}, body: "", bodyBuffer: Buffer.alloc(0) };
    }

    // Work out where the header block ends (null if its terminating blank line hasn't
    // arrived yet), then only search for the status line within that header portion if
    // it's known — otherwise search the whole buffer, since there's no other boundary yet.
    const headerBlockEnd = this.findHeaderBlockEnd(raw);
    const headerSource = headerBlockEnd === null ? raw : raw.subarray(0, headerBlockEnd);
    const statusLine = this.parseStatusLine(headerSource);

    // Doesn't start with a recognisable status line at all — nothing else here can be
    // trusted either, so return the whole raw buffer as the body, verbatim.
    if (statusLine === null) {
      return { status: 0, statusMessage: "", headers: {}, body: raw.toString("latin1"), bodyBuffer: raw };
    }

    // Status line parsed — parse whatever header lines appear after it (completeLines
    // drops any final, not-yet-terminated line, since it may simply not have arrived yet).
    const headerLinesText = headerSource.subarray(statusLine.lineEnd).toString("latin1");
    const headers = this.parseHeaderLines(this.completeLines(headerLinesText));

    if (headerBlockEnd === null) {
      // Header block never completed (no blank-line terminator found) — no principled
      // body boundary exists yet.
      return { status: statusLine.status, statusMessage: statusLine.statusMessage, headers, body: "", bodyBuffer: Buffer.alloc(0) };
    }

    // Header block is complete — work out which body-framing scheme (if any) the headers
    // declared, and slice the raw bytes after the header block as the body's raw input.
    const framing = this.parseFramingHeaders(headerSource);
    const bodyBytes = raw.subarray(headerBlockEnd);

    // Decode the body according to whichever framing applies: chunked takes priority over
    // Content-Length (see this method's own doc comment for why), Content-Length slices
    // to exactly that many bytes (capped at however many actually arrived), and if neither
    // framing header is present, the raw bytes are used as-is, verbatim, to EOF.
    const bodyBuffer = framing.transferEncodingChunked
      ? this.decodeChunked(bodyBytes)
      : framing.contentLength !== null
        ? bodyBytes.subarray(0, Math.min(framing.contentLength, bodyBytes.length))
        : bodyBytes;

    return {
      status: statusLine.status,
      statusMessage: statusLine.statusMessage,
      headers,
      body: bodyBuffer.toString("utf-8"),
      bodyBuffer,
    };
  }

  /**
   * Finds the offset of the first byte *after* the header block's terminating blank line
   * (`\r\n\r\n` or bare `\n\n`, whichever appears first) — or `null` if neither has
   * arrived yet. Shared with {@link APIUtils.performRawHTTPOperation}'s own live
   * completion-detection logic, so "is the header block complete" has exactly one
   * implementation, not two that could drift apart.
   */
  public static findHeaderBlockEnd(buffer: Buffer): number | null {
    // Search for both possible blank-line terminators independently — a response may use
    // either convention, and whichever one actually appears first in the buffer wins.
    const crlf = buffer.indexOf("\r\n\r\n");
    const lf = buffer.indexOf("\n\n");
    // Convert "not found" (-1) into null, and convert a found index into the offset of the
    // first byte *after* the terminator (+4 for "\r\n\r\n", +2 for "\n\n") — callers want
    // where the body starts, not where the terminator itself starts.
    const candidates = [crlf === -1 ? null : crlf + 4, lf === -1 ? null : lf + 2].filter(
      (value): value is number => value !== null
    );
    // Neither terminator found — header block isn't complete yet. Otherwise, the earliest
    // (smallest offset) candidate is the real terminator — the other search may have simply
    // matched further into the body/doesn't apply.
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  /**
   * Scans a complete header block (status line included — it simply never matches the
   * `name: value` pattern this looks for, so it's skipped without special-casing) for
   * just the two headers that govern body framing. Shared with
   * {@link APIUtils.performRawHTTPOperation}'s own live completion-detection logic — see
   * {@link findHeaderBlockEnd}'s own doc comment for why that sharing matters.
   *
   * `Content-Length` that isn't a valid non-negative integer is reported as `null`
   * (absent), not as an error — see {@link parse}'s own doc comment for what that implies
   * downstream. `Transfer-Encoding` is considered chunked if the header's value contains
   * `chunked` (case-insensitive) anywhere — real servers may list it alongside other
   * codings.
   */
  public static parseFramingHeaders(headerBlockBytes: Buffer): { contentLength: number | null; transferEncodingChunked: boolean } {
    // Split the whole header block (status line included) into lines — tolerating both
    // "\r\n" and bare "\n" endings, since a test may deliberately send either.
    const lines = headerBlockBytes.toString("latin1").split(/\r?\n/);
    let contentLength: number | null = null;
    let transferEncodingChunked = false;
    for (const line of lines) {
      // No colon at all — not a header line (this is what makes the status line itself
      // harmless to include: it never matches this pattern, so it's silently skipped).
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (name === "content-length") {
        // Only accept a genuine non-negative integer — anything else (empty, negative,
        // non-numeric) is treated as if the header were absent, not as an error.
        const parsed = Number(value);
        contentLength = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
      } else if (name === "transfer-encoding" && value.toLowerCase().includes("chunked")) {
        // Case-insensitive substring match — real servers may list "chunked" alongside
        // other codings, not necessarily as the only value.
        transferEncodingChunked = true;
      }
    }
    return { contentLength, transferEncodingChunked };
  }

  /** Parses `HTTP/<ver> <3-digit-code>[ <reason>]` from the start of `buf`. `null` if the
   * first line doesn't match that shape exactly — see {@link parse}'s own doc comment for
   * what the caller does with `null`. */
  private static parseStatusLine(buf: Buffer): { status: number; statusMessage: string; lineEnd: number } | null {
    // Find where the first line ends — if no "\n" has arrived at all yet, treat the whole
    // buffer as a single (incomplete) line rather than failing outright.
    const lfIdx = buf.indexOf("\n");
    const lineEnd = lfIdx === -1 ? buf.length : lfIdx + 1;
    // Extract that first line's text and strip a trailing "\r", so both "\r\n" and bare
    // "\n" line endings produce the same raw line to match against.
    const rawLine = buf.subarray(0, lfIdx === -1 ? buf.length : lfIdx).toString("latin1").replace(/\r$/, "");
    // Must match "HTTP/<ver> <3-digit-code>[ <reason>]" exactly — anything else (not HTTP
    // at all, or a non-3-digit code) is not a recognisable status line.
    const match = rawLine.match(/^HTTP\/\d\.\d (\d{3})(?: (.*))?$/);
    if (!match) return null;
    return { status: Number(match[1]), statusMessage: match[2] ?? "", lineEnd };
  }

  /** Splits `text` into lines, dropping a final unterminated line entirely — a line with
   * no trailing newline is ambiguous (more characters for it may simply not have arrived
   * yet), never a "complete" line. */
  private static completeLines(text: string): string[] {
    // Find the start of the last line terminator, whichever kind (CRLF or bare LF) appears
    // last in the text — everything after it is a trailing, not-yet-terminated line.
    const lastNewlineIdx = Math.max(text.lastIndexOf("\r\n"), text.lastIndexOf("\n"));
    // No terminator at all → nothing is a complete line yet. Otherwise, drop everything
    // from that last terminator onward (the ambiguous trailing partial line).
    const complete = lastNewlineIdx === -1 ? "" : text.slice(0, lastNewlineIdx);
    // Split the remaining, fully-terminated portion into lines, discarding any empty
    // strings the split produces (e.g. consecutive blank lines).
    return complete.split(/\r?\n/).filter((line) => line !== "");
  }

  /** Parses header lines into a name→value map, lowercasing names and preserving
   * repeated headers as an array rather than comma-joining them. A line with no `:` at
   * all (malformed) is skipped, not an error. */
  private static parseHeaderLines(lines: string[]): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const line of lines) {
      // No colon at all — malformed line, skip it rather than erroring.
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      // Empty name (e.g. a line starting with ":") — also malformed, skip it.
      if (name === "") continue;
      const value = line.slice(colonIdx + 1).trim();
      const existing = headers[name];
      if (existing === undefined) {
        // First time seeing this header name — store the value directly, not as an array.
        headers[name] = value;
      } else if (Array.isArray(existing)) {
        // Already a repeated header — append this occurrence to the existing array.
        existing.push(value);
      } else {
        // Second occurrence of a header that was previously a single string — promote it
        // to an array containing both values, in order of appearance.
        headers[name] = [existing, value];
      }
    }
    return headers;
  }

  /**
   * Decodes `Transfer-Encoding: chunked` framing back into plain body bytes. Never
   * throws: a chunk-size line that isn't valid hex, or a declared chunk size longer than
   * the bytes actually available, stops decoding immediately and returns whatever
   * decoded successfully up to that point (padding nothing, guessing nothing). Chunk
   * extensions (`;name=value` after the size) are recognised and ignored, not treated as
   * part of the size.
   */
  private static decodeChunked(bytes: Buffer): Buffer {

    ////////////////////////////////////////////////////
    //
    // Walks the chunked-encoded body one chunk at a time: each chunk is a hex size line,
    // then exactly that many bytes of data, then a trailing "\r\n" before the next chunk's
    // size line. Stops at the first sign of trouble (incomplete size line, invalid hex, or
    // not enough bytes for the declared size) and returns whatever decoded cleanly so far —
    // never throws, never pads, never guesses.

    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      // Find the end of this chunk's size line — if its terminating "\r\n" hasn't arrived
      // yet, the chunk header itself is incomplete, so stop here.
      const lineEndIdx = bytes.indexOf("\r\n", offset);
      if (lineEndIdx === -1) break;
      // Extract the size line, dropping any chunk extension (";name=value") after the
      // size — extensions are recognised and ignored, not treated as part of the size.
      const sizeLine = bytes.subarray(offset, lineEndIdx).toString("latin1").split(";")[0].trim();
      // Size must be valid hex — anything else means this isn't a well-formed chunk
      // boundary, so stop decoding rather than guessing.
      if (!/^[0-9a-fA-F]+$/.test(sizeLine)) break;
      const size = parseInt(sizeLine, 16);
      const dataStart = lineEndIdx + 2;
      // A zero-size chunk is the terminator — chunked decoding is done (trailer headers
      // after it, if any, are out of scope — see this class's own doc comment).
      if (size === 0) break;
      if (dataStart + size > bytes.length) {
        // Declared size is longer than what's actually arrived — take whatever bytes are
        // available, then stop (no padding, no assuming more will arrive).
        chunks.push(bytes.subarray(dataStart, bytes.length));
        break;
      }
      // Normal case: take exactly the declared number of bytes as this chunk's data, then
      // advance past it and its own trailing "\r\n" to the next chunk's size line.
      chunks.push(bytes.subarray(dataStart, dataStart + size));
      offset = dataStart + size + 2;
    }
    // Stitch every successfully-decoded chunk's data back together into one contiguous
    // buffer — this is the plain, un-chunked body.
    return Buffer.concat(chunks);
  }
}
