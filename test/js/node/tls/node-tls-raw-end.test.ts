// Runs under node:test, so the same file runs on node (`node --test`) and on bun (`bun test`).
import assert from "node:assert";
import fs from "node:fs";
import net from "node:net";
import { finished } from "node:stream";
import { test } from "node:test";
import tls from "node:tls";

const key = fs.readFileSync(new URL("./fixtures/agent1-key.pem", import.meta.url));
const cert = fs.readFileSync(new URL("./fixtures/agent1-cert.pem", import.meta.url));

// A server wraps an accepted socket in a TLSSocket, then calls raw.end() on the socket it wrapped, before the
// handshake can start. Returns the ordered events of both sockets and how finished() settled the TLS socket.
async function rawEnd(when) {
  const events = [];
  const { promise, resolve } = Promise.withResolvers();
  // The 'close' of both sockets, and finished().
  let pending = 3;
  const settle = () => --pending === 0 && resolve();
  const server = net.createServer(raw => {
    const wrap = new tls.TLSSocket(raw, { isServer: true, key, cert });
    for (const [name, socket] of [
      ["raw", raw],
      ["tls", wrap],
    ]) {
      socket.on("end", () => events.push(`${name} end`));
      socket.on("error", err => events.push(`${name} error ${err.code}`));
      socket.on("close", () => {
        events.push(`${name} close`);
        settle();
      });
    }
    finished(wrap, err => {
      events.push(err ? `finished ${err.code}` : "finished ok");
      settle();
    });
    wrap.resume();
    if (when === "nextTick") process.nextTick(() => raw.end());
    else setImmediate(() => raw.end());
  });
  await new Promise(listening => server.listen(0, "127.0.0.1", listening));
  const peer = net.connect(server.address().port, "127.0.0.1");
  peer.on("error", () => {});
  peer.on("end", () => peer.end());
  peer.resume();
  await promise;
  peer.destroy();
  server.close();
  return events;
}

for (const when of ["nextTick", "setImmediate"]) {
  // Regression from #39066 and #42265: bun 1.4.2 and node settle finished() with no error.
  test(`finished() reports no error when raw.end() closes the socket a TLSSocket wraps, from ${when}`, async () => {
    const events = await rawEnd(when);
    assert.ok(events.includes("finished ok"), events.join(", "));
  });

  // node: TLSWrap owns the reads of the wrapped socket, so only the TLS socket reports the end of the stream.
  // bun 1.4.2 also reports it on the wrapped socket.
  test(`only the TLS socket reports 'end' when raw.end() closes the socket it wraps, from ${when}`, async () => {
    const events = await rawEnd(when);
    assert.ok(events.includes("tls end"), events.join(", "));
    assert.ok(!events.includes("raw end"), events.join(", "));
  });
}

for (const route of ["client", "server", "injected-server"]) {
  test(`a half-open ${route} wrap retains its raw socket until the application ends`, async () => {
    const version = { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;
    const resources = [];
    const closes = [];
    const events = [];
    const errors = [];
    const targetReady = Promise.withResolvers();
    const peerReady = Promise.withResolvers();
    const reply = Promise.withResolvers();
    let raw;
    let snapshot;
    let endError;
    let targetData = "";
    let peerData = "";
    function observe(socket, name) {
      resources.push(socket);
      closes.push(new Promise(resolve => socket.once("close", resolve)));
      socket.on("close", () => events.push(`${name} close`));
      socket.on("error", error => errors.push(error.code));
      return socket;
    }
    function target(socket) {
      observe(socket, "tls");
      socket.on("data", data => (targetData += data));
      socket.on("end", () => {
        events.push("tls end");
        setImmediate(() => {
          snapshot = {
            allowHalfOpen: socket.allowHalfOpen,
            writableEnded: socket.writableEnded,
            destroyed: socket.destroyed,
            rawDestroyed: raw.destroyed,
          };
          events.push("application end");
          socket.end("tail", error => {
            endError = error?.code ?? null;
            reply.resolve();
          });
        });
      });
      targetReady.resolve();
    }
    function peer(socket, secureEvent?) {
      observe(socket, "peer");
      socket.on("data", data => (peerData += data));
      if (secureEvent) socket.once(secureEvent, () => socket.end("last"));
      else socket.end("last");
      peerReady.resolve();
    }
    const injected = route === "injected-server" ? tls.createServer({ key, cert, ...version }) : null;
    injected?.on("secureConnection", target);
    const server =
      route === "client"
        ? tls.createServer({ key, cert, ...version, allowHalfOpen: true }, socket => peer(socket))
        : net.createServer({ allowHalfOpen: true }, socket => {
            raw = observe(socket, "raw");
            if (injected) injected.emit("connection", raw);
            else target(new tls.TLSSocket(raw, { isServer: true, key, cert, ...version }));
          });
    try {
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as net.AddressInfo;
      if (route === "client") {
        raw = observe(net.connect({ host: "127.0.0.1", port: address.port, allowHalfOpen: true }), "raw");
        target(tls.connect({ socket: raw, rejectUnauthorized: false, ...version }));
      } else {
        peer(
          tls.connect({
            host: "127.0.0.1",
            port: address.port,
            allowHalfOpen: true,
            rejectUnauthorized: false,
            ...version,
          }),
          "secureConnect",
        );
      }
      await Promise.all([targetReady.promise, peerReady.promise]);
      await Promise.all([reply.promise, ...closes]);
      assert.deepStrictEqual(
        { snapshot, targetData, peerData, endError, errors },
        {
          snapshot: { allowHalfOpen: true, writableEnded: false, destroyed: false, rawDestroyed: false },
          targetData: "last",
          peerData: "tail",
          endError: null,
          errors: [],
        },
      );
      assert.ok(events.indexOf("application end") < events.indexOf("raw close"), events.join(", "));
      assert.ok(events.indexOf("application end") < events.indexOf("tls close"), events.join(", "));
    } finally {
      for (const socket of resources) socket.destroy();
      server.close();
      injected?.close();
    }
  });
}
