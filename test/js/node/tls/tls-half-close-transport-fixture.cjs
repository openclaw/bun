// Node 24: close_notify ends the readable half; stream policy owns the writable half.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");
const { Duplex } = require("node:stream");
let mainFailure = null;
const out = value => fs.writeSync(1, JSON.stringify(value) + "\n");
const fixture = () => ({
  key: fs.readFileSync(path.join(__dirname, "fixtures/agent1-key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "fixtures/agent1-cert.pem")),
});
const version = { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" };
const waitEvent = (emitter, event) => new Promise(resolve => emitter.once(event, (...args) => resolve(args)));
async function child(name) {
  const trace = [];
  let complete = false;
  let evaluate = () => ({ configured: false });
  let failure = null;
  const event = (owner, eventName, data = {}) => {
    const entry = { type: "event", case: name, seq: trace.length + 1, owner, event: eventName, ...data };
    trace.push(entry);
  };
  const entries = (owner, eventName) => trace.filter(x => x.owner === owner && x.event === eventName);
  const count = (owner, eventName) => entries(owner, eventName).length;
  const one = (owner, eventName) => count(owner, eventName) === 1;
  const pos = (owner, eventName) => entries(owner, eventName)[0]?.seq;
  const before = (a, b, c, d) => one(a, b) && one(c, d) && pos(a, b) < pos(c, d);
  const noUnexpectedErrors = () =>
    !trace.some(
      x =>
        x.event === "error" ||
        x.event === "tlsClientError" ||
        x.event === "uncaughtException" ||
        x.event === "unhandledRejection",
    );
  const observe = (stream, owner, { data = false } = {}) => {
    for (const eventName of ["end", "finish", "close"])
      stream.on(eventName, value => event(owner, eventName, eventName === "close" ? { hadError: value ?? null } : {}));
    stream.on("error", error => event(owner, "error", { code: error.code ?? null, message: error.message }));
    if (data) stream.on("data", chunk => event(owner, "data", { text: chunk.toString() }));
    return stream;
  };
  process.on("uncaughtException", error => {
    failure = String(error);
    event("process", "uncaughtException", { message: String(error) });
  });
  process.on("unhandledRejection", error => {
    failure = String(error);
    event("process", "unhandledRejection", { message: String(error) });
  });
  process.once("beforeExit", () => {
    const checks = evaluate();
    const pass = !failure && !mainFailure && Object.values(checks).every(Boolean);
    event("process", "beforeExit", { complete });
    out({
      pass,
      complete,
      failure: failure ?? mainFailure,
      failedChecks: Object.keys(checks).filter(key => !checks[key]),
    });
    process.exitCode = pass ? 0 : 1;
  });
  function recordTypes(buffer) {
    const result = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const next = offset + 5 + buffer.readUInt16BE(offset + 3);
      if (next > buffer.length) return null;
      result.push(buffer[offset]);
      offset = next;
    }
    return offset === buffer.length ? result : null;
  }
  if (name === "legacy-pair" || name.startsWith("duplex-")) {
    const legacy = name === "legacy-pair",
      rawEof = name === "duplex-eof-halfopen-true",
      writeAfterEnd = name === "duplex-write-after-end",
      halfOpen = name === "duplex-halfopen-true" || rawEof || writeAfterEnd;
    let left,
      right,
      held = null;
    const rawOptions = legacy ? {} : { allowHalfOpen: halfOpen };
    left = observe(
      new Duplex({
        ...rawOptions,
        read() {},
        write(chunk, enc, cb) {
          const records = recordTypes(chunk);
          event("client-transport", "write", { records });
          if (records?.includes(21)) event("client-transport", "alert");
          right.push(chunk);
          cb();
        },
        final(cb) {
          event("client-transport", "final");
          right.push(null);
          cb();
        },
      }),
      "client-transport",
    );
    right = observe(
      new Duplex({
        ...rawOptions,
        read() {},
        write(chunk, enc, cb) {
          if (held === null) left.push(chunk);
          else {
            held = Buffer.concat([held, chunk]);
            if (recordTypes(held)?.at(-1) === 21) {
              const burst = held;
              held = null;
              event("relay", "burst", { records: recordTypes(burst) });
              if (rawEof) {
                const dataEnd = 5 + burst.readUInt16BE(3);
                event("relay", "alert.dropped", { records: recordTypes(burst.subarray(dataEnd)) });
                left.push(burst.subarray(0, dataEnd));
              } else {
                left.push(burst);
              }
            }
          }
          cb();
        },
        final(cb) {
          event("server-transport", "final");
          left.push(null);
          cb();
        },
      }),
      "server-transport",
    );
    const tlsOptions = legacy ? {} : { allowHalfOpen: halfOpen };
    const server = observe(
      new tls.TLSSocket(right, {
        ...tlsOptions,
        isServer: true,
        secureContext: tls.createSecureContext({ ...fixture(), ...version }),
      }),
      "server",
      { data: true },
    );
    server.on("data", chunk => {
      if (chunk.toString() === "go") server.end("last");
      if (writeAfterEnd && chunk.toString() === "tail") {
        event("application", "tail.received.before.end", { writableEnded: client.writableEnded });
        client.end();
      }
    });
    const client = observe(
      tls.connect({ ...tlsOptions, socket: left, rejectUnauthorized: false, ...version }),
      "client",
      { data: true },
    );
    client.on("end", () => {
      event("application", "client.end.observed", {
        allowHalfOpen: client.allowHalfOpen,
        transportAllowHalfOpen: left.allowHalfOpen,
        writableEnded: client.writableEnded,
      });
      if (halfOpen) {
        if (writeAfterEnd) {
          // Leave the native receive callback before writing; end() must not flush the tail for us.
          setImmediate(() => client.write("tail"));
        } else {
          event("application", "client.end.call", { text: "tail" });
          client.end("tail");
        }
      }
    });
    evaluate = () => ({
      handshake: one("client", "secureConnect"),
      burst: one("relay", "burst") && JSON.stringify(entries("relay", "burst")[0].records) === "[23,21]",
      lastData: one("client", "data") && entries("client", "data")[0].text === "last",
      dataBeforeEnd: before("client", "data", "client", "end"),
      legacyQuiescence:
        !legacy || (count("client", "close") === 0 && !complete && count("client-transport", "alert") === 0),
      completed: legacy || complete,
      replyAfterData: legacy || before("client", "data", "client-transport", "alert"),
      endBeforeClose: legacy || before("client", "end", "client", "close"),
      bothTlsClosed: legacy || (one("client", "close") && one("server", "close")),
      bothRawClosed: legacy || (one("client-transport", "close") && one("server-transport", "close")),
      tailDelivered: !halfOpen || entries("server", "data").some(x => x.text === "tail"),
      tailBeforeEnd:
        !writeAfterEnd ||
        (one("application", "tail.received.before.end") &&
          entries("application", "tail.received.before.end")[0].writableEnded === false),
      rawEofBeforeAlert:
        !rawEof ||
        (one("relay", "alert.dropped") &&
          JSON.stringify(entries("relay", "alert.dropped")[0].records) === "[21]" &&
          before("client-transport", "end", "client-transport", "alert")),
      writableOpenAtEnd: !halfOpen || entries("application", "client.end.observed")[0]?.writableEnded === false,
      noErrors: noUnexpectedErrors(),
    });
    await waitEvent(client, "secureConnect");
    event("client", "secureConnect", {
      protocol: client.getProtocol(),
      allowHalfOpen: client.allowHalfOpen,
      transportAllowHalfOpen: left.allowHalfOpen,
    });
    const closed = legacy
      ? waitEvent(client, "close")
      : Promise.all([
          waitEvent(client, "close"),
          waitEvent(server, "close"),
          waitEvent(left, "close"),
          waitEvent(right, "close"),
        ]);
    held = Buffer.alloc(0);
    client.write("go");
    await closed;
    complete = true;
    return;
  }
}
child(process.argv[2]).catch(error => {
  mainFailure = String(error);
  process.exitCode = 1;
});
