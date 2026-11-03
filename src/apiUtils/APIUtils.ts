import { fetch } from 'undici';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

import { Detokeniser, JsonUtils, Log, LogLevels, Utils, ValueExpression, XmlUtils, YamlUtils } from '../index.js';
import { RawHttpResponseParser } from './rawHttpResponseParser.js';

/**
 * Idle-quiet window (ms) used by {@link APIUtils.performRawHTTPOperation} to decide a
 * response is complete when the server doesn't proactively close the connection. Only
 * applies after the first byte of a response has arrived — see that method for why.
 */
const RAW_RESPONSE_IDLE_MS = 300;

interface LoggingOptions {
  stackOffset?: number
}

export class APIUtils {

  /**
   * Verify if HTTP server listening
   * @param url
   * Protocol and domain of HTTP Server (IE. http://localhost:4200)
   * @param timeoutMS
   * Maximum time (in Milliseconds to wait for response)
   * @returns boolean
   * true if Server alive and responding
   * false if no response with timeout
   * @abstract
   * A fetch 'HEAD' request is used to obtain a header from the server.  If no
   * response then it is assumed nothing listening
   */
  public static async isWebServerListening(url: string, timeoutMS: number): Promise<boolean> {
    Utils.assertType(url, "string", "APIUtils.isWebServerListening", "url");
    Utils.assertType(timeoutMS, "number", "APIUtils.isWebServerListening", "timeoutMS");
    try {
      // Send a HEAD request — if it completes at all (any status code), something is
      // listening and responding; we don't care what it actually said.
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMS) });
      return true;
    } catch (err) {
      // undici may throw an AggregateError (multiple underlying causes bundled together)
      // rather than a single error — handle that shape separately from a plain error.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (err && typeof err === 'object' && 'errors' in err && Array.isArray((err as any).errors)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agg = err as { errors: any[] };
        // Walk each underlying cause — if any one of them is a connection refusal, that's
        // decisive: nothing is listening at all.
        for (const e of agg.errors) {
          const message = Utils.errorMessage(e);
          Log.writeLine(LogLevels.TestDebug, `Error:\n${e?.code ?? 'no code'} (${message})`);
          if (message.includes('ECONNREFUSED')) {
            return false;
          }
        }
      } else {
        // Plain single error — same ECONNREFUSED check, just without the AggregateError
        // unwrapping step.
        const message = Utils.errorMessage(err);
        const code = (err as { code?: unknown } | null)?.code;
        Log.writeLine(LogLevels.TestDebug, `Error:\n${code ?? 'no code'} (${message})`);
        if (message.includes('ECONNREFUSED')) {
          return false;
        }
      }
      // We are only interested in if ECONNREFUSED.  All else means there be _something_ listening...
      return true;
    }
  }

  /**
   * Waits for coherent response from given HTTP url
   * @param url
   * Protocol and domain of HTTP Server (IE. http://localhost:4200)
   * @param maxSecondsToWait
   * Maximum time to wait (in seconds) for a coherent response from given url
   * @param maxResponseTimeMS (optional, default 1000)
   * Maximum time for a response (in milliseconds) to a http HEAD request
   * @returns
   * Promise of boolean
   * true - Webserver on given url is alive and responding
   * false - No response from given url within timeout.
   * @abstract
   * URL is polled
   */
  public static async waitForWebServerListening(url: string, maxSecondsToWait: number, { maxResponseTimeMS = 1000 }: { maxResponseTimeMS?: number } = {}): Promise<boolean> {
    Utils.assertType(url, "string", "APIUtils.waitForWebServerListening", "url");
    Utils.assertType(maxSecondsToWait, "number", "APIUtils.waitForWebServerListening", "maxSecondsToWait");
    Utils.assertType(maxResponseTimeMS, "number", "APIUtils.waitForWebServerListening", "maxResponseTimeMS");
    const pollIntervalMs = 500;
    Log.writeLine(LogLevels.TestInformation, `Waiting for AUT at ${url} to become available (overall timeout: ${maxSecondsToWait} seconds)...`);
    const startTime = Date.now();
    let elapsed = 0;
    // Keep polling isWebServerListening until it reports true, or until the overall
    // timeout is exceeded — whichever happens first.
    while (!await this.isWebServerListening(url, maxResponseTimeMS)) {
      const oldElapsed = elapsed;
      elapsed = Math.floor((Date.now() - startTime) / 1000);
      // Overall wait budget exhausted — give up and report failure.
      if (elapsed >= maxSecondsToWait) {
        Log.writeLine(LogLevels.Error, `Timeout reached: Server did not respond within ${maxSecondsToWait} seconds.`);
        return false;
      }
      // Stick a confidence message out every 4 seconds
      if ((oldElapsed != elapsed) && (elapsed % 4 == 0)) {
        Log.writeLine(LogLevels.TestInformation, `Waiting for AUT: Waited ${elapsed} seconds so far (Max wait ${maxSecondsToWait} seconds)`);
      }
      // Wait before the next poll attempt, rather than hammering the server continuously.
      await Utils.sleep(pollIntervalMs, false);
    }
    return true;
  }

  /**
   * Sends an HTTP request using nothing but `net`/`tls` sockets this method owns itself —
   * no `fetch`, no undici dispatcher for anything beyond proxy `CONNECT` tunnelling. See
   * `~/repos/controlium/PRINCIPLES.md`'s "this is a test framework, not a standard
   * application" principle for why: a higher-level HTTP client validates/normalises
   * things a *test* may deliberately want to violate (a `Content-Length` that doesn't
   * match the real body, duplicate same-named headers that `fetch`'s `Headers` class
   * would silently comma-join per the Fetch Standard's own contract, etc.) — this method
   * sends exactly the bytes it's told to, for every request, happy-path included, not
   * just deliberate-misbehaviour tests.
   *
   * Every call uses a brand-new, single-use connection — never pooled, never reused,
   * regardless of what (if anything) `httpRequest.headers` says about `Connection` — one
   * call, one connection, always torn down afterward (success, failure, or timeout), so
   * one test's failure — however catastrophic — can never leave a connection for a later
   * test to inherit. No process-wide hooks of any kind (no `diagnostics_channel`, no
   * monkey-patched prototypes) — every socket this method touches is exclusively its own,
   * created and destroyed within this one call, so nothing else running in the same Node
   * process (including an in-process AUT, which `API_AUTWrapper` already supports via its
   * own bootstrapper) can be affected by it.
   *
   * Two headers are auto-injected when missing — and *only* when missing; the key's mere
   * presence (any value, including `null`) always suppresses injection, so a test
   * deliberately sending `{ Host: null }` to probe a missing-`Host` scenario is never
   * silently overridden:
   * - `Host`, HTTP/1.1's one genuinely mandatory header (RFC 7230 §5.4) — without it most
   *   real AUTs will misroute or reject the request outright.
   * - `Content-Length`, when (and only when) a body is present — without it most real
   *   servers will simply hang waiting for a body length they were never told.
   *
   * Deliberately does **not** replicate any of `fetch`/undici's other default headers
   * (`Connection`, `Accept`, `Accept-Language`, `Accept-Encoding`, `Sec-Fetch-Mode`,
   * `User-Agent`) — those are browser/fetch-emulation artifacts, not HTTP requirements,
   * and no mainstream Node server framework (raw `http`, Express, Fastify, NestJS) treats
   * any of them as required.
   *
   * The response is parsed via {@link RawHttpResponseParser.parse} — see its own doc
   * comment for the full never-throws degradation contract for malformed/incomplete
   * responses. `rawResponseBytes` on the return value is always the literal bytes
   * received, regardless of how (or whether) they could be parsed.
   *
   * Response-completion detection is framing-aware, not a blind wait: once the header
   * block's terminating blank line has arrived, `Content-Length`/`Transfer-Encoding:
   * chunked` are inspected and the read finishes the instant the declared body is fully
   * present — no artificial delay for the two well-defined cases. Only when *neither*
   * framing header is present (or `Content-Length` isn't a valid value) does this fall
   * back to a short idle-quiet window (`RAW_RESPONSE_IDLE_MS`) after the last byte seen,
   * the same heuristic used throughout — necessary there because a server's default
   * keep-alive behaviour means the connection may not close by itself for a long time, and
   * there's no other signal available for "the response is actually finished."
   *
   * URL construction (protocol/host/resourcePath/queryString → origin + path) goes
   * through the existing {@link buildURL}'s percent-encoding/normalisation. An IPv6
   * literal host is handled correctly: `Host` keeps its bracketed form (`[::1]:3000`, per
   * RFC 3986/7230), but the brackets are stripped before being handed to
   * `net.connect`/`tls.connect` (which reject the bracketed form outright — confirmed
   * live) and TLS's default SNI `servername`.
   *
   * @param httpRequest - Details of the request. `headers` is sent byte-for-byte as
   *   given, in the order provided — set a header's value to `null` to omit it entirely
   *   (including to suppress `Host`/`Content-Length` auto-injection). `body` is sent as-is
   *   (`Buffer`/`string`) or JSON-stringified (`object`).
   * @param options.targetFriendlyName - Purely cosmetic: included in the request/response
   *   detail logging (see {@link logRawRequestResponseDump}) so a reader can tell which named AUT a
   *   dump belongs to. This function itself has no concept of a named AUT — it's a plain
   *   HTTP operation, reusable for anything — so a caller that wraps a named target (e.g.
   *   `API_AUTWrapper`) passes its own name through purely for display; omit it and the
   *   dump just shows the URL on its own.
   * @returns The full parsed response, plus the exact raw bytes written/received.
   * @throws {Error} If the connection itself cannot be established (e.g. connection
   *   refused, DNS failure, proxy tunnel rejected) or `httpRequest.timeout` is exceeded
   *   before any connection could be made at all.
   */
  public static async performRawHTTPOperation(
    httpRequest: APIUtils.HTTPRequest,
    options?: { targetFriendlyName?: string }
  ): Promise<APIUtils.HTTPResponse> {
    const API_DEFAULT_TIMEOUT = 10000;
    const maybeTargetFriendlyName = options?.targetFriendlyName ? `(${options.targetFriendlyName}) ` : '';


    // Validate the request envelope itself before doing anything else — a non-object
    // httpRequest, or a headers value that isn't a non-null object, is always a caller
    // mistake, never something a test would deliberately want to send.
    if (Utils.isNullOrUndefined(httpRequest) || typeof httpRequest !== 'object') {
      const errText = `[httpRequest] ${maybeTargetFriendlyName}must be a non-null object. Is [${Utils.describeValue(httpRequest)}]`;
      Log.logErrorAndThrow(errText);
    }
    if (Utils.isNullOrUndefined(httpRequest.headers) || typeof httpRequest.headers !== 'object') {
      const errText = `[httpRequest.headers] ${maybeTargetFriendlyName}must be a non-null object. Is [${Utils.describeValue(httpRequest.headers)}]`;
      Log.logErrorAndThrow(errText);
    }
    // Required to be *a string*, not a *valid* method — a caller deliberately testing a
    // malformed/unusual method is still free to pass any string (e.g. '', 'GE T'). This
    // only stops the case where method is omitted entirely and would otherwise be sent
    // as the literal text "undefined" — an accident, not a deliberate test.
    Utils.assertType(httpRequest.method, "string", "APIUtils.performRawHTTPOperation", "httpRequest.method");
    // No timeout given — fall back to the package default rather than waiting forever.
    if (Utils.isNullOrUndefined(httpRequest.timeout)) {
      httpRequest.timeout = API_DEFAULT_TIMEOUT;
    }

    let socket: Duplex | undefined;

    try {
      // Wrap the entire connect-send-receive sequence in a single overall timeout — if
      // nothing has completed within httpRequest.timeout, the whole operation is aborted,
      // regardless of which individual step it's currently stuck in.
      return await Utils.timeoutPromise(
        (async (): Promise<APIUtils.HTTPResponse> => {
          // Build the target URL and split it into the path (for the request line) and
          // connection target (for the socket itself).
          const url = new URL(this.buildURL(httpRequest));
          const pathWithQuery = url.pathname + url.search;
          // net.connect/tls.connect reject the bracketed IPv6 form URL.hostname gives
          // ("[::1]" -> ENOTFOUND, confirmed live) — they need the bare address. url.host
          // (used for the Host header below) correctly keeps the brackets; only the
          // socket-connection target needs stripping.
          const connectHost = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
          const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

          // Establish the connection — through a proxy tunnel if one was configured,
          // otherwise directly to the target. A proxy tunnel may hand back bytes
          // ("preSeeded") that already belong to the real response, read incidentally
          // while negotiating the tunnel itself.
          let preSeeded: Buffer = Buffer.alloc(0);
          if (!Utils.isNullOrUndefined(httpRequest.proxy)) {
            const tunnel = await this.connectThroughProxy(httpRequest.proxy as string, url.protocol, connectHost, port);
            socket = tunnel.socket;
            preSeeded = tunnel.preSeeded;
          } else {
            socket = await this.connectDirect(url.protocol, connectHost, port);
          }

          // Build the literal request bytes, log them (before writing, so the log always
          // reflects what's about to be sent even if the write itself somehow fails), then
          // write them to the socket.
          const requestBytes = this.buildRawRequestBytes(httpRequest.method, pathWithQuery, httpRequest.headers, url.host, httpRequest.body);
          this.logRawRequestResponseDump('request', requestBytes, url.toString(), options?.targetFriendlyName, { stackOffset: 1});
          socket.write(requestBytes);

          // Read the response until it's judged complete, log the raw bytes received, then
          // parse them into structured form and merge in the exact raw request/response
          // byte buffers for the caller.
          const responseBytes = await this.readRawResponse(socket, preSeeded);
          this.logRawRequestResponseDump('response', responseBytes, url.toString(), options?.targetFriendlyName, { stackOffset: 1 });

          const parsed = RawHttpResponseParser.parse(responseBytes);
          return { ...parsed, rawRequestBytes: requestBytes, rawResponseBytes: responseBytes };
        })(),
        { timeoutMS: httpRequest.timeout, friendlyName: `APIUtils.performRawHTTPOperation${maybeTargetFriendlyName}` }
      );
    } catch (err) {
      // Log then rethrow — the caller still needs to see the failure (connection refused,
      // DNS failure, proxy rejection, or overall timeout), this just also records it.
      Log.writeLine(LogLevels.Error, `RAW HTTP OPERATION ERROR: ${Utils.errorMessage(err)}`);
      throw err;
    } finally {
      // Always tear the socket down — success, failure, or timeout — so no connection
      // from this call ever lingers for a later test to inherit.
      socket?.destroy();
    }
  }

  /**
   * Connects directly to `connectHost:port` — no proxy in the loop. A plain
   * `net`/`tls` connection, no undici dispatcher involved at all: an ordinary AUT
   * (Express, Fastify, NestJS, anything without explicit `CONNECT` support) doesn't
   * understand a `CONNECT` handshake, and none is needed for a direct connection anyway.
   */
  private static async connectDirect(protocol: string, connectHost: string, port: number): Promise<Duplex> {
    // https: needs a TLS socket (with certificate validation deliberately disabled — a
    // test AUT is commonly self-signed); anything else gets a plain TCP socket.
    const socket = protocol === 'https:'
      ? tls.connect({ host: connectHost, port, servername: connectHost, rejectUnauthorized: false })
      : net.connect({ host: connectHost, port });
    // Wait for the connection (or TLS handshake) to actually complete before handing the
    // socket back — a caller must never be given a socket that isn't ready to write to yet.
    await new Promise<void>((resolve, reject) => {
      socket.once(protocol === 'https:' ? 'secureConnect' : 'connect', () => resolve());
      socket.once('error', reject);
    });
    return socket;
  }

  /**
   * Connects to `proxyUriString`'s own address and establishes a real `CONNECT` tunnel
   * to `connectHost:port` through it — hand-rolled, not via undici's `ProxyAgent`.
   * Confirmed by reading undici's own source (`proxy-agent.js`): `ProxyAgent` rewrites
   * every request — `.connect()` included — as an absolute-URI forward (`opts.path =
   * origin + path`), explicitly commented "without tunneling"; it sends `CONNECT
   * http://host:port/ HTTP/1.1` rather than the authority-form (`CONNECT host:port
   * HTTP/1.1`) a real proxy expects per RFC 7231 §4.3.6 — confirmed live against a real
   * proxy stub that a standard proxy would reject this. `ProxyAgent` simply doesn't
   * implement real `CONNECT`-tunnel semantics; nothing to configure around that.
   *
   * If the real target is `https:`, TLS is layered on top of the now-tunnelled plaintext
   * socket once the tunnel is up — exactly how real HTTPS-through-proxy works (the
   * `CONNECT` exchange itself is always plaintext to the proxy; the actual TLS handshake
   * happens through the tunnel, with the proxy never seeing inside it).
   *
   * @returns The usable socket (the plain tunnel, or the TLS socket layered on top of
   *   it), plus any bytes that arrived on the tunnel socket *after* the `CONNECT`
   *   response's own blank line in the same read — genuinely part of the real response,
   *   not the tunnel negotiation, and must not be discarded. Always empty when the
   *   target is `https:`, since those bytes would be pre-TLS-handshake ciphertext, not
   *   anything `readRawResponse` could use.
   */
  private static async connectThroughProxy(
    proxyUriString: string,
    targetProtocol: string,
    connectHost: string,
    port: number
  ): Promise<{ socket: Duplex; preSeeded: Buffer }> {
    // Parse the proxy's own URL to find where to connect for the CONNECT handshake itself —
    // distinct from connectHost/port, which is the real target behind the proxy.
    const proxyUrl = new URL(proxyUriString);
    const proxyConnectHost = proxyUrl.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : proxyUrl.protocol === 'https:' ? 443 : 80;

    Log.writeLine(LogLevels.TestDebug, `Proxy configured: [${proxyUriString}]`);
    // Connect to the proxy itself first — same connectDirect used for a non-proxied
    // request, just pointed at the proxy's own address.
    const tunnelSocket = await this.connectDirect(proxyUrl.protocol, proxyConnectHost, proxyPort);

    // Send the CONNECT request in authority-form (host:port, no scheme/path) — what a real
    // proxy actually expects per RFC 7231 §4.3.6.
    const targetAuthority = `${connectHost}:${port}`;
    tunnelSocket.write(`CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n\r\n`);

    // Wait for the proxy's CONNECT response to arrive and accumulate bytes until its header
    // block is complete, then check the status line for success.
    const preSeeded = await new Promise<Buffer>((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        const headerEnd = RawHttpResponseParser.findHeaderBlockEnd(buffered);
        // Header block not complete yet — keep buffering, nothing else to do on this event.
        if (headerEnd === null) return;
        // Header block is complete — stop listening, this is the only response we need.
        tunnelSocket.removeListener('data', onData);
        const statusLineEnd = buffered.indexOf('\r\n');
        const statusLine = buffered.subarray(0, statusLineEnd === -1 ? buffered.length : statusLineEnd).toString('latin1');
        // Anything other than a 200 means the proxy refused the tunnel — reject with the
        // proxy's own status line as the reason, rather than silently proceeding.
        if (!/^HTTP\/\d\.\d 200\b/.test(statusLine)) {
          reject(new Error(`Proxy CONNECT to [${targetAuthority}] failed: ${statusLine}`));
          return;
        }
        // Success — resolve with whatever bytes arrived *after* the CONNECT response's own
        // header block, since those already belong to the real (tunnelled) response, not
        // the tunnel negotiation itself.
        resolve(buffered.subarray(headerEnd));
      };
      tunnelSocket.on('data', onData);
      tunnelSocket.once('error', reject);
    });

    // Plain (non-TLS) target — the tunnel socket itself is the usable connection, along
    // with whatever response bytes were pre-seeded while negotiating it.
    if (targetProtocol !== 'https:') {
      return { socket: tunnelSocket, preSeeded };
    }

    // https target — layer TLS on top of the now-tunnelled plaintext socket; the CONNECT
    // exchange itself is always plaintext to the proxy, with the real handshake happening
    // through the tunnel where the proxy can't see inside it. No preSeeded bytes are
    // possible here — anything that arrived before this handshake completes would be
    // undecoded ciphertext, not usable response bytes.
    const tlsSocket = tls.connect({ socket: tunnelSocket as net.Socket, servername: connectHost, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      tlsSocket.once('secureConnect', () => resolve());
      tlsSocket.once('error', reject);
    });
    return { socket: tlsSocket, preSeeded: Buffer.alloc(0) };
  }

  /**
   * Reads a raw HTTP response until it's judged complete — framing-aware, not a blind
   * wait. See {@link performRawHTTPOperation}'s own doc comment for the full reasoning.
   *
   * @param preSeeded - Bytes already known to belong to this response before this method
   *   starts listening (see {@link connectThroughProxy}'s own doc comment for why that
   *   can happen) — accounted for exactly as if they'd arrived as the first `'data'`
   *   event, including an immediate completeness check in case the whole response (or
   *   more) was already sitting in them.
   */
  private static async readRawResponse(socket: Duplex, preSeeded: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let headerBlockEnd: number | null = null;
    let framing: { contentLength: number | null; transferEncodingChunked: boolean } | null = null;
    // Incremental chunked-body scan position — avoids re-scanning from the start of the
    // body on every single 'data' event, and (unlike a naive "does the buffer contain
    // 0\r\n\r\n anywhere" check) can't be fooled by chunk *data* that happens to contain
    // that exact byte sequence, since this only ever advances past bytes already
    // validated as real chunk framing.
    let chunkedScanOffset = -1;
    let chunkedComplete = false;

    return new Promise<Buffer>((resolve) => {
      let idleTimer: NodeJS.Timeout | undefined;
      // Shared completion path — cancels any pending idle timer and resolves with
      // everything accumulated so far, however complete or incomplete that turns out to be.
      const finish = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        resolve(Buffer.concat(chunks));
      };

      // Records a newly-arrived chunk and checks whether the response is now complete.
      // Returns true the instant completeness can be determined, false if the caller
      // should keep waiting (and fall back to the idle timer).
      const onChunk = (chunk: Buffer): boolean => {
        chunks.push(chunk);
        totalBytes += chunk.length;

        // Header block not yet located — check whether this chunk completed it. Once it
        // has, parse the framing headers (Content-Length/Transfer-Encoding) exactly once,
        // and if chunked, start the incremental scan right at the body's own first byte.
        if (headerBlockEnd === null) {
          const combined = Buffer.concat(chunks);
          const end = RawHttpResponseParser.findHeaderBlockEnd(combined);
          if (end !== null) {
            headerBlockEnd = end;
            framing = RawHttpResponseParser.parseFramingHeaders(combined.subarray(0, end));
            if (framing.transferEncodingChunked) chunkedScanOffset = end;
          }
        }

        // Header block (and therefore framing) is known — figure out, framing-aware,
        // whether enough of the body has now arrived to call the response complete.
        if (headerBlockEnd !== null && framing !== null) {
          if (framing.transferEncodingChunked) {
            // Walk forward from the last validated scan position, same chunk-header shape
            // decodeChunked itself parses (size line, optional ";extension", hex size) —
            // but only to detect the terminator, never to extract data here.
            const combined = Buffer.concat(chunks);
            let offset = chunkedScanOffset;
            while (!chunkedComplete) {
              const lineEndIdx = combined.indexOf('\r\n', offset);
              if (lineEndIdx === -1) break; // chunk-size line not fully arrived yet
              const sizeLine = combined.subarray(offset, lineEndIdx).toString('latin1').split(';')[0].trim();
              if (!/^[0-9a-fA-F]+$/.test(sizeLine)) { chunkedComplete = true; break; } // malformed -> parser handles it, stop waiting
              const size = parseInt(sizeLine, 16);
              const dataStart = lineEndIdx + 2;
              if (size === 0) { chunkedComplete = true; break; } // terminating chunk header seen
              const dataEnd = dataStart + size;
              if (dataEnd + 2 > combined.length) break; // this chunk's data hasn't fully arrived yet
              // This chunk's data (and its own trailing \r\n) are fully present — advance
              // past it and keep scanning for the next chunk header.
              offset = dataEnd + 2;
              chunkedScanOffset = offset;
            }
            if (chunkedComplete) return true;
          } else if (framing.contentLength !== null) {
            // Content-Length framing — complete the instant that many body bytes have
            // actually arrived.
            if (totalBytes - headerBlockEnd >= framing.contentLength) return true;
          }
          // Neither framing present (or Content-Length invalid) — no early-exit signal
          // available; caller falls back to the idle-timer, same as before the header
          // block was even known.
        }
        return false;
      };

      // Any bytes pre-seeded by a proxy tunnel negotiation are processed exactly like a
      // first 'data' event — including the chance that they alone already complete the
      // whole response.
      if (preSeeded.length > 0 && onChunk(preSeeded)) {
        finish();
        return;
      }

      // Normal path: on every chunk, check completeness; if not yet complete, (re)start
      // the idle-quiet fallback timer so a response with no usable framing signal still
      // eventually finishes once the server goes quiet.
      socket.on('data', (chunk: Buffer) => {
        if (onChunk(chunk)) { finish(); return; }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, RAW_RESPONSE_IDLE_MS);
      });
      // The server closing the connection is always a definitive end-of-response signal.
      socket.on('close', finish);
      socket.on('error', (err) => {
        // A connection error *while reading the response* (e.g. ECONNRESET) still ends
        // the response — resolve with whatever bytes arrived rather than discarding them.
        // Only a failure to *establish* the connection (in performRawHTTPOperation,
        // before this method is ever called) should actually throw.
        Log.writeLine(LogLevels.Error, `APIUtils.performRawHTTPOperation: connection error while reading response (returning partial bytes received so far): ${Utils.errorMessage(err)}`);
        finish();
      });
    });
  }

  /**
   * Builds the literal request-line + header-lines + body bytes to write to the socket.
   * See {@link performRawHTTPOperation}'s own doc comment for the `Host`/`Content-Length`
   * auto-injection rules this implements.
   */
  private static buildRawRequestBytes(
    method: string,
    pathWithQuery: string,
    headers: APIUtils.HTTPHeaders,
    host: string,
    body?: string | object | Buffer
  ): Buffer {
    // Normalise body into a single Buffer: no body -> empty; already a Buffer -> used
    // as-is (binary-safe); a string -> encoded verbatim; anything else (plain object) ->
    // JSON-stringified first.
    const bodyBuffer = Utils.isNullOrUndefined(body)
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');

    // Case-insensitive lookup — HTTP header names are case-insensitive, so "host" and
    // "Host" must be treated as the same header when deciding whether to auto-inject.
    const hasHeaderCaseInsensitive = (name: string): boolean =>
      Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

    const headerLines: string[] = [];
    // Auto-inject Host only if the caller didn't already supply one (in any case, any
    // value, including null — null suppresses this just as it does for any header below).
    if (!hasHeaderCaseInsensitive('Host')) {
      headerLines.push(`Host: ${host}`);
    }
    // Emit every caller-supplied header, in the order given — a null value omits that
    // header entirely; an array value produces one header line per element (true
    // duplicate headers, never comma-joined).
    for (const [key, value] of Object.entries(headers)) {
      if (Utils.isNull(value)) continue; // null = omit this header entirely (and suppresses auto-injection above/below)
      for (const singleValue of Array.isArray(value) ? value : [value]) {
        headerLines.push(`${key}: ${singleValue}`);
      }
    }
    // Auto-inject Content-Length only when there's an actual body and the caller didn't
    // already supply this header themselves.
    if (bodyBuffer.length > 0 && !hasHeaderCaseInsensitive('Content-Length')) {
      headerLines.push(`Content-Length: ${bodyBuffer.length}`);
    }

    // Assemble the request line + header lines + blank line terminator, then append the
    // raw body bytes after it.
    const head = `${method} ${pathWithQuery} HTTP/1.1\r\n${headerLines.map((line) => line + '\r\n').join('')}\r\n`;
    return Buffer.concat([Buffer.from(head, 'utf-8'), bodyBuffer]);
  }

  /**
   * Logs a request/response dump, at a tier chosen by `Log.loggingLevel` right now — never
   * more than one of the human-readable tiers below, by design, so a reader at any given
   * level never sees the same information twice:
   *
   * - `FrameworkDebug` (always, gated by `Log.writeLine`'s own ordinal check same as
   *   everywhere else): a compact, escaped dump — `\r\n` etc. rendered as literal
   *   two-character escapes via `Utils.safeStringify` (bounded to 512 chars) — a
   *   framework-internal trace of the exact bytes that crossed the wire. Orthogonal to the
   *   two tiers below — it's the one dump that's always byte-exact, never beautified,
   *   never simplified — so it's never suppressed in favour of either.
   * - Exactly `TestInformation` (`Log.loggingLevel === LogLevels.TestInformation`, not
   *   merely `>=`): {@link logSimplifiedRequestResponseDump}'s readable, beautified
   *   summary — heading with the method (request) or status line (response), then just
   *   the body, pretty-printed if it's good JSON/XML/YAML, otherwise shown verbatim
   *   (line-wrapped at 160 chars) — no raw headers at all.
   * - `TestDebug` or louder (`Log.loggingLevel >= LogLevels.TestDebug` — `TestDebug`,
   *   `FrameworkInformation`, or `FrameworkDebug`): the full raw dump — real newlines, the
   *   complete start-line/headers/body exactly as sent/received, nothing beautified. This
   *   is deliberately the exact behaviour `TestInformation` used to have before the
   *   simplified tier above existed.
   *
   * Picking one tier via an explicit `if`/`else if` on `Log.loggingLevel` — rather than
   * writing both at their own levels and letting `Log.writeLine`'s usual ordinal gate
   * decide what shows — is what actually guarantees the no-overlap property: ordinal
   * gating alone would show *both* the `TestInformation`-level and `TestDebug`-level
   * writes whenever `loggingLevel` is `TestDebug` or louder, which is exactly the
   * information-doubling this split exists to avoid.
   *
   * Called synchronously right after the request bytes are built (before the socket
   * write) and right after the response finishes arriving (before
   * {@link performRawHTTPOperation} returns) — so a reader sees "request sent" →
   * whatever activity the request caused downstream (e.g. an AUT's own calls to a mocked
   * backend) → "response received", in true chronological order.
   */
  private static logRawRequestResponseDump(
    direction: 'request' | 'response',
    bytes: Buffer,
    url: string,
    targetFriendlyName: string | undefined,
    options?: LoggingOptions
  ): void {

    // Caller may provide a stackOffset.  An Offset of 1 would mean the source in the logged line
    // shows as the caller line NOT logRawRequestResponseDump line. etc..  Default 0
    const stackOffset = options?.stackOffset ?? 0;


    const label = Utils.isNullOrUndefined(targetFriendlyName) ? '' : ` [${targetFriendlyName}]`;

    // Always write the compact FrameworkDebug trace — gated only by Log.writeLine's own
    // ordinal check, same as any other log call, never suppressed by the tier selection
    // below.
    Log.writeLine(LogLevels.FrameworkDebug, `RAW HTTP ${direction}${label} ${url} (${bytes.length} bytes):-`, { stackOffset: stackOffset });
    // latin1 maps each byte 1:1 to a code unit — an exact, lossless view of what was
    // actually sent/received, unlike a UTF-8 decode which would corrupt non-UTF-8 bytes.
    // Wrapped in safeStringify for the usual reasons: bounded length, and control/escape
    // characters (\r\n etc.) rendered visibly rather than interpreted by the terminal.
    Log.writeLine(LogLevels.FrameworkDebug, Utils.safeStringify(bytes.toString('latin1'), { maxLength: 256 }), { stackOffset: stackOffset });

    // Pick exactly one of the two human-readable tiers, never both: TestInformation gets
    // the simplified/beautified summary and returns immediately...
    if (Log.loggingLevel === LogLevels.TestInformation) {
      this.logSimplifiedRequestResponseDump(direction, bytes, url, label, { stackOffset: stackOffset + 1 });
      return;
    }
    // ...anything quieter than TestDebug gets neither tier at all...
    if (Log.loggingLevel < LogLevels.TestDebug) {
      return;
    }

    // ...and TestDebug or louder falls through to the full raw dump below.
    const heading = direction === 'request' ? `HTTP Request to${label} ${url}` : `HTTP Response from${label} ${url}`;
    try {
      // Trailing `\n` — the raw bytes end exactly at the request/response's own last byte,
      // with no blank line separating this dump from whatever log entry comes next, which
      // otherwise reads as if it ran straight into the body. Blank line added purely for
      // readability; not part of what was actually sent/received (the FrameworkDebug dump
      // above, with no added trailing newline, stays the byte-exact one).
      Log.writeLine(
        LogLevels.TestDebug,
        `${heading}:-\n${bytes.toString('latin1')}\n`,
        { maxLines: 2048, suppressMultilinePreamble: true, suppressSource: true }
      );
    } catch (err) {
      Log.writeLine(LogLevels.Error, `Failed to build ${direction} detail log (operation unaffected): ${Utils.errorMessage(err)}`);
    }
  }

  /**
   * The `TestInformation`-tier half of {@link logRawRequestResponseDump} — see that
   * method's own doc comment for why this is a separate, mutually-exclusive tier rather
   * than something layered on top of the full raw dump.
   *
   * `label` is passed in already-formatted (` [name]` or `''`) rather than recomputed,
   * since the caller already has it and both tiers need the identical value.
   *
   * Parses the start-line and body out of the raw bytes itself, rather than requiring
   * {@link performRawHTTPOperation}'s own structured request/response data to be threaded
   * through — this keeps the "what did we actually log" logic anchored to the same single
   * source of truth (the exact bytes) the other two tiers already use, and degrades
   * gracefully (falls back to showing the whole buffer as body text) if the bytes turn out
   * not to have a clean start-line/body split at all — this is a test framework; the
   * bytes it's asked to log are never guaranteed to be well-formed.
   */
  private static logSimplifiedRequestResponseDump(direction: 'request' | 'response', bytes: Buffer, url: string, label: string, options?: LoggingOptions): void {

    // Caller may provide a stackOffset.  An Offset of 1 would mean the source in the logged line
    // shows as the caller line NOT logRawRequestResponseDump line. etc..  Default 0
    const stackOffset = options?.stackOffset ?? 0;
    // Extract just the first line (request line or status line) as text — used below to
    // build the heading.
    const startLineEnd = bytes.indexOf('\r\n');
    const startLine = (startLineEnd === -1 ? bytes : bytes.subarray(0, startLineEnd)).toString('latin1');

    // UTF-8, not latin1 — unlike the byte-exact tiers above, this body is about to be read
    // as text (and possibly parsed as JSON/XML/YAML), so it needs real decoding, not a
    // 1:1 byte-to-code-unit mapping.
    //
    // 'response' bytes may still have raw chunked-transfer-encoding framing around the
    // body at this point (this dump runs before performRawHTTPOperation's own
    // RawHttpResponseParser.parse() call) — a naive "everything after the header block"
    // slice would show the literal chunk-size/terminator bytes, not the real body, so
    // this reuses that same never-throws parser instead of re-deriving the framing logic.
    // 'request' bytes never need this — buildRawRequestBytes only ever uses
    // Content-Length framing for what this package itself sends, never chunked.
    let bodyText: string;
    if (direction === 'response') {
      // Reuse the real never-throws parser to get the already-de-chunked body text,
      // rather than re-deriving the chunked-framing logic here.
      bodyText = RawHttpResponseParser.parse(bytes).body;
    } else {
      // Request bodies never use chunked framing (buildRawRequestBytes only ever sends
      // Content-Length) — a plain "everything after the header block" slice is sufficient.
      const headerBlockEnd = RawHttpResponseParser.findHeaderBlockEnd(bytes);
      bodyText = (headerBlockEnd === null ? bytes : bytes.subarray(headerBlockEnd)).toString('utf-8');
    }

    const lines: string[] = [];
    if (direction === 'request') {
      // Heading shows just the method, e.g. "HTTP GET Request to ...".
      const method = startLine.split(' ')[0] || '<unknown method>';
      lines.push(`HTTP ${method} Request to${label} ${url}:-`);
    } else {
      // Heading for a response additionally shows the status line's own code/reason text.
      lines.push(`HTTP Response from${label} ${url}:-`);
      // startLine is "HTTP/1.1 200 OK" — everything after the first space is "200 OK".
      const firstSpace = startLine.indexOf(' ');
      lines.push(firstSpace === -1 ? startLine : startLine.slice(firstSpace + 1));
    }

    // Append the formatted body, if there is one — an empty body produces no extra line.
    const formattedBody = this.formatBodyForDisplay(bodyText);
    if (formattedBody.length > 0) {
      lines.push(formattedBody);
    }

    try {
      Log.writeLine(
        LogLevels.TestInformation,
        `${lines.join('\n')}\n`,
        { maxLines: 2048, suppressMultilinePreamble: true, suppressSource: true }
      );
    } catch (err) {
      Log.writeLine(LogLevels.Error, `Failed to build ${direction} detail log (operation unaffected): ${Utils.errorMessage(err)}`, { stackOffset: stackOffset});
    }
  }

  /**
   * Formats a request/response body for the `TestInformation`-tier dump: pretty-printed
   * if it's good JSON, XML, or YAML — irrespective of whatever `Content-Type` the
   * request/response actually carried, this never looks at that header, only the body
   * text itself — otherwise shown verbatim (own line breaks preserved) but with every
   * line longer than 160 characters hard-wrapped.
   *
   * Order matters: JSON is checked first, then XML, then YAML last — JSON is a YAML 1.2
   * subset, so checking YAML first would misclassify every JSON body as YAML and
   * beautify it with the wrong formatter. "Good" means parses *and* (for JSON/YAML, which
   * can also validly parse to a bare scalar) produces a real object/array — see
   * {@link JsonUtils.isJson}/{@link YamlUtils.isYaml}'s own doc comments for why a bare
   * scalar doesn't count; {@link XmlUtils.isXml} has no equivalent bare-scalar case, every
   * well-formed XML document has exactly one root element by definition. YAML's own
   * grammar is inherently more permissive than JSON's or XML's even with that rule — a
   * plain-text body that happens to contain a `key: value`-shaped line can still parse to
   * a mapping — there is no fully reliable way to content-sniff "is this really YAML"; this
   * is the closest practical filter, not a guarantee.
   */
  private static formatBodyForDisplay(bodyText: string): string {
    if (bodyText.length === 0) return '';

    try {
      // Check JSON first, then XML, then YAML last — JSON is a YAML 1.2 subset, so
      // checking YAML first would misclassify every JSON body and beautify it wrong.
      if (JsonUtils.isJson(bodyText)) return JSON.stringify(JSON.parse(bodyText), null, 2);
      if (XmlUtils.isXml(bodyText)) return XmlUtils.serialize(XmlUtils.parse(bodyText), { pretty: true });
      if (YamlUtils.isYaml(bodyText)) return YamlUtils.stringify(YamlUtils.parse(bodyText));
    } catch {
      // isJson/isXml/isYaml already confirmed this would parse — reaching here means
      // something genuinely unexpected happened between that check and the parse call
      // itself. Never let a beautification failure take down the actual HTTP operation;
      // fall through to the verbatim/wrapped rendering below instead.
    }
    return APIUtils.wrapLongLines(bodyText, 160);
  }

  /**
   * Hard-wraps every line longer than `maxLineLength` into multiple lines of exactly that
   * length (the last chunk may be shorter) — a plain character-count wrap, not word-aware,
   * so every resulting line is *guaranteed* ≤ `maxLineLength`, not just usually. Existing
   * line breaks are preserved exactly as they are; this only ever adds new ones, never
   * removes or collapses any.
   */
  private static wrapLongLines(text: string, maxLineLength: number): string {
    return text
      .split('\n') // preserve existing line breaks — only process each one independently
      .map((line) => {
        // Short enough already — leave it untouched.
        if (line.length <= maxLineLength) return line;
        // Slice the line into fixed-length chunks (the final chunk may be shorter), then
        // rejoin them with newlines so every resulting line is guaranteed within the limit.
        const chunks: string[] = [];
        for (let i = 0; i < line.length; i += maxLineLength) {
          chunks.push(line.slice(i, i + maxLineLength));
        }
        return chunks.join('\n');
      })
      .join('\n');
  }

  /**
   * Builds a complete, well-formed URL from a protocol/host/resourcePath/queryString
   * combination — the same construction {@link performRawHTTPOperation} uses to know
   * where to actually connect. Strips any leading slashes from `resourcePath` and
   * resolves it against `protocol://host`, so a `resourcePath` without its own leading
   * `/` still produces a correctly separated path, and a `resourcePath` starting with
   * `//` can never be parsed as a network-path reference that silently replaces the host.
   *
   * @param urlParts - The protocol, host, resourcePath, and optional queryString to build
   *   the URL from — any `APIUtils.HTTPRequest` satisfies this directly.
   * @returns The fully resolved URL as a string, e.g. `"http://localhost:3899/asdf"`.
   */
  public static buildURL(
    urlParts: Pick<APIUtils.HTTPRequest, 'protocol' | 'host' | 'resourcePath' | 'queryString'>
  ): string {
    // Strip ALL leading slashes (not just one) before resolving as a relative reference.
    // A resourcePath starting with "//" would otherwise be parsed by URL as a network-path
    // reference (RFC 3986) — silently replacing the *host* rather than staying a literal
    // path. resourcePath is always meant to be a path fragment, never host-changing.
    const normalizedResourcePath = urlParts.resourcePath.replace(/^\/+/, '');
    // Resolve the stripped, always-relative path against the protocol+host origin. If
    // resourcePath itself already contains a "?..." (e.g. a test literally wrote
    // path '/users?foo=bar'), URL parsing already splits that into url.pathname/url.search
    // here — nothing further needed to recognise it.
    const url = new URL(normalizedResourcePath, `${urlParts.protocol}://${urlParts.host}`);
    // Combine (never silently override) whatever query string the path itself already
    // carried with the caller's own separate `queryString` — deliberately concatenated, not
    // one replacing the other, so a key appearing in both survives as a genuine duplicate
    // (see mergeQueryStrings) rather than one half being silently discarded. This is a test
    // framework; a tester combining both deliberately wants to see what the AUT does with
    // the result, not have the choice made for them.
    const pathQuery = url.search.startsWith('?') ? url.search.substring(1) : url.search;
    const merged = APIUtils.mergeQueryStrings(pathQuery, urlParts.queryString);
    url.search = merged ?? '';
    return url.toString();
  }

  /**
   * Builds a query-string from a {@link APIUtils.QueryParams} object — the object-shaped
   * counterpart to {@link mergeQueryStrings}'s plain-string merging, used to turn a
   * session-level/one-shot query-params override into the flat string {@link buildURL}
   * ultimately needs. Mirrors {@link buildRawRequestBytes}'s own header-array handling
   * exactly: a `string[]` value produces one `key=value` pair per entry (a genuine repeated
   * key, e.g. `tag=a&tag=b`, never comma-joined), and `null` omits that key entirely. Every
   * key and value is percent-encoded via `encodeURIComponent`.
   *
   * @param params - The query parameters to encode.
   * @returns The encoded query string, with no leading `?` (e.g. `"a=1&b=2"`), or `""` if
   *   `params` has no keys (after any `null`-omitted ones are excluded).
   */
  public static buildQueryString(params: APIUtils.QueryParams): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === null) continue; // null = omit this key entirely, same convention as headers
      for (const singleValue of Array.isArray(value) ? value : [value]) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(singleValue))}`);
      }
    }
    return parts.join('&');
  }

  /**
   * Concatenates any number of already-built query-string fragments into one, preserving
   * every key from every fragment — deliberately a plain join, never a per-key merge/
   * override: if the same key appears in more than one fragment, both survive as a genuine
   * duplicate in the result (e.g. combining `"a=1"` and `"a=2"` gives `"a=1&a=2"`, not
   * `"a=2"`) — same "don't silently resolve a duplicate on the caller's behalf" reasoning
   * as {@link APIUtils.assertPrimitiveValues}'s own `string[]` support.
   *
   * @param parts - Any number of query-string fragments (each with or without a leading
   *   `?` — stripped either way), `undefined`, or empty strings. Order is preserved.
   * @returns The joined query string, with no leading `?`, or `undefined` if every part
   *   was `undefined`/empty (i.e. there is nothing to append to a URL at all).
   */
  public static mergeQueryStrings(...parts: (string | undefined)[]): string | undefined {
    const nonEmpty = parts
      .filter((part): part is string => !Utils.isNullOrUndefined(part) && part !== '')
      .map((part) => (part.startsWith('?') ? part.substring(1) : part))
      .filter((part) => part !== '');
    return nonEmpty.length === 0 ? undefined : nonEmpty.join('&');
  }

  /**
   * Resolves a complete, ready-to-send HTTP request body from a literal (as a test author
   * wrote it) plus an optional set of path-based overrides — turns this package's four body
   * "kinds" into actual wire text. One-directional, for *building* an outgoing body only —
   * reading/comparing an already-received response body is a different operation
   * (extraction/comparison), not something this helps with.
   *
   * `modifications` values are applied as-is, via {@link JsonUtils.updateJSONObject}/
   * {@link XmlUtils.updateXMLDocument} — resolving a DataTable cell's own cast syntax
   * (`file:`/`number:`/etc.) is the caller's job, before building this array; a value arriving
   * here is assumed already fully resolved, and is never itself detokenised. `kind: 'yaml'`
   * reuses {@link JsonUtils.updateJSONObject} too, not a separate "YAMLPath" mechanism — YAML
   * parses down to the exact same plain-object/array/scalar tree JSON does, so the same
   * `JSON-Path`/`Value` convention applies unchanged.
   *
   * Any token embedded directly in `literalBody` is resolved via {@link Detokeniser.doAsync}
   * with `{ deEscape: false }` — this is an intermediate pass, not the final one. Escape
   * sequences are deliberately left intact for the final pass further downstream (at the
   * point the request actually gets sent) to resolve exactly once — see {@link Detokeniser}'s
   * own "Escaping" section for why that matters.
   *
   * @param kind - `'json'`/`'xml'`/`'yaml'` parse `literalBody`, apply `modifications`,
   *   detokenise, then serialise back to a string. `'text'` is detokenised and returned
   *   verbatim — never parsed or mutated, matching this package's "opaque text" convention.
   * @param literalBody - The literal body text, exactly as written in the step/test.
   * @param modifications - Path/value overrides to apply before serialising. Illegal for
   *   `kind: 'text'` — there's no structure to mutate against an opaque literal.
   * @param options - Optional settings (only meaningful for `kind: 'json'`):
   *   - `useJson5` — when `true`, `literalBody` is parsed using JSON5 rules (unquoted
   *     keys, single-quoted strings, trailing commas, comments) instead of strict JSON.
   *     Defaults to `false` (strict JSON). Safe to leave on for test-authored bodies: the
   *     result is always re-serialised via strict `JSON.stringify` below, so what actually
   *     goes out on the wire is unaffected either way — this only loosens what the test
   *     author is allowed to *type*, not what gets sent. No `kind: 'yaml'` equivalent —
   *     {@link YamlUtils.parse} is always strict; see its own doc comment for why.
   * @returns The final body text, ready to use as a plain string.
   * @throws {Error} If `literalBody` doesn't parse as the declared `kind`, if `modifications`
   *   is given for `kind: 'text'`, or if a `kind: 'xml'` modification's value isn't a string.
   *
   * @example
   * await APIUtils.resolveRequestHTTPBody('json', '{"name":"Bob"}', [{ path: '$.role', value: 'admin' }]);
   * await APIUtils.resolveRequestHTTPBody('json', '{name:"Bob"}', [], { useJson5: true }); // unquoted key
   * await APIUtils.resolveRequestHTTPBody('yaml', 'name: Bob\n', [{ path: '$.role', value: 'admin' }]);
   * await APIUtils.resolveRequestHTTPBody('text', 'plain text body');
   */
  public static async resolveRequestHTTPBody(
    kind: 'json' | 'xml' | 'yaml' | 'text',
    literalBody: string,
    modifications?: Array<APIUtils.RequestBodyModification>,
    options?: { useJson5?: boolean }
  ): Promise<string> {
    Utils.assertType(literalBody, "string", "APIUtils.resolveRequestHTTPBody", "literalBody");

    if (kind === 'text') {
      // Opaque text has no structure to apply path/value modifications against — reject
      // outright rather than silently ignoring them.
      if (modifications && modifications.length > 0) {
        const errText = `APIUtils.resolveRequestHTTPBody: [modifications] cannot be applied to kind 'text' — mutating opaque text is a contradiction. Either drop the modifications, or use kind 'json'/'xml'/'yaml' if the body really is structured.`;
        Log.logErrorAndThrow(errText);
      }
      // Detokenise and return verbatim — never parsed or mutated.
      return Detokeniser.doAsync(literalBody, { deEscape: false });
    }

    if (kind === 'json') {
      // Parse (optionally JSON5-lenient), apply every path/value override in order, then
      // detokenise each resulting string leaf before re-serialising to strict JSON text.
      let body: object;
      try {
        body = JsonUtils.parse(literalBody, options?.useJson5 ?? false) as object;
      } catch (err) {
        // JsonUtils.parse's own error is accurate but generic — it has no way to know this
        // particular parse is for a 'json body' request. The single most common reason this
        // throws here specifically is a test deliberately sending malformed content while
        // still declaring it 'json' — that always needs the opaque kind: 'text' instead,
        // since this kind always validates the literal as real JSON before anything is sent.
        Log.logErrorAndThrow(
          `APIUtils.resolveRequestHTTPBody: ${Utils.errorMessage(err)} — if this body is ` +
          `deliberately malformed (e.g. testing the AUT's own error handling), use kind ` +
          `'text' instead of 'json': 'json' always parses and validates the literal text as ` +
          `real JSON before it's ever sent.`
        );
      }
      for (const { path, value } of modifications ?? []) {
        body = JsonUtils.updateJSONObject(body, path, value);
      }
      body = (await APIUtils.detokeniseJsonLeaves(body)) as object;
      return JSON.stringify(body);
    }

    if (kind === 'yaml') {
      // Same shape as 'json' above — YAML parses to the identical plain-object/array/
      // scalar tree, so the same JSON-Path-based modification/detokenising logic applies
      // unchanged; only the final serialisation step differs.
      let body: object;
      try {
        body = YamlUtils.parse(literalBody) as object;
      } catch (err) {
        // Same reasoning as the 'json' branch above — see its own comment.
        Log.logErrorAndThrow(
          `APIUtils.resolveRequestHTTPBody: ${Utils.errorMessage(err)} — if this body is ` +
          `deliberately malformed (e.g. testing the AUT's own error handling), use kind ` +
          `'text' instead of 'yaml': 'yaml' always parses and validates the literal text as ` +
          `real YAML before it's ever sent.`
        );
      }
      for (const { path, value } of modifications ?? []) {
        body = JsonUtils.updateJSONObject(body, path, value);
      }
      body = (await APIUtils.detokeniseJsonLeaves(body)) as object;
      return YamlUtils.stringify(body);
    }

    // kind === 'xml'. Detokenised *before* parsing, not after serialising — XML text content
    // (unlike a JSON string value) has no quote-escaping convention to corrupt, so this is
    // safe, and it lets XmlUtils.parse validate the resolved text's well-formedness, rather
    // than splicing unescaped characters straight into already-serialised, already-valid output.
    const detokenisedLiteral = await Detokeniser.doAsync(literalBody, { deEscape: false });
    let doc: ReturnType<typeof XmlUtils.parse>;
    try {
      doc = XmlUtils.parse(detokenisedLiteral);
    } catch (err) {
      // Same reasoning as the 'json' branch above — see its own comment.
      Log.logErrorAndThrow(
        `APIUtils.resolveRequestHTTPBody: ${Utils.errorMessage(err)} — if this body is ` +
        `deliberately malformed (e.g. testing the AUT's own error handling), use kind ` +
        `'text' instead of 'xml': 'xml' always parses and validates the literal text as ` +
        `well-formed XML before it's ever sent.`
      );
    }
    // Apply each modification in order — XML content is always text, so a non-string
    // value is rejected rather than silently stringified.
    for (const { path, value } of modifications ?? []) {
      if (typeof value !== 'string') {
        const errText = `APIUtils.resolveRequestHTTPBody: [modifications] value for path [${path}] must be a string for kind 'xml' — received ${typeof value}. XML element/attribute content is always text.`;
        Log.logErrorAndThrow(errText);
      }
      doc = XmlUtils.updateXMLDocument(doc, path, value);
    }
    return XmlUtils.serialize(doc);
  }

  /**
   * Recursively detokenises every string leaf of a parsed JSON value, in place conceptually
   * (returns a new structure) — used by {@link APIUtils.resolveRequestHTTPBody} so a token
   * embedded in the base literal is resolved against the *already-parsed* leaf text, not the
   * raw JSON source (where a token's own quoted parameters, e.g.
   * `[[setting|processEnvName: "X"]]`, would still carry whatever escaping the outer JSON
   * string needed — parsing first is what correctly unescapes down to the token's real text).
   */
  private static async detokeniseJsonLeaves(value: unknown): Promise<unknown> {
    // String leaf — this is the actual base case: detokenise its text directly.
    if (typeof value === 'string') {
      return Detokeniser.doAsync(value, { deEscape: false });
    }
    // Array — recurse into every element, preserving order and index.
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => APIUtils.detokeniseJsonLeaves(item)));
    }
    // Plain object (not null, not an array, not a primitive) — recurse into every value,
    // keeping each key unchanged, then rebuild the object from the resolved entries.
    if (!Utils.isNullOrUndefined(value) && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, entryValue]) => [key, await APIUtils.detokeniseJsonLeaves(entryValue)] as const)
      );
      return Object.fromEntries(entries);
    }
    // Any other primitive (number, boolean, null, undefined) — nothing to detokenise,
    // return as-is.
    return value;
  }

  /**
   * Resolves a literal request body of the given kind to the final string a caller sends on
   * the wire, plus the `Content-Type` that body kind implies — thin convenience over
   * {@link resolveRequestHTTPBody}, which does the actual parse/mutate/detokenise/serialise
   * work. Runner-agnostic: `modifications` is already the plain, resolved shape
   * {@link resolveRequestHTTPBody} itself takes — however a caller got there (a Cucumber
   * DataTable's rows via {@link resolveRequestBodyModifications}, a Jest/Vitest test's own
   * array literal, anything else), this behaves identically.
   *
   * The returned `contentType` is this method's own explicit choice — not left to
   * {@link resolveRequestHTTPBody}'s/a caller's own JSON-sniffing fallback, even for `json`
   * (where the sniffed value would happen to be identical). `xml`/`yaml` bodies have no
   * sniffing equivalent at all, so without this they'd never get a `Content-Type` unless a
   * caller explicitly set one — this makes all three kinds behave the same way. `text` never
   * gets a `Content-Type` guess — `undefined`, the "opaque, no inference" convention.
   *
   * `json` bodies are parsed as JSON5, not just strict JSON (`{ useJson5: true }` passed to
   * {@link resolveRequestHTTPBody}) — this is routinely test-authored fixture text,
   * re-serialised via strict `JSON.stringify` before it ever reaches the wire regardless of
   * how leniently it was written, so there's nothing to lose by accepting unquoted keys/
   * single-quoted strings/trailing commas on the way in. `yaml` has no equivalent leniency
   * option — YAML parsing is always strict, see {@link YamlUtils.parse}'s own doc comment
   * for why.
   *
   * @param bodyKind - `'text'` (default, opaque) / `'json'` / `'xml'` / `'yaml'`.
   * @param literalBody - The body text as written/loaded, before any parsing.
   * @param modifications - Path/value overrides to apply after parsing — only meaningful for
   *   `'json'`/`'xml'`/`'yaml'` (mutating "opaque text" is a contradiction in terms).
   * @returns The final body string, plus the implied `Content-Type` (`undefined` for `text`).
   * @throws {Error} If `modifications` is given for a `'text'` (or default) body, or if
   *   `bodyKind` is anything other than the four recognised values.
   */
  public static async resolveLiteralRequestBody(
    bodyKind: 'json' | 'xml' | 'yaml' | 'text' | undefined,
    literalBody: string,
    modifications?: APIUtils.RequestBodyModification[]
  ): Promise<{ body: string; contentType: string | undefined }> {
    if ((bodyKind ?? 'text') === 'text') {
      if (!Utils.isUndefined(modifications)) {
        throw new Error(
          'APIUtils.resolveLiteralRequestBody: [modifications] can only be used with "json", "xml" or "yaml" body kind.'
        );
      }
      return { body: await APIUtils.resolveRequestHTTPBody('text', literalBody), contentType: undefined };
    }

    if (bodyKind === 'json') {
      const body = await APIUtils.resolveRequestHTTPBody('json', literalBody, modifications, { useJson5: true });
      return { body, contentType: APIUtils.APPLICATION_JSON };
    }

    if (bodyKind === 'xml') {
      const body = await APIUtils.resolveRequestHTTPBody('xml', literalBody, modifications);
      return { body, contentType: APIUtils.APPLICATION_XML };
    }

    if (bodyKind === 'yaml') {
      const body = await APIUtils.resolveRequestHTTPBody('yaml', literalBody, modifications);
      return { body, contentType: APIUtils.APPLICATION_YAML };
    }

    throw new Error('APIUtils.resolveLiteralRequestBody: [bodyKind] can only be text (default), xml, json or yaml');
  }

  /**
   * Loads a file's raw bytes for a `'bin'` request body — the binary counterpart to
   * {@link resolveLiteralRequestBody}, for genuinely binary content (an image, an archive,
   * deliberately malformed bytes) that could never be typed as Gherkin/test-literal text in
   * the first place. Only `filename` — the path itself — may carry a token, resolved exactly
   * the way {@link ValueExpression}'s own `file:` source verb resolves any other file path
   * (detokenise, then resolve against the configured test-data root); the loaded bytes
   * themselves are returned completely untouched — no detokenising, no trimming, no parsing —
   * since any of those would corrupt binary content that has no text grammar to apply them to.
   * `modifications`/DataTable overrides have no equivalent here either, for the same reason
   * `'text'` has none (see {@link resolveRequestHTTPBody}'s own `kind: 'text'` handling) —
   * opaque bytes have no structure to mutate.
   *
   * @param filename - The file path, relative to the configured test-data root (see
   *   {@link Utils.resolveTestDataPath}) — may itself contain a token.
   * @returns The file's raw bytes as a `Buffer`, plus the implied `Content-Type`
   *   (`'application/octet-stream'`, binary data's own IANA-registered default — RFC 2046
   *   §4.5.1 — same "imply one unless the caller already set a header" convention
   *   {@link resolveLiteralRequestBody}'s other three kinds already follow).
   * @throws {Error} If `filename` is not a non-empty string, or the resolved file cannot be read.
   */
  public static async resolveBinaryFileRequestBody(filename: string): Promise<{ body: Buffer; contentType: string }> {
    Utils.assertType(filename, "string", "APIUtils.resolveBinaryFileRequestBody", "filename");
    const detokenisedFilename = await Detokeniser.doAsync(filename);
    const resolvedPath = Utils.resolveTestDataPath(detokenisedFilename);
    const body = Utils.getFileContentsBuffer(resolvedPath);
    return { body, contentType: APIUtils.APPLICATION_OCTET_STREAM };
  }

  /**
   * Converts a list of raw path/value pairs into {@link APIUtils.RequestBodyModification}s —
   * each value resolved via {@link ValueExpression.parse} (JSON5-leniently: `{ useJson5: true }`),
   * so `file:`/`number:`/`boolean:`/`json:` casts all work from plain string input. Generic,
   * runner-agnostic shape: any caller that already has a `{ path, value }[]` list — however
   * it got there (a Cucumber DataTable's rows, a Jest/Vitest test's own array literal,
   * anything else) — gets identical resolution feeding into
   * {@link resolveLiteralRequestBody}/{@link resolveRequestHTTPBody}.
   *
   * @param rows - Raw path/value pairs, e.g. `{ path: '$.role', value: 'admin' }` or
   *   `{ path: '$.id', value: 'number:42' }`.
   * @returns The same pairs, each `value` resolved to its final cast type.
   */
  public static async resolveRequestBodyModifications(
    rows: { path: string; value: string }[]
  ): Promise<APIUtils.RequestBodyModification[]> {
    return Promise.all(
      rows.map(async (row) => ({
        path: row.path,
        value: (await ValueExpression.parse(row.value, { useJson5: true })) as string | object | boolean | number | null,
      }))
    );
  }

  /**
   * Asserts every value in `values` matches the {@link APIUtils.HTTPHeaders}/
   * {@link APIUtils.QueryParams} shape (the two share an identical value shape) — a
   * string/number/boolean/`null` primitive, or a `string[]` for a genuine multi-value entry
   * (e.g. sending `Set-Cookie`/`Accept-Language` as two or more separate header lines, or a
   * repeated query key like `?tag=a&tag=b` — never comma-joined; see
   * {@link buildRawRequestBytes}/{@link buildQueryString}'s own handling of array values).
   * Rejects anything else (a plain object, or an array containing a non-string element —
   * neither has any wire representation) with a clear error — always a caller mistake
   * (typically a `json:` cast producing one), never something to silently coerce or drop.
   *
   * @param values - The resolved headers or query params to validate.
   * @param context - Short description of what's being validated, prefixed onto the error
   *   message so a caller can tell which (e.g. `"header"`, `"query parameter"`).
   * @throws {Error} If any value in `values` is a non-`null` plain object, or an array
   *   containing an element that isn't itself a string.
   */
  public static assertPrimitiveValues(values: Record<string, unknown>, context: string): void {
    for (const [key, value] of Object.entries(values)) {
      if (Array.isArray(value)) {
        // string[] is a legitimate multi-value entry — one line/repeated-key per entry —
        // but every entry must itself be a string; an array of objects/numbers/etc has no
        // wire representation (buildRawRequestBytes/buildQueryString write each entry out
        // verbatim, as-is).
        const badIndex = value.findIndex((entry) => typeof entry !== 'string');
        if (badIndex !== -1) {
          const errText = `APIUtils.assertPrimitiveValues: ${context} [${key}][${badIndex}] resolved to a non-string array element — every entry of a multi-value ${context} must be a string. Resolved value: ${Utils.safeStringify(value)}`;
          Log.logErrorAndThrow(errText);
        }
        continue;
      }
      if (value !== null && typeof value === 'object') {
        const errText = `APIUtils.assertPrimitiveValues: ${context} [${key}] resolved to a non-primitive value — a ${context} value can never be a plain object. Resolved value: ${Utils.safeStringify(value)}`;
        Log.logErrorAndThrow(errText);
      }
    }
  }

}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace APIUtils {
  /**
   * Generic HTTP call Header items
   */
  export type HTTPHeaders = {
    [key: string]: string | string[] | number | boolean | null;
  };
  /**
   * Query-string parameters, keyed by name — identical value shape to {@link HTTPHeaders}
   * (a `string[]` value means "send this key more than once", e.g. `?tag=a&tag=b`; `null`
   * means "omit this key entirely"), just a distinct, semantically-named alias rather than
   * reusing `HTTPHeaders` directly at call sites that have nothing to do with headers.
   */
  export type QueryParams = HTTPHeaders;
  /**
   * Generic HTTP call Request envelope
   */
  export type HTTPRequest = {
    proxy?: string;
    method: string;
    protocol: 'http' | 'https';
    host: string;
    resourcePath: string;
    queryString?: string;
    headers: HTTPHeaders;
    /** A `Buffer` is sent as raw bytes (binary-safe); an `object` is JSON-serialised. */
    body?: string | object | Buffer;
    timeout?: number;
  };
  /**
   * Generic Http call methods
   */
  export enum HttpMethods {
    POST = 'POST',
    GET = 'GET',
    PUT = 'PUT',
  }
  export const APPLICATION_JSON = 'application/json';
  /** RFC 7303's current recommendation over the older, still-common `text/xml`. */
  export const APPLICATION_XML = 'application/xml';
  /** RFC 9512's registered type — the now-official choice over older de facto
   * conventions like `application/x-yaml`/`text/yaml`. */
  export const APPLICATION_YAML = 'application/yaml';
  /** RFC 2046 §4.5.1's registered default for arbitrary binary data. */
  export const APPLICATION_OCTET_STREAM = 'application/octet-stream';
  /**
   * Generic HTTP call Response envelope
   */
  export type HTTPResponse = {
    status: number;
    statusMessage: string;
    /** Repeated response headers are preserved as a `string[]`, not silently
     * comma-joined — see {@link APIUtils.performRawHTTPOperation}'s own doc comment for
     * why. Header names are lowercased, matching the convention `fetch`'s own `Headers`
     * and Node's `IncomingMessage.headers` already use. */
    headers: Record<string, string | string[]>;
    /** Best-effort UTF-8 decode of the response body — lossy for genuinely binary
     * responses (invalid byte sequences become U+FFFD). Use {@link bodyBuffer} for
     * byte-exact access. */
    body: string;
    /** Raw response body bytes, exactly as received — always populated, regardless
     * of content type. The byte-safe counterpart to {@link body}. */
    bodyBuffer: Buffer;
    /** The exact bytes written to the socket for this request — request line, headers,
     * and body — exactly as {@link APIUtils.performRawHTTPOperation} built and wrote
     * them itself, including the `Host`/`Content-Length` it auto-injects. */
    rawRequestBytes: Buffer;
    /** As {@link rawRequestBytes}, for the exact bytes received back — status line,
     * headers, and body, including real HTTP wire framing (chunked-encoding markers and
     * all) — not a reconstruction. */
    rawResponseBytes: Buffer;
  };

  export type HTTPInteraction = {
    request: HTTPRequest;
    response: HTTPResponse;
  };

  /**
   * A single path/value override for {@link APIUtils.resolveRequestHTTPBody} — e.g. a
   * DataTable row's `JSON-Path`/`XPath` and (already-resolved) `Value` columns, converted to
   * this plain, runner-agnostic shape by the caller.
   */
  export type RequestBodyModification = {
    path: string;
    value: string | object | boolean | number | null;
  };
}
