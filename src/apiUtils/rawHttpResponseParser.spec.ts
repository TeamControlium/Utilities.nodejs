import { RawHttpResponseParser } from "./rawHttpResponseParser.js";

function buf(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

describe("RawHttpResponseParser.parse", () => {

  it("zero bytes received", () => {
    const result = RawHttpResponseParser.parse(Buffer.alloc(0));
    expect(result).toEqual({ status: 0, statusMessage: "", headers: {}, body: "", bodyBuffer: Buffer.alloc(0) });
  });

  it("doesn't start with HTTP/ at all — whole raw bytes become the body, verbatim", () => {
    const raw = buf("not http at all\r\njust garbage");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(0);
    expect(result.statusMessage).toBe("");
    expect(result.headers).toEqual({});
    expect(result.body).toBe("not http at all\r\njust garbage");
    expect(result.bodyBuffer.equals(raw)).toBe(true);
  });

  it("status code not exactly 3 digits — treated as unparseable, same as non-HTTP garbage", () => {
    const raw = buf("HTTP/1.1 99999 Nope\r\nContent-Length: 0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(0);
    expect(result.body).toBe(raw.toString("latin1"));
  });

  it("non-numeric status code — treated as unparseable", () => {
    const raw = buf("HTTP/1.1 ABC Nope\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(0);
  });

  it("status line parses but header block never completes — no blank line arrives", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Partial: ye");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(200);
    expect(result.statusMessage).toBe("OK");
    // "X-Partial: ye" has no trailing newline yet — ambiguous (more of it may simply not
    // have arrived), so it's dropped entirely rather than treated as complete.
    expect(result.headers).toEqual({ "content-type": "text/plain" });
    expect(result.body).toBe("");
    expect(result.bodyBuffer.length).toBe(0);
  });

  it("missing reason phrase — statusMessage is empty, not an error", () => {
    const raw = buf("HTTP/1.1 204\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(204);
    expect(result.statusMessage).toBe("");
  });

  it("Content-Length framing — exact match", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello");
  });

  it("Content-Length framing — fewer bytes arrived than declared: take exactly what arrived, no padding", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhi");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("hi");
    expect(result.bodyBuffer.length).toBe(2);
  });

  it("Content-Length framing — more bytes arrived than declared: body is exactly the first N, surplus not included", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhiTHIS_IS_SURPLUS");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("hi");
    expect(result.bodyBuffer.length).toBe(2);
  });

  it("Content-Length not a valid non-negative integer — treated as absent, falls to verbatim-to-EOF", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nContent-Length: not-a-number\r\n\r\neverything here");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("everything here");
  });

  it("Transfer-Encoding: chunked — clean multi-chunk decode", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("hello world");
  });

  it("Transfer-Encoding: chunked — malformed hex size line: stop and return what decoded so far", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\nZZZ\r\nbroken\r\n0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("hello");
  });

  it("Transfer-Encoding: chunked — truncated before enough bytes for the declared size: take what's available", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nabc");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("abc");
  });

  it("Transfer-Encoding: chunked — truncated before the terminating 0-chunk: returns whatever decoded", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("hello");
  });

  it("both Content-Length and Transfer-Encoding present — Transfer-Encoding wins, deliberately", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nContent-Length: 999\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("abc");
  });

  it("no framing header at all — everything after the header block, verbatim, to EOF", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nwhatever is left, no framing told us how much");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.body).toBe("whatever is left, no framing told us how much");
  });

  it("repeated headers are preserved as an array, not comma-joined", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  it("header names are lowercased", () => {
    const raw = buf("HTTP/1.1 200 OK\r\nX-Custom-HEADER: Value\r\nContent-Length: 0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.headers["x-custom-header"]).toBe("Value");
  });

  it("header value containing a colon is preserved intact (only the first colon splits name/value)", () => {
    const raw = buf("HTTP/1.1 302 Found\r\nLocation: http://x:8080/y\r\nContent-Length: 0\r\n\r\n");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.headers.location).toBe("http://x:8080/y");
  });

  it("tolerates bare LF line endings throughout, not just CRLF", () => {
    const raw = buf("HTTP/1.1 200 OK\nContent-Length: 5\n\nhello");
    const result = RawHttpResponseParser.parse(raw);
    expect(result.status).toBe(200);
    expect(result.headers["content-length"]).toBe("5");
    expect(result.body).toBe("hello");
  });
});

describe("RawHttpResponseParser.findHeaderBlockEnd", () => {

  it("finds the offset just past a CRLF-terminated header block", () => {
    const raw = buf("HTTP/1.1 200 OK\r\n\r\nbody");
    expect(RawHttpResponseParser.findHeaderBlockEnd(raw)).toBe(raw.length - 4);
  });

  it("finds the offset just past a bare-LF-terminated header block", () => {
    const raw = buf("HTTP/1.1 200 OK\n\nbody");
    expect(RawHttpResponseParser.findHeaderBlockEnd(raw)).toBe(raw.length - 4);
  });

  it("returns null when the blank line hasn't arrived yet", () => {
    expect(RawHttpResponseParser.findHeaderBlockEnd(buf("HTTP/1.1 200 OK\r\nX-Partial: y"))).toBeNull();
  });
});

describe("RawHttpResponseParser.parseFramingHeaders", () => {

  it("extracts a valid Content-Length", () => {
    expect(RawHttpResponseParser.parseFramingHeaders(buf("HTTP/1.1 200 OK\r\nContent-Length: 42\r\n")))
      .toEqual({ contentLength: 42, transferEncodingChunked: false });
  });

  it("detects Transfer-Encoding: chunked", () => {
    expect(RawHttpResponseParser.parseFramingHeaders(buf("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n")))
      .toEqual({ contentLength: null, transferEncodingChunked: true });
  });

  it("reports neither when absent", () => {
    expect(RawHttpResponseParser.parseFramingHeaders(buf("HTTP/1.1 200 OK\r\nConnection: close\r\n")))
      .toEqual({ contentLength: null, transferEncodingChunked: false });
  });

  it("treats an invalid Content-Length as absent", () => {
    expect(RawHttpResponseParser.parseFramingHeaders(buf("Content-Length: -5\r\n")).contentLength).toBeNull();
    expect(RawHttpResponseParser.parseFramingHeaders(buf("Content-Length: abc\r\n")).contentLength).toBeNull();
  });
});
