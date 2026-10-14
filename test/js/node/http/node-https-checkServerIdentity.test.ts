// https.request() checks the peer certificate against the hostname the way
// tls.checkServerIdentity() does in Node. agent1's certificate is CN=agent1
// with no subjectAltName, signed by ca1. Every request below trusts ca1, so
// the identity check alone decides whether the request succeeds.
//
// The mismatch case runs in a child process on purpose. The child makes one
// rejected request, closes the server as soon as the request emits "error",
// and exits. The test requires an empty stderr and exit code 0. On the ASAN
// lane the child also runs with leak detection. A crash or a leak on the
// reject path fails this one test instead of the test runner. This child is
// how the close_notify leak fixed in #30368 was found, and that fix has no
// other test. The other cases only check behavior and run in this process.

import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import https, { type RequestOptions, type Server, type ServerOptions } from "node:https";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import tls, { TLSSocket } from "node:tls";

const keys = join(import.meta.dir, "..", "test", "fixtures", "keys");
const agent1 = {
  key: readFileSync(join(keys, "agent1-key.pem"), "utf8"), // CN=agent1, no SAN, signed by ca1
  cert: readFileSync(join(keys, "agent1-cert.pem"), "utf8"),
  ca: readFileSync(join(keys, "ca1-cert.pem"), "utf8"),
};

async function listen(options: ServerOptions): Promise<Server> {
  const server = https.createServer(options, (_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await once(server.listen(0), "listening");
  return server;
}

async function request(options: RequestOptions): Promise<{ statusCode: number | undefined; body: string }> {
  const req = https.request(options);
  req.end();
  const [res] = await once(req, "response");
  res.setEncoding("utf8");
  let body = "";
  res.on("data", (chunk: string) => (body += chunk));
  await once(res, "end");
  return { statusCode: res.statusCode, body };
}

describe.concurrent("https.request checkServerIdentity", () => {
  test("hostname mismatch emits error without crashing", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          const https = require("https");
          const server = https.createServer({
            key: ${JSON.stringify(agent1.key)},
            cert: ${JSON.stringify(agent1.cert)},
          }, (req, res) => { res.writeHead(200); res.end("ok"); });
          server.listen(0, () => {
            const req = https.request({
              port: server.address().port,
              rejectUnauthorized: true,
              ca: ${JSON.stringify(agent1.ca)},
              servername: "not-agent1",
            }, res => {
              console.log(JSON.stringify({ unexpectedResponse: res.statusCode }));
              res.resume();
              server.close();
            });
            req.on("error", err => {
              console.log(JSON.stringify({
                code: err.code,
                reason: err.reason,
                host: err.host,
                certCN: err.cert?.subject?.CN,
                message: err.message,
              }));
              server.close();
            });
            req.end();
          });
        `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      reason: "Host: not-agent1. is not cert's CN: agent1",
      host: "not-agent1",
      certCN: "agent1",
      message: "Hostname/IP does not match certificate's altnames: Host: not-agent1. is not cert's CN: agent1",
    });
    expect(exitCode).toBe(0);
  });

  test("falls back to Subject CN when no SAN is present", async () => {
    await using server = await listen({ key: agent1.key, cert: agent1.cert });
    const { port } = server.address() as AddressInfo;
    expect(await request({ port, rejectUnauthorized: true, ca: agent1.ca, servername: "agent1" })).toEqual({
      statusCode: 200,
      body: "ok",
    });
  });

  // https.request() defaults the host to "localhost", which does not match
  // CN=agent1, so only the custom callback can let this request through.
  test("custom checkServerIdentity overrides the native check", async () => {
    await using server = await listen({ key: agent1.key, cert: agent1.cert });
    const { port } = server.address() as AddressInfo;
    const calls: { hostname: string; subjectCN: string; issuerCN: string }[] = [];
    const response = await request({
      port,
      rejectUnauthorized: true,
      ca: agent1.ca,
      checkServerIdentity(hostname, cert) {
        calls.push({ hostname, subjectCN: cert.subject.CN, issuerCN: cert.issuer.CN });
        return undefined;
      },
    });
    expect(response).toEqual({ statusCode: 200, body: "ok" });
    expect(calls).toEqual([{ hostname: "localhost", subjectCN: "agent1", issuerCN: "ca1" }]);
  });

  // Node only asks the client for a certificate when requestCert is set.
  // A server `ca` on its own must not reject a client without one.
  test("https.Server with ca but no requestCert accepts clients without a cert", async () => {
    await using server = await listen({ key: agent1.key, cert: agent1.cert, ca: agent1.ca });
    const { port } = server.address() as AddressInfo;
    expect(await request({ port, rejectUnauthorized: true, ca: agent1.ca, servername: "agent1" })).toEqual({
      statusCode: 200,
      body: "ok",
    });
  });
});

test("https req.socket is a TLSSocket that exposes the client certificate", async () => {
  const fixtures = join(import.meta.dir, "../tls/fixtures");
  const serverOptions = {
    key: readFileSync(join(fixtures, "agent10-key.pem"), "utf8"),
    cert: readFileSync(join(fixtures, "agent10-cert.pem"), "utf8"),
    ca: readFileSync(join(fixtures, "ca5-cert.pem"), "utf8"),
    requestCert: true,
    rejectUnauthorized: false,
  };
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const server = https.createServer(serverOptions, (req, res) => {
    try {
      const s = req.socket as TLSSocket;
      resolve({
        ctor: s.constructor.name,
        isTLSSocket: s instanceof TLSSocket,
        isNetSocket: s instanceof net.Socket,
        authorized: s.authorized,
        encrypted: s.encrypted,
        servername: s.servername,
        peerCN: s.getPeerCertificate()?.subject?.CN,
        detailedCN: s.getPeerCertificate(true)?.subject?.CN,
        x509Subject: s.getPeerX509Certificate()?.subject,
        cipherName: s.getCipher()?.name,
        protocol: s.getProtocol(),
      });
    } catch (err) {
      reject(err);
    }
    res.end("ok");
  });
  server.on("error", reject);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const clientRequest = https.request({
    port,
    host: "127.0.0.1",
    rejectUnauthorized: false,
    key: readFileSync(join(fixtures, "ec10-key.pem"), "utf8"),
    cert: readFileSync(join(fixtures, "ec10-cert.pem"), "utf8"),
    agent: false,
    servername: "localhost",
  });
  clientRequest.on("error", reject);
  clientRequest.end();
  try {
    const got = await promise;
    expect(got).toEqual({
      ctor: "TLSSocket",
      isTLSSocket: true,
      isNetSocket: true,
      authorized: true,
      encrypted: true,
      servername: "localhost",
      peerCN: "agent10.example.com",
      detailedCN: "agent10.example.com",
      x509Subject: expect.stringContaining("CN=agent10.example.com"),
      cipherName: expect.any(String),
      protocol: expect.stringMatching(/^TLSv/),
    });
  } finally {
    clientRequest.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// tls.createServer was already fine (the issue is specific to node:https);
// keep it covered so the two server paths stay in sync.
test("tls.createServer connection sockets expose the client certificate the same way", async () => {
  const fixtures = join(import.meta.dir, "../tls/fixtures");
  const serverOptions = {
    key: readFileSync(join(fixtures, "agent10-key.pem"), "utf8"),
    cert: readFileSync(join(fixtures, "agent10-cert.pem"), "utf8"),
    ca: readFileSync(join(fixtures, "ca5-cert.pem"), "utf8"),
    requestCert: true,
    rejectUnauthorized: false,
  };
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const server = tls.createServer(serverOptions, socket => {
    try {
      resolve({
        isTLSSocket: socket instanceof TLSSocket,
        authorized: socket.authorized,
        peerCN: socket.getPeerCertificate()?.subject?.CN,
      });
    } catch (err) {
      reject(err);
    }
    socket.end();
  });
  server.on("error", reject);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const client = tls.connect({
    port,
    host: "127.0.0.1",
    rejectUnauthorized: false,
    key: readFileSync(join(fixtures, "ec10-key.pem"), "utf8"),
    cert: readFileSync(join(fixtures, "ec10-cert.pem"), "utf8"),
  });
  client.on("error", reject);
  try {
    expect(await promise).toEqual({
      isTLSSocket: true,
      authorized: true,
      peerCN: "agent10.example.com",
    });
  } finally {
    client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
