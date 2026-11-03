import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from "node:net";

import { Log, LogLevels, Utils } from "../index.js";
import { APIUtils } from "./APIUtils.js";

/**
 * A long-expiry self-signed localhost cert/key pair, generated once for this test file
 * (`openssl req -x509 -newkey rsa:2048 ... -subj "/CN=localhost"`) — exactly the shape of
 * cert a real test AUT would use, matching `buildDispatcher`'s own `rejectUnauthorized:
 * false` policy (test AUTs routinely use self-signed/internal-CA certs; validating
 * against a public CA isn't a meaningful threat model here).
 */
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUAuFubsBf/KsYakYxVQWr1ujhxBgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxMjIzMjE1NFoYDzIxMjYw
OTE4MjMyMTU0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDKHUKcAVeG77hRrLE+jqWPnwE2tgOHZMamzKhvi3Gx
EcEAMuwExNkz9tuiWtibsuSQvLW3KHwpBYEvwLZYd9+AJRfdlGvV2XyD6MmoULm6
VnnbY14KsjGDK4mYTcuzU5l/D3Yotfses2HEQra0WTTk7i/WXhocmKVKi1i4YW96
nx4LmGMuF9EIK+R75wfWhkfx//hEb0FBVJt1aNiNgIEXaFvBFI3UG4Mp18jO5M2z
TErIe56NJIPvc2KcOwlFd+fJBBNQ+6j+vBeZNNe0Sx0eLrivU9FeZW7eEjgWH1wV
4ztyAvm8tcV2EF2FB44wr7mpVaHTuAlk1Eh9fjrd25M1AgMBAAGjUzBRMB0GA1Ud
DgQWBBQFjoOzDulaujmgAbusc3lU4agiADAfBgNVHSMEGDAWgBQFjoOzDulaujmg
Abusc3lU4agiADAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB9
TYaIu7HkP3Tpw61oy90oYHFR6dVj5OdQkauE3B7tojgIT6whHLpSABYxn4Kdoox6
k+cz4fInFUYjPDcUf7iUnSJAGCZjGldl5pc2pFIRNFSd0Z4gqh1ODGwHK6oBV9cH
/9xwt0zjVQn2qs5czuaP+PTc3xr5gQb4ZgFAifFVjDzrkVSkbuVPbPvi1AFmiUhE
IVHJDKzX9X80KYbOMuLnGXFrwUOKBlKURtRDwBxYmILQnkb1tJKct+kwpQkR6zPv
g9tuKL5Y5PWfpFwUMlgxMsqV+AlsZHjtKuy8yPkCw2vIUORDtO+h8q9moKFCC0Oi
3ojod2wZIFncYCWbX32j
-----END CERTIFICATE-----`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKHUKcAVeG77hR
rLE+jqWPnwE2tgOHZMamzKhvi3GxEcEAMuwExNkz9tuiWtibsuSQvLW3KHwpBYEv
wLZYd9+AJRfdlGvV2XyD6MmoULm6VnnbY14KsjGDK4mYTcuzU5l/D3Yotfses2HE
Qra0WTTk7i/WXhocmKVKi1i4YW96nx4LmGMuF9EIK+R75wfWhkfx//hEb0FBVJt1
aNiNgIEXaFvBFI3UG4Mp18jO5M2zTErIe56NJIPvc2KcOwlFd+fJBBNQ+6j+vBeZ
NNe0Sx0eLrivU9FeZW7eEjgWH1wV4ztyAvm8tcV2EF2FB44wr7mpVaHTuAlk1Eh9
fjrd25M1AgMBAAECggEAAj4fRkpHHydhzP/OWuDyU8AL7DN9obvFVVLhofs5U7tC
s2HdRJN6mLadUUir+dS0vJAB5C2Xn+aAiUS2J6nzQCGPowgwLVTjqmlwc2Tet4Nm
IfN3g6urT2B+slxXbX7FlHQmqrHHC49dMlq0wRa/g4ExGEvXz+44FBx5UfJvoW8S
TSm8/NyFmeLYbYnLpG4ZKpuGSWyW1gZXcRfILe42FNex5b++7W55O2jpbDEcTVjw
1MvYwjBnGWx1Ld7ejMMEykk36FabOpvkYcn6E7NNFopkjcQ5QOL+JCp7Azi1wyiF
cRfCnUTzq2Lnc3wd4BcbxUbx34ADzeeKVlNY887ksQKBgQDxzph4FzjT1ofTpSGn
tw4ElIppiKYyRJSuNpltmZHYloAWfw2z9JvrFShhgXSjFtreeSuUHtxnW1FGEC29
Z0Y2GK8dSeWUzOq3c9b0nIqcGIVwJcSaECLRO9p8+0YA45bHltnHLVyehExS3nYi
HHmm7/GUFLJaStMqI4bgxnQoowKBgQDV+j1mp2DMMBNW1ExsS1qxg8yMJYKPVZx9
EyZGTTYwBKWvxK/fF1Sxm/T0SpMyMdTqblWwcCA66i+O6dEpW4ebi0t1Vr81R9AK
gKD2N19YqgiCxz5zvxs/lZtvT5x1t0SjKigskKCjBfteTFFLnm0KI7w4ibFwv9UZ
eFotC+laRwKBgAI/Ojl7dcK6Lp7v3OUzFUVDoBmk9G5pJryLs1dKYwmRNHWBDr6K
WlyP4MUvL8dIMhZ5J8eDlea7+YBeLB6jdAqSpiXuhtygHto/kFLLlZonvC2znCUW
W0x4cupQZ3EgrEkEhNeN+1tZvV/Tw2NDwnmjpyoKGzItmdK9a8Zw8aljAoGBAL3w
zxZTl7JJLrGR7HDpBw2ygB0bouSXSz0fhYc8PNCtH2KCRtfSvwSV+v/rPvR8lZKv
9HKVZZbGkQbceSWsMRkashXrtfmW0I6yFa/aAVIURU/Ji591UbvEkuBhG/LGhzAL
WPQOQfnUcokHV9a3P/WTOR464/7A2moskmeQPkk7AoGBAImFeTO3k4uB8Yv8EQP2
qwAqpQR3mhOCK4hhLpHCtvZwW4Xexz9h3NkTSPyLHhPAiFe5KI4gk3kBicdMxsKl
5f8t83zjWaeANmo5HEcDaCDd+q4jq9seN1lejAexWHq7Ln+oA378hGL6WlCvlAbF
mti1NAS1DD7zJ0xmI2JKaG6A
-----END PRIVATE KEY-----`;

/**
 * These tests deliberately run against real local servers/sockets, not mocks —
 * `performRawHTTPOperation` opens genuine `net`/`tls` connections, so a mocked `fetch`
 * (or anything else) proves nothing about the real behaviour this file exists to cover.
 */
async function startEchoServer(): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(201, { "Content-Type": "application/json", "X-Resp": "yes" });
      res.end(JSON.stringify({
        receivedBody: Buffer.concat(chunks).toString("utf-8"),
        receivedContentLength: req.headers["content-length"] ?? null,
        receivedHost: req.headers.host ?? null,
      }));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
  return { server, port };
}

/** As {@link startEchoServer}, but forces `Content-Length` response framing (not
 * chunked) via an explicit header — exercises the Content-Length decode path distinctly
 * from the chunked one `startEchoServer` already exercises. */
async function startContentLengthServer(): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer((_req, res) => {
    const body = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
  return { server, port };
}

/** A raw `net` server (not `http.createServer`, which always adds either
 * `Content-Length` or `Transfer-Encoding` itself) that writes a response with neither
 * framing header, then closes the connection to signal completion — exercises the
 * "connection close signals the end" fallback path. */
async function startConnectionCloseServer(): Promise<{ server: NetServer; port: number }> {
  const server = createNetServer((socket) => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nX-No-Framing: yes\r\n\r\nhello, no framing header at all");
      socket.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
  return { server, port };
}

/** A minimal CONNECT-tunnelling proxy stub — handles a literal `CONNECT host:port
 * HTTP/1.1` request line with `200 Connection Established`, then pipes bytes
 * bidirectionally to a real target. Exercises `performRawHTTPOperation`'s
 * `httpRequest.proxy` → `dispatcher.connect()` CONNECT-tunnel path end-to-end. */
async function startProxyStub(): Promise<{ server: NetServer; port: number }> {
  const server = createNetServer((clientSocket) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      clientSocket.removeListener("data", onData);

      const requestLine = buffered.subarray(0, buffered.indexOf("\r\n")).toString("latin1");
      const match = requestLine.match(/^CONNECT ([^:]+):(\d+) HTTP\/1\.1$/);
      if (!match) {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const targetSocket = netConnect({ host: match[1], port: Number(match[2]) }, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });
      targetSocket.on("error", () => clientSocket.destroy());
    };
    clientSocket.on("data", onData);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
  return { server, port };
}

describe("APIUtils.performRawHTTPOperation", () => {

  describe("request building", () => {

    it("sends the real request line, caller-supplied headers, and auto-injects Host/Content-Length", async () => {
      const { server, port } = await startEchoServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "POST",
          protocol: "http",
          host: `localhost:${port}`,
          resourcePath: "/my-body",
          headers: { "Content-Type": "application/json", "X-Custom": "abc" },
          body: { a: 1 },
        });

        const requestText = response.rawRequestBytes.toString("latin1");
        expect(requestText).toMatch(/^POST \/my-body HTTP\/1\.1\r\n/);
        expect(requestText).toContain("X-Custom: abc");
        expect(requestText).toContain("Content-Type: application/json");
        expect(requestText).toMatch(/Host: localhost:\d+/);
        expect(requestText).toContain("Content-Length: 7");
        // Deliberately NOT replicated — fetch/browser-emulation artifacts, not HTTP
        // requirements.
        expect(requestText).not.toContain("accept-encoding");
        expect(requestText).not.toContain("user-agent");
        expect(requestText.endsWith('{"a":1}')).toBe(true);
      } finally {
        server.close();
      }
    });

    it("does not auto-inject Content-Length when there's no body", async () => {
      const { server, port } = await startEchoServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {},
        });
        expect(response.rawRequestBytes.toString("latin1")).not.toContain("Content-Length");
      } finally {
        server.close();
      }
    });

    it("does not override a caller-supplied Host, including a deliberately wrong one", async () => {
      const { server, port } = await startEchoServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body",
          headers: { Host: "deliberately-wrong-host" },
        });
        const requestText = response.rawRequestBytes.toString("latin1");
        expect(requestText).toContain("Host: deliberately-wrong-host");
        expect(requestText.match(/^Host:/gim)?.length).toBe(1);
      } finally {
        server.close();
      }
    });

    it("omits Host entirely when the caller explicitly sets it to null — never silently re-added", async () => {
      const { server, port } = await startEchoServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body",
          headers: { Host: null },
        });
        expect(response.rawRequestBytes.toString("latin1")).not.toMatch(/^Host:/im);
      } finally {
        server.close();
      }
    });

    it("sends a deliberately wrong Content-Length through unmodified — the AUT genuinely reacts to it", async () => {
      const { server, port } = await startEchoServer();
      try {
        // Deliberately smaller than the real body. The genuinely-reached, real
        // consequence (confirmed live against Node's own http server, a stand-in for any
        // real AUT) is a 400 — it reads exactly 2 bytes as this request's body, then
        // tries to parse the 3 leftover bytes ("ort") as the start of a new pipelined
        // request, which is garbage. That 400 *is* the proof the wrong value reached the
        // AUT and had a real, observable effect — not a bug in this test or in
        // performRawHTTPOperation.
        const response = await APIUtils.performRawHTTPOperation({
          method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body",
          headers: { "Content-Length": "2" }, body: "short",
        });
        expect(response.rawRequestBytes.toString("latin1")).toContain("Content-Length: 2");
        expect(response.status).toBe(400);
      } finally {
        server.close();
      }
    });

    it("preserves duplicate same-named headers as separate wire lines, not comma-joined", async () => {
      const { server, port } = await startEchoServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body",
          headers: { Authorization: ["first-token", "second-token"] },
        });
        const requestText = response.rawRequestBytes.toString("latin1");
        expect(requestText).toContain("Authorization: first-token");
        expect(requestText).toContain("Authorization: second-token");
        expect(requestText.match(/^Authorization:/gim)?.length).toBe(2);
      } finally {
        server.close();
      }
    });

    it("captures independently across two sequential calls", async () => {
      const { server, port } = await startEchoServer();
      try {
        const first = await APIUtils.performRawHTTPOperation({
          method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "first",
        });
        const second = await APIUtils.performRawHTTPOperation({
          method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "second",
        });
        expect(first.rawRequestBytes.toString("latin1").endsWith("first")).toBe(true);
        expect(second.rawRequestBytes.toString("latin1").endsWith("second")).toBe(true);
      } finally {
        server.close();
      }
    });
  });

  describe("response parsing — real wire framing, end to end", () => {

    it("decodes a chunked response, with the real chunk framing visible in rawResponseBytes", async () => {
      const { server, port } = await startEchoServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello",
        });
        expect(response.status).toBe(201);
        expect(response.headers["x-resp"]).toBe("yes");
        const parsedBody = JSON.parse(response.body) as { receivedBody: string };
        expect(parsedBody.receivedBody).toBe("hello");

        const responseText = response.rawResponseBytes.toString("latin1");
        expect(responseText).toMatch(/^HTTP\/1\.1 201 Created\r\n/);
        expect(responseText).toContain("Transfer-Encoding: chunked");
        // Real chunk-size/terminator framing genuinely present in the raw bytes, not a
        // reconstruction from the decoded body.
        expect(responseText).toMatch(/\r\n[0-9a-f]+\r\n.*\r\n0\r\n\r\n$/s);
      } finally {
        server.close();
      }
    });

    it("decodes a Content-Length-framed response", async () => {
      const { server, port } = await startContentLengthServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/x", headers: {},
        });
        expect(response.status).toBe(200);
        expect(response.body).toBe('{"ok":true}');
        expect(response.rawResponseBytes.toString("latin1")).toContain("Content-Length: 11");
      } finally {
        server.close();
      }
    });

    it("decodes a response with neither framing header, terminated by connection close", async () => {
      const { server, port } = await startConnectionCloseServer();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/x", headers: {},
        });
        expect(response.status).toBe(200);
        expect(response.body).toBe("hello, no framing header at all");
      } finally {
        server.close();
      }
    });
  });

  describe("HTTPS", () => {

    it("completes a request against a self-signed-cert HTTPS server", async () => {
      const server: HttpsServer = createHttpsServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("secure ok");
      });
      const port = await new Promise<number>((resolve) => {
        server.listen(0, () => resolve((server.address() as { port: number }).port));
      });
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "https", host: `localhost:${port}`, resourcePath: "/x", headers: {},
        });
        expect(response.status).toBe(200);
        expect(response.body).toBe("secure ok");
      } finally {
        server.close();
      }
    });
  });

  describe("proxy", () => {

    it("completes a request through a CONNECT-tunnelling proxy", async () => {
      const { server: target, port: targetPort } = await startEchoServer();
      const { server: proxy, port: proxyPort } = await startProxyStub();
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET",
          protocol: "http",
          host: `localhost:${targetPort}`,
          resourcePath: "/my-body",
          headers: {},
          proxy: `http://localhost:${proxyPort}`,
        });
        expect(response.status).toBe(201);
      } finally {
        target.close();
        proxy.close();
      }
    });
  });

  describe("IPv6", () => {

    it("connects to an IPv6 literal address — bracket-stripping fix", async () => {
      const server = createHttpServer((_req, res) => res.end("ipv6 ok"));
      const port = await new Promise<number>((resolve) => {
        server.listen(0, "::1", () => resolve((server.address() as { port: number }).port));
      });
      try {
        const response = await APIUtils.performRawHTTPOperation({
          method: "GET", protocol: "http", host: `[::1]:${port}`, resourcePath: "/x", headers: {},
        });
        expect(response.status).toBe(200);
        expect(response.body).toBe("ipv6 ok");
        expect(response.rawRequestBytes.toString("latin1")).toContain(`Host: [::1]:${port}`);
      } finally {
        server.close();
      }
    });
  });

  describe("request/response detail logging (logRawRequestResponseDump)", () => {

    const originalLoggingLevel = Log.loggingLevel;

    afterEach(() => {
      vi.restoreAllMocks();
      Log.loggingLevel = originalLoggingLevel;
    });

    // ─── TestDebug tier (and louder) — the full raw dump ───────────────────────────────
    //
    // Exactly the behaviour `TestInformation` used to have before the simplified tier
    // below existed — see logRawRequestResponseDump's own doc comment.
    describe("TestDebug tier (and louder) — full raw dump, unbeautified", () => {

      beforeEach(() => {
        Log.loggingLevel = LogLevels.TestDebug;
      });

      it("logs a readable dump for the request, with the target's friendly name and no call-site source", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Request to"));
          expect(call).toBeDefined();
          const [level, message, options] = call as [number, string, { maxLines?: number; suppressMultilinePreamble?: boolean; suppressSource?: boolean }];
          expect(level).toBe(LogLevels.TestDebug);
          expect(message).toContain(`HTTP Request to [My App] http://localhost:${port}/my-body:-`);
          expect(message).toContain("POST /my-body HTTP/1.1");
          expect(message.endsWith("hello\n")).toBe(true);
          expect(options).toEqual(expect.objectContaining({ maxLines: 2048, suppressMultilinePreamble: true, suppressSource: true }));
        } finally {
          server.close();
        }
      });

      it("logs a readable dump for the response, with the target's friendly name", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {} },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Response from"));
          expect(call).toBeDefined();
          const [level, message] = call as [number, string];
          expect(level).toBe(LogLevels.TestDebug);
          expect(message).toContain(`HTTP Response from [My App] http://localhost:${port}/my-body:-`);
          expect(message).toContain("HTTP/1.1 201");
        } finally {
          server.close();
        }
      });

      it("ends the dump with a trailing blank line, so whatever log entry follows doesn't run straight into the body", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const requestCall = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Request to"));
          const responseCall = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Response from"));
          expect((requestCall?.[1] as string).endsWith("\n")).toBe(true);
          expect((responseCall?.[1] as string).endsWith("\n")).toBe(true);
        } finally {
          server.close();
        }
      });

      it("omits the name label entirely when no targetFriendlyName is given", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation({
            method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {},
          });

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Request to"));
          expect(call).toBeDefined();
          const [, message] = call as [number, string];
          expect(message).toContain(`HTTP Request to http://localhost:${port}/my-body:-`);
          expect(message).not.toContain("(");
        } finally {
          server.close();
        }
      });

      it("logs the request dump before the request is even written — the AUT's own activity in between lands between the two dumps, not after both", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        // A server that logs its own line (via the same real Log.writeLine) the moment it
        // receives the request, before responding — standing in for an AUT's own activity
        // (e.g. its own calls to a mocked backend) that a reader should see happen strictly
        // between the "sent" and "received" dumps, not after both.
        const server = createHttpServer((_req, res) => {
          Log.writeLine(LogLevels.TestInformation, "AUT-SIDE ACTIVITY");
          res.end("done");
        });
        const port = await new Promise<number>((resolve) => {
          server.listen(0, () => resolve((server.address() as { port: number }).port));
        });
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/x", headers: {} },
            { targetFriendlyName: "My App" }
          );

          const order = writeLineSpy.mock.calls
            .map(([, message]) => message as string)
            .filter((message) =>
              message.startsWith("HTTP Request to") ||
              message === "AUT-SIDE ACTIVITY" ||
              message.startsWith("HTTP Response from")
            );
          expect(order).toHaveLength(3);
          expect(order[0]).toMatch(/^HTTP Request to/);
          expect(order[1]).toBe("AUT-SIDE ACTIVITY");
          expect(order[2]).toMatch(/^HTTP Response from/);
        } finally {
          server.close();
        }
      });
    });

    // ─── FrameworkDebug — the compact escaped dump, independent of the tier above ──────
    it("logs the compact escaped dump at FrameworkDebug, not FrameworkInformation — no duplication at a louder-than-necessary tier", async () => {
      Log.loggingLevel = LogLevels.FrameworkDebug;
      const writeLineSpy = vi.spyOn(Log, "writeLine");
      const { server, port } = await startEchoServer();
      try {
        await APIUtils.performRawHTTPOperation(
          { method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {} },
          { targetFriendlyName: "My App" }
        );

        const compactCall = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("RAW HTTP request"));
        expect(compactCall).toBeDefined();
        const [level, message] = compactCall as [number, string];
        expect(level).toBe(LogLevels.FrameworkDebug);
        expect(message).toMatch(new RegExp(`^RAW HTTP request \\[My App\\] http://localhost:${port}/my-body \\(\\d+ bytes\\):-$`));
        expect(writeLineSpy.mock.calls.some(([lvl, msg]) => lvl === LogLevels.FrameworkInformation && (msg as string).startsWith("RAW HTTP"))).toBe(false);
      } finally {
        server.close();
      }
    });

    // ─── TestInformation tier — simplified, beautified dump ────────────────────────────
    describe("TestInformation tier — simplified, beautified dump", () => {

      beforeEach(() => {
        Log.loggingLevel = LogLevels.TestInformation;
      });

      it("heading includes the HTTP method for a request; body only, no raw headers", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP"));
          expect(call).toBeDefined();
          const [level, message] = call as [number, string];
          expect(level).toBe(LogLevels.TestInformation);
          expect(message).toBe(`HTTP POST Request to [My App] http://localhost:${port}/my-body:-\nhello\n`);
        } finally {
          server.close();
        }
      });

      it("omits the name label entirely when no targetFriendlyName is given — everything else unchanged", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" }
          );

          const requestCall = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP GET"));
          const responseCall = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Response"));
          expect((requestCall?.[1] as string)).toBe(`HTTP GET Request to http://localhost:${port}/my-body:-\nhello\n`);
          expect((responseCall?.[1] as string)).toMatch(new RegExp(`^HTTP Response from http://localhost:${port}/my-body:-\\n201 Created\\n`));
        } finally {
          server.close();
        }
      });

      it("heading for a response stays method-free; status line + statusText on their own line, then the body", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hi" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP Response"));
          expect(call).toBeDefined();
          const [, message] = call as [number, string];
          expect(message.startsWith(`HTTP Response from [My App] http://localhost:${port}/my-body:-\n201 Created\n`)).toBe(true);
          // startEchoServer's response body is JSON — beautified, so the raw compact form
          // ({"receivedBody":"hi",...}) must not appear verbatim.
          expect(message).not.toContain('{"receivedBody"');
          expect(message).toContain('"receivedBody": "hi"');
        } finally {
          server.close();
        }
      });

      it("omits the body line entirely when there is no body", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "GET", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {} },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP GET Request"));
          const [, message] = call as [number, string];
          expect(message).toBe(`HTTP GET Request to [My App] http://localhost:${port}/my-body:-\n`);
        } finally {
          server.close();
        }
      });

      it("beautifies a good JSON object body", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: '{"a":1,"b":{"c":2}}' },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          expect(message).toContain(JSON.stringify(JSON.parse('{"a":1,"b":{"c":2}}'), null, 2));
        } finally {
          server.close();
        }
      });

      it("does not beautify a bare JSON scalar body — not a real object/array", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "42" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          expect(message).toBe(`HTTP POST Request to [My App] http://localhost:${port}/my-body:-\n42\n`);
        } finally {
          server.close();
        }
      });

      it("beautifies a good XML body", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "<a><b>1</b></a>" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          expect(message).toContain("<a>\n  <b>1</b>\n</a>");
        } finally {
          server.close();
        }
      });

      it("beautifies a good YAML mapping body", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "a: 1\nb: 2" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          expect(message).toBe(`HTTP POST Request to [My App] http://localhost:${port}/my-body:-\na: 1\nb: 2\n\n`);
        } finally {
          server.close();
        }
      });

      it("does not beautify a bare YAML scalar body — not a real object/array (irrespective of Content-Type)", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: { "Content-Type": "application/yaml" }, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          expect(message).toBe(`HTTP POST Request to [My App] http://localhost:${port}/my-body:-\nhello\n`);
        } finally {
          server.close();
        }
      });

      it("shows a non-structured body verbatim, preserving its own line breaks", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "line one\nline two\nline three" },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          expect(message).toBe(`HTTP POST Request to [My App] http://localhost:${port}/my-body:-\nline one\nline two\nline three\n`);
        } finally {
          server.close();
        }
      });

      it("hard-wraps a non-structured body's line at exactly 160 characters, leaving shorter lines untouched", async () => {
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        const longLine = "x".repeat(250);
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: `short\n${longLine}` },
            { targetFriendlyName: "My App" }
          );

          const call = writeLineSpy.mock.calls.find(([, message]) => (message as string).startsWith("HTTP POST Request"));
          const [, message] = call as [number, string];
          const expectedWrapped = `${longLine.slice(0, 160)}\n${longLine.slice(160)}`;
          expect(message).toBe(`HTTP POST Request to [My App] http://localhost:${port}/my-body:-\nshort\n${expectedWrapped}\n`);
          for (const line of message.split("\n")) {
            expect(line.length).toBeLessThanOrEqual(160);
          }
        } finally {
          server.close();
        }
      });
    });

    // ─── Tier exclusivity — never both at once ─────────────────────────────────────────
    describe("tier exclusivity — TestInformation and TestDebug never both fire", () => {

      it("at TestInformation, only the simplified dump is written — no raw-header full dump alongside it", async () => {
        Log.loggingLevel = LogLevels.TestInformation;
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const humanReadableCalls = writeLineSpy.mock.calls.filter(
            ([, message]) => (message as string).startsWith("HTTP ") || (message as string).startsWith("HTTP Response")
          );
          expect(humanReadableCalls).toHaveLength(2); // exactly one request dump, one response dump
          expect(humanReadableCalls.every(([lvl]) => lvl === LogLevels.TestInformation)).toBe(true);
          expect(humanReadableCalls.some(([, msg]) => (msg as string).includes("HTTP/1.1"))).toBe(false);
        } finally {
          server.close();
        }
      });

      it("at TestDebug, only the full raw dump is written — no simplified/beautified dump alongside it", async () => {
        Log.loggingLevel = LogLevels.TestDebug;
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const humanReadableCalls = writeLineSpy.mock.calls.filter(
            ([, message]) => (message as string).startsWith("HTTP Request to") || (message as string).startsWith("HTTP Response from")
          );
          expect(humanReadableCalls).toHaveLength(2);
          expect(humanReadableCalls.every(([lvl]) => lvl === LogLevels.TestDebug)).toBe(true);
          // The TestDebug-tier dump always includes the raw start-line verbatim.
          expect(humanReadableCalls.some(([, msg]) => (msg as string).includes("POST /my-body HTTP/1.1"))).toBe(true);
        } finally {
          server.close();
        }
      });

      it("below TestInformation (e.g. Warning), neither tier writes anything", async () => {
        Log.loggingLevel = LogLevels.Warning;
        const writeLineSpy = vi.spyOn(Log, "writeLine");
        const { server, port } = await startEchoServer();
        try {
          await APIUtils.performRawHTTPOperation(
            { method: "POST", protocol: "http", host: `localhost:${port}`, resourcePath: "/my-body", headers: {}, body: "hello" },
            { targetFriendlyName: "My App" }
          );

          const humanReadableCalls = writeLineSpy.mock.calls.filter(
            ([, message]) => (message as string).startsWith("HTTP Request") || (message as string).startsWith("HTTP Response")
          );
          expect(humanReadableCalls).toHaveLength(0);
        } finally {
          server.close();
        }
      });
    });
  });
});

describe("APIUtils.resolveRequestHTTPBody", () => {

  describe("kind: 'json'", () => {

    it("parses strict JSON and re-serialises it, useJson5 omitted (defaults to strict)", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("json", '{"a":1}')).resolves.toBe('{"a":1}');
    });

    it("rejects JSON5-only syntax (unquoted key) when useJson5 is omitted", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("json", "{a:1}")).rejects.toThrow();
    });

    it("useJson5: true accepts unquoted keys/single-quoted strings/trailing commas", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("json", "{a:1,b:'x',}", undefined, { useJson5: true }))
        .resolves.toBe('{"a":1,"b":"x"}');
    });

    it("useJson5: true still re-serialises to strict JSON on the wire — leniency only affects what can be typed in, never what goes out", async () => {
      const result = await APIUtils.resolveRequestHTTPBody("json", "{a:1}", undefined, { useJson5: true });
      expect(() => JSON.parse(result)).not.toThrow();
      expect(result).toBe('{"a":1}');
    });

    it("useJson5: true still applies modifications correctly on top of the leniently-parsed body", async () => {
      await expect(
        APIUtils.resolveRequestHTTPBody("json", "{a:1}", [{ path: "$.b", value: "added" }], { useJson5: true })
      ).resolves.toBe('{"a":1,"b":"added"}');
    });

    it("useJson5: true still throws on genuinely malformed input", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("json", "{not valid", undefined, { useJson5: true })).rejects.toThrow();
    });

    it("a malformed-JSON throw hints at using kind 'text' for deliberately-broken bodies", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("json", "{not valid", undefined, { useJson5: true }))
        .rejects.toThrow(/use kind 'text' instead of 'json'/);
    });
  });

  describe("kind: 'yaml'", () => {

    it("parses YAML and re-serialises it", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("yaml", "a: 1\n")).resolves.toBe("a: 1\n");
    });

    it("applies modifications via the same JSON-Path/Value convention as kind: 'json'", async () => {
      await expect(
        APIUtils.resolveRequestHTTPBody("yaml", "a: 1\n", [{ path: "$.b", value: "added" }])
      ).resolves.toBe("a: 1\nb: added\n");
    });

    it("always rejects malformed YAML — no useJson5-equivalent leniency option", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("yaml", "a: [1, 2")).rejects.toThrow();
    });

    it("a malformed-YAML throw hints at using kind 'text' for deliberately-broken bodies", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("yaml", "a: [1, 2"))
        .rejects.toThrow(/use kind 'text' instead of 'yaml'/);
    });
  });

  describe("kind: 'xml'", () => {

    it("parses XML and re-serialises it", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("xml", "<a>1</a>")).resolves.toBe("<a>1</a>");
    });

    it("applies modifications via JSONPath-equivalent XPath/Value overrides", async () => {
      await expect(
        APIUtils.resolveRequestHTTPBody("xml", "<a><b>1</b></a>", [{ path: "/a/b", value: "2" }])
      ).resolves.toBe("<a><b>2</b></a>");
    });

    it("a malformed-XML throw hints at using kind 'text' for deliberately-broken bodies", async () => {
      await expect(APIUtils.resolveRequestHTTPBody("xml", "<a><b>1</a>"))
        .rejects.toThrow(/use kind 'text' instead of 'xml'/);
    });
  });
});

describe("APIUtils.resolveLiteralRequestBody", () => {
  it("text (default) body kind passes the literal through, no Content-Type", async () => {
    await expect(APIUtils.resolveLiteralRequestBody(undefined, "plain text")).resolves.toEqual({
      body: "plain text",
      contentType: undefined,
    });
    await expect(APIUtils.resolveLiteralRequestBody("text", "plain text")).resolves.toEqual({
      body: "plain text",
      contentType: undefined,
    });
  });

  it("text body kind rejects modifications — opaque text can't be mutated", async () => {
    await expect(
      APIUtils.resolveLiteralRequestBody("text", "plain text", [{ path: "$.a", value: "1" }])
    ).rejects.toThrow(/modifications.*can only be used with "json", "xml" or "yaml"/);
  });

  it("json body kind parses JSON5, applies modifications, and reports APPLICATION_JSON", async () => {
    const result = await APIUtils.resolveLiteralRequestBody("json", "{a:1,}", [{ path: "$.b", value: "added" }]);
    expect(JSON.parse(result.body)).toEqual({ a: 1, b: "added" });
    expect(result.contentType).toBe(APIUtils.APPLICATION_JSON);
  });

  it("xml body kind applies modifications and reports APPLICATION_XML", async () => {
    const result = await APIUtils.resolveLiteralRequestBody("xml", "<a>1</a>");
    expect(result.body).toContain("<a>1</a>");
    expect(result.contentType).toBe(APIUtils.APPLICATION_XML);
  });

  it("yaml body kind applies modifications and reports APPLICATION_YAML", async () => {
    const result = await APIUtils.resolveLiteralRequestBody("yaml", "a: 1\n", [{ path: "$.b", value: "added" }]);
    expect(result.body).toBe("a: 1\nb: added\n");
    expect(result.contentType).toBe(APIUtils.APPLICATION_YAML);
  });

  it("rejects an unrecognised body kind", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(APIUtils.resolveLiteralRequestBody("bogus" as any, "x")).rejects.toThrow(
      /bodyKind.*can only be text \(default\), xml, json or yaml/
    );
  });
});

describe("APIUtils.resolveBinaryFileRequestBody", () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(Utils, "resolveTestDataPath").mockImplementation((relativePath) => `/resolved/${relativePath}`);
  });

  it("loads the file's raw bytes untouched and reports APPLICATION_OCTET_STREAM", async () => {
    const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG-style magic bytes
    vi.spyOn(Utils, "getFileContentsBuffer").mockReturnValue(fileBytes);

    const result = await APIUtils.resolveBinaryFileRequestBody("image.png");

    expect(Utils.resolveTestDataPath).toHaveBeenCalledWith("image.png");
    expect(Utils.getFileContentsBuffer).toHaveBeenCalledWith("/resolved/image.png");
    expect(result.body).toBe(fileBytes); // same Buffer instance — never copied/re-encoded
    expect(result.contentType).toBe(APIUtils.APPLICATION_OCTET_STREAM);
  });

  it("never trims or decodes the loaded bytes — unlike the text-based file: source", async () => {
    // Bytes that would be mangled by a trim() (leading/trailing whitespace bytes are
    // genuine file content here, not incidental formatting) or a lossy UTF-8 decode
    // (0xFF is not valid UTF-8 on its own).
    const fileBytes = Buffer.from([0x20, 0xff, 0x0a, 0x20]);
    vi.spyOn(Utils, "getFileContentsBuffer").mockReturnValue(fileBytes);

    const result = await APIUtils.resolveBinaryFileRequestBody("raw.bin");

    expect(result.body).toEqual(fileBytes);
    expect(result.body.length).toBe(4);
  });

  it("resolves a token in the filename itself before resolving the path", async () => {
    vi.spyOn(Utils, "getFileContentsBuffer").mockReturnValue(Buffer.from("x"));
    await APIUtils.resolveBinaryFileRequestBody(
      '[[setting|processEnvName: "API_UTILS_SPEC_DEFINITELY_NOT_SET_XYZ", defaultValue: "resolved-name.bin"]]'
    );
    expect(Utils.resolveTestDataPath).toHaveBeenCalledWith("resolved-name.bin");
  });
});

describe("APIUtils.resolveRequestBodyModifications", () => {
  it("resolves plain string values as-is", async () => {
    await expect(APIUtils.resolveRequestBodyModifications([{ path: "$.a", value: "hello" }])).resolves.toEqual([
      { path: "$.a", value: "hello" },
    ]);
  });

  it("resolves cast-prefixed values via ValueExpression (number/boolean/json)", async () => {
    await expect(
      APIUtils.resolveRequestBodyModifications([
        { path: "$.a", value: "number:42" },
        { path: "$.b", value: "boolean:true" },
        { path: "$.c", value: "json:{x:1}" },
      ])
    ).resolves.toEqual([
      { path: "$.a", value: 42 },
      { path: "$.b", value: true },
      { path: "$.c", value: { x: 1 } },
    ]);
  });

  it("an empty list resolves to an empty list", async () => {
    await expect(APIUtils.resolveRequestBodyModifications([])).resolves.toEqual([]);
  });
});

describe("APIUtils.assertPrimitiveValues", () => {
  it("passes for string/number/boolean/null values", () => {
    expect(() =>
      APIUtils.assertPrimitiveValues({ a: "x", b: 1, c: true, d: null }, "header")
    ).not.toThrow();
  });

  it("rejects an object value", () => {
    expect(() => APIUtils.assertPrimitiveValues({ a: { nested: true } }, "header")).toThrow(
      /header \[a\] resolved to a non-primitive value/
    );
  });

  it("accepts a string[] value — a genuine multi-value entry (e.g. Set-Cookie, Accept-Language, a repeated query key)", () => {
    expect(() => APIUtils.assertPrimitiveValues({ a: ["x", "y"] }, "header")).not.toThrow();
  });

  it("accepts an empty array", () => {
    expect(() => APIUtils.assertPrimitiveValues({ a: [] }, "header")).not.toThrow();
  });

  it("rejects an array containing a non-string element", () => {
    expect(() => APIUtils.assertPrimitiveValues({ a: ["x", 42, "z"] }, "header")).toThrow(
      /header \[a\]\[1\] resolved to a non-string array element/
    );
  });
});

describe("APIUtils.buildQueryString", () => {
  it("encodes scalar values", () => {
    expect(APIUtils.buildQueryString({ a: "1", b: 2, c: true })).toBe("a=1&b=2&c=true");
  });

  it("a string[] value produces one key=value pair per entry — a genuine repeated key", () => {
    expect(APIUtils.buildQueryString({ tag: ["a", "b"] })).toBe("tag=a&tag=b");
  });

  it("a null value omits that key entirely", () => {
    expect(APIUtils.buildQueryString({ a: "1", b: null })).toBe("a=1");
  });

  it("percent-encodes keys and values", () => {
    expect(APIUtils.buildQueryString({ "a b": "c&d" })).toBe("a%20b=c%26d");
  });

  it("empty params object produces an empty string", () => {
    expect(APIUtils.buildQueryString({})).toBe("");
  });
});

describe("APIUtils.mergeQueryStrings", () => {
  it("joins multiple non-empty fragments with &", () => {
    expect(APIUtils.mergeQueryStrings("a=1", "b=2")).toBe("a=1&b=2");
  });

  it("strips a leading ? from any fragment", () => {
    expect(APIUtils.mergeQueryStrings("?a=1", "b=2")).toBe("a=1&b=2");
  });

  it("preserves a duplicate key across fragments rather than resolving it", () => {
    expect(APIUtils.mergeQueryStrings("a=1", "a=2")).toBe("a=1&a=2");
  });

  it("skips undefined and empty-string fragments", () => {
    expect(APIUtils.mergeQueryStrings(undefined, "", "a=1", undefined)).toBe("a=1");
  });

  it("returns undefined when every fragment is empty/undefined", () => {
    expect(APIUtils.mergeQueryStrings(undefined, "", "?")).toBeUndefined();
  });

  it("returns undefined for zero arguments", () => {
    expect(APIUtils.mergeQueryStrings()).toBeUndefined();
  });
});

describe("APIUtils.buildURL", () => {
  it("builds a plain URL with no query string at all", () => {
    expect(APIUtils.buildURL({ protocol: "http", host: "localhost:3000", resourcePath: "/users" }))
      .toBe("http://localhost:3000/users");
  });

  it("a queryString option alone becomes the URL's query", () => {
    expect(APIUtils.buildURL({ protocol: "http", host: "localhost:3000", resourcePath: "/users", queryString: "a=1" }))
      .toBe("http://localhost:3000/users?a=1");
  });

  it("a query string embedded directly in resourcePath alone becomes the URL's query", () => {
    expect(APIUtils.buildURL({ protocol: "http", host: "localhost:3000", resourcePath: "/users?a=1" }))
      .toBe("http://localhost:3000/users?a=1");
  });

  it("both present: merges rather than one overriding the other, preserving a duplicate key", () => {
    const url = APIUtils.buildURL({
      protocol: "http", host: "localhost:3000", resourcePath: "/users?a=1", queryString: "a=2&b=3",
    });
    expect(url).toBe("http://localhost:3000/users?a=1&a=2&b=3");
  });
});
