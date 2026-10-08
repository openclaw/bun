"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { Duplex } = require("node:stream");
const out = value => fs.writeSync(1, JSON.stringify(value) + "\n");
const fixture = () => ({
  key: fs.readFileSync(path.join(__dirname, "fixtures/agent1-key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "fixtures/agent1-cert.pem")),
});
const versions = { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" };
const waitEvent = (emitter, name) => new Promise(resolve => emitter.once(name, (...args) => resolve(args)));
function observer(name, role) {
  const trace = [];
  let failure = null,
    complete = false;
  let evaluate = () => ({ configured: false });
  const event = (owner, eventName, detail = {}) => {
    const entry = { type: "event", case: name, role, seq: trace.length + 1, owner, event: eventName, ...detail };
    trace.push(entry);
  };
  const entries = (owner, eventName) => trace.filter(x => x.owner === owner && x.event === eventName);
  const count = (owner, eventName) => entries(owner, eventName).length;
  const one = (owner, eventName) => count(owner, eventName) === 1;
  const before = (a, b, c, d) => one(a, b) && one(c, d) && entries(a, b)[0].seq < entries(c, d)[0].seq;
  const observe = (stream, owner, data = false) => {
    for (const eventName of ["end", "finish", "close"])
      stream.on(eventName, value => event(owner, eventName, eventName === "close" ? { hadError: value ?? null } : {}));
    stream.on("error", error => event(owner, "error", { code: error.code ?? null, message: error.message }));
    if (data) stream.on("data", chunk => event(owner, "data", { text: chunk.toString() }));
    return stream;
  };
  const noErrors = () =>
    !trace.some(x => ["error", "tlsClientError", "uncaughtException", "unhandledRejection"].includes(x.event));
  process.on("uncaughtException", error => {
    failure = String(error);
    event("process", "uncaughtException", { message: failure });
  });
  process.on("unhandledRejection", error => {
    failure = String(error);
    event("process", "unhandledRejection", { message: failure });
  });
  process.once("beforeExit", () => {
    const checks = { completed: complete, ...evaluate() };
    const pass = !failure && Object.values(checks).every(Boolean);
    event("process", "beforeExit", { complete });
    out({
      type: "role-result",
      role,
      pass,
      complete,
      failure,
      failedChecks: Object.keys(checks).filter(key => !checks[key]),
    });
    process.exitCode = pass ? 0 : 1;
  });
  return {
    event,
    entries,
    count,
    one,
    before,
    observe,
    noErrors,
    setChecks: fn => (evaluate = fn),
    done: () => (complete = true),
    fail: error => {
      failure = String(error);
      event("process", "main-failure", { message: failure, stack: error.stack });
    },
  };
}
async function runOracle(name, o) {
  const { event, entries, one, before, observe, noErrors } = o;
  const server = tls.createServer({ ...fixture(), ...versions, allowHalfOpen: false }, sock => {
    observe(sock, "tls", true);
    event("tls", "secureConnection", { protocol: sock.getProtocol() });
    sock.on("secure", () => event("tls", "secure", { protocol: sock.getProtocol() }));
    sock.on("data", chunk => {
      if (chunk.toString() === "ready") {
        event("application", "renegotiate.call");
        const accepted = sock.renegotiate({}, error => {
          event("tls", "renegotiate.callback", { error: error?.message ?? null });
          if (error) {
            o.fail(error);
            return;
          }
          event("application", "marker.write");
          sock.write("renegotiated");
        });
        event("application", "renegotiate.return", { accepted });
        if (!accepted) o.fail(new Error("Oracle server renegotiation rejected"));
      } else if (chunk.toString() === "go") {
        event("application", "end.call", { text: "last" });
        sock.end("last");
      }
    });
    sock.on("close", () =>
      server.close(() => {
        event("listener", "closed");
        o.done();
      }),
    );
  });
  server.on("tlsClientError", error =>
    event("listener", "tlsClientError", { code: error.code ?? null, message: error.message }),
  );
  server.on("error", error => event("listener", "error", { code: error.code ?? null, message: error.message }));
  o.setChecks(() => ({
    oneHandshake: one("tls", "secureConnection"),
    tls12: entries("tls", "secureConnection")[0]?.protocol === "TLSv1.2",
    request:
      entries("tls", "data").length === 2 &&
      entries("tls", "data")[0].text === "ready" &&
      entries("tls", "data")[1].text === "go",
    renegotiationAccepted: entries("application", "renegotiate.return")[0]?.accepted === true,
    renegotiationSucceeded:
      one("tls", "renegotiate.callback") && entries("tls", "renegotiate.callback")[0].error === null,
    callbackBeforeMarker: before("tls", "renegotiate.callback", "application", "marker.write"),
    markerBeforeEnd: before("application", "marker.write", "application", "end.call"),
    endCallBeforeFinish: before("application", "end.call", "tls", "finish"),
    finishBeforeClose: before("tls", "finish", "tls", "close"),
    endBeforeClose: before("tls", "end", "tls", "close"),
    closeFlag: entries("tls", "close")[0]?.hadError === false,
    listenerClosed: one("listener", "closed"),
    noErrors: noErrors(),
  }));
  server.listen(0, "127.0.0.1");
  await waitEvent(server, "listening");
  out({ type: "oracle-ready", port: server.address().port });
}
function parseRecords(event, owner) {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = 5 + pending.readUInt16BE(3);
      if (pending.length < size) break;
      const type = pending[0];
      event(owner, "record", { recordType: type, bytes: size });
      if (type === 21) event(owner, "alert");
      pending = pending.subarray(size);
    }
  };
}
async function runClient(name, port, o) {
  const { event, entries, count, one, before, observe, noErrors } = o;
  const generic = name === "renegotiate-duplex";
  const raw = observe(net.connect({ host: "127.0.0.1", port, allowHalfOpen: generic }), "raw");
  let transport = raw;
  if (generic) {
    const parse = parseRecords(event, "client-wire");
    transport = observe(
      new Duplex({
        allowHalfOpen: false,
        read() {
          raw.resume();
        },
        write(chunk, encoding, cb) {
          parse(chunk);
          raw.write(chunk, encoding, cb);
        },
        final(cb) {
          event("transport", "final");
          raw.end(cb);
        },
        destroy(error, cb) {
          event("transport", "_destroy", { error: error?.message ?? null });
          if (raw.closed) {
            cb(error);
            return;
          }
          raw.once("close", () => cb(error));
          raw.destroy(error);
        },
      }),
      "transport",
    );
    raw.on("data", chunk => {
      if (!transport.push(chunk)) raw.pause();
    });
    raw.on("end", () => {
      event("transport", "eof.forward");
      transport.push(null);
    });
    raw.on("error", error => transport.destroy(error));
  }
  const client = observe(
    tls.connect({ socket: transport, rejectUnauthorized: false, allowHalfOpen: false, ...versions }),
    "tls",
    true,
  );
  client.on("secureConnect", () =>
    event("tls", "secureConnect", {
      protocol: client.getProtocol(),
      allowHalfOpen: client.allowHalfOpen,
      transportAllowHalfOpen: transport.allowHalfOpen,
      rawAllowHalfOpen: raw.allowHalfOpen,
    }),
  );
  o.setChecks(() => ({
    handshakeCount: count("tls", "secureConnect") === 2,
    tls12: entries("tls", "secureConnect").every(x => x.protocol === "TLSv1.2"),
    markerBeforeRequest: before("application", "marker.received", "application", "request.write"),
    dataSequence:
      entries("tls", "data").length === 2 &&
      entries("tls", "data")[0].text === "renegotiated" &&
      entries("tls", "data")[1].text === "last",
    dataBeforeEnd: before("application", "last.received", "tls", "end"),
    endBeforeClose: before("tls", "end", "tls", "close"),
    finishBeforeClose: before("tls", "finish", "tls", "close"),
    closeFlag: entries("tls", "close")[0]?.hadError === false,
    rawClosed: one("raw", "close"),
    genericLifecycle:
      !generic ||
      (one("transport", "final") &&
        one("transport", "finish") &&
        one("transport", "_destroy") &&
        one("transport", "close")),
    genericDataBeforeReply: !generic || before("application", "last.received", "client-wire", "alert"),
    genericReplyBeforeFinal: !generic || before("client-wire", "alert", "transport", "final"),
    noErrors: noErrors(),
  }));
  client.on("data", chunk => {
    if (chunk.toString() === "renegotiated") {
      event("application", "marker.received");
      event("application", "request.write");
      client.write("go");
    } else if (chunk.toString() === "last") event("application", "last.received");
  });
  await waitEvent(client, "secureConnect");
  const closed = Promise.all([
    waitEvent(client, "close"),
    waitEvent(raw, "close"),
    ...(generic ? [waitEvent(transport, "close")] : []),
  ]);
  event("application", "ready.write");
  client.write("ready");
  await closed;
  event("application", "all.closes");
  o.done();
}

const name = process.argv[3];
const oracle = process.argv[2] === "--oracle-server";
const observation = observer(name, oracle ? "oracle-server" : "client");
(oracle ? runOracle(name, observation) : runClient(name, Number(process.argv[4]), observation)).catch(observation.fail);
