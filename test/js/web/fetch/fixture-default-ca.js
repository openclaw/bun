const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { once } = require("node:events");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { Worker } = require("node:worker_threads");
const dir = process.argv[2];
const mode = process.argv[3] || "override";
const cert = readFileSync(join(dir, "cert.pem"), "utf8");
const otherCert = readFileSync(join(dir, "other-cert.pem"), "utf8");
const original = tls.getCACertificates("default");
async function start(prefix, text) {
  const server = https.createServer(
    { key: readFileSync(join(dir, prefix + "key.pem")), cert: readFileSync(join(dir, prefix + "cert.pem")) },
    (_req, res) => res.end(text),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `https://localhost:${server.address().port}/` };
}
async function throughNativeHttpsProxy(target) {
  const sockets = new Set();
  const proxy = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert });
  proxy.on("connect", (_request, client, head) => {
    const upstream = net.connect(Number(new URL(target.url).port), "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    assert.equal(await body(target.url, { proxy: `https://localhost:${proxy.address().port}` }), "first");
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
}
async function body(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.status, 200);
  return response.text();
}
async function rejected(url, options) {
  let failed = false;
  try {
    await body(url, options);
  } catch {
    failed = true;
  }
  assert.ok(failed, "untrusted fetch must reject");
}
(async () => {
  const first = await start("", "first");
  const other = await start("other-", "other");
  let session;
  try {
    if (mode === "empty") {
      assert.equal(await body(first.url), "first");
      first.server.closeAllConnections();
      if (globalThis.Bun) {
        await rejected(first.url, { tls: { ca: [] } });
        assert.equal(await body(first.url, { tls: { rejectUnauthorized: true } }), "first");
        first.server.closeAllConnections();
        await rejected(first.url, { tls: { rejectUnauthorized: true, ca: [] } });
      }
      await assert.rejects(
        new Promise((resolve, reject) => {
          https
            .get(first.url, { agent: false, ca: [] }, response => {
              response.resume();
              response.on("end", resolve);
            })
            .on("error", reject);
        }),
        { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      );
      tls.setDefaultCACertificates([]);
      first.server.closeAllConnections();
      await rejected(first.url);
    } else {
      await rejected(first.url);
      tls.setDefaultCACertificates([cert]);
      assert.equal(await body(first.url), "first");
      const worker = new Worker(
        `const { parentPort, workerData } = require("node:worker_threads"); fetch(workerData).then(() => parentPort.postMessage("trusted"), () => parentPort.postMessage("untrusted"));`,
        { eval: true, workerData: first.url },
      );
      try {
        assert.deepEqual(await once(worker, "message"), ["untrusted"]);
      } finally {
        await worker.terminate();
      }
      await rejected(other.url);
      if (globalThis.Bun) {
        await throughNativeHttpsProxy(first);
        assert.equal(await body(first.url, { tls: { rejectUnauthorized: true } }), "first");
        await rejected(first.url, { tls: { ca: otherCert } });
        await rejected(first.url, { tls: { ca: [] } });
        assert.equal(await body(other.url, { tls: { ca: otherCert } }), "other");
        session = new Bun.FetchSession({ tls: { rejectUnauthorized: true } });
        assert.equal(await body(first.url, { session }), "first");
      }
      tls.setDefaultCACertificates([otherCert]);
      first.server.closeAllConnections();
      other.server.closeAllConnections();
      await rejected(first.url);
      assert.equal(await body(other.url), "other");
      if (session) {
        await rejected(first.url, { session });
        assert.equal(await body(other.url, { session }), "other");
      }
      tls.setDefaultCACertificates([]);
      other.server.closeAllConnections();
      await rejected(other.url);
    }
    if (globalThis.Bun) {
      const explicitSession = new Bun.FetchSession({ tls: { ca: cert } });
      try {
        assert.equal(await body(first.url, { session: explicitSession }), "first");
        await rejected(other.url, { session: explicitSession });
        assert.equal(await body(other.url, { session: explicitSession, tls: { ca: otherCert } }), "other");
        assert.equal(await body(first.url, { tls: { caFile: join(dir, "cert.pem") } }), "first");
      } finally {
        explicitSession.close();
      }
    }
    console.log("ok");
  } finally {
    session?.close();
    tls.setDefaultCACertificates(original);
    for (const { server } of [first, other]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
