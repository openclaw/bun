// DuplexUpgradeContext holds a TLSSocket whose Handlers allocation is freed
// (via Handlers.markInactive → vm.allocator.destroy) the first time
// active_connections hits 0. Several callbacks in DuplexUpgradeContext kept
// dispatching into the TLSSocket after that point, reading tls.handlers on
// freed memory. Each case below used to abort under ASAN; the fix nulls
// `this.tls` before the freeing call so subsequent callbacks short-circuit
// on the existing null-check.

import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, tls as tlsCert } from "harness";
import { join } from "node:path";

// `script` is the source of a script, or the arguments that run a fixture file.
async function run(script: string | string[], expected = "ok", env: Record<string, string> = {}) {
  // Spawn a subprocess so an ASAN use-after-poison report shows up as a
  // non-zero exit + stderr dump rather than killing the test runner itself.
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...(typeof script === "string" ? ["-e", script] : script)],
    // Disable the external ASAN symbolizer: when the UAF fires it can wedge
    // on a broken pipe to llvm-symbolizer and the subprocess never exits,
    // turning a clear assertion failure into a test timeout.
    env: { ...bunEnv, ...env, ASAN_OPTIONS: "symbolize=0:abort_on_error=1:allow_user_segv_handler=1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  // On failure stderr carries the ASAN "use-after-poison" report; include
  // it in the assertion so the diff shows the crash rather than just an
  // empty stdout.
  expect({ stdout: stdout.trim(), stderr, exitCode }).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
}

// The freed pointer is only reliably caught under ASAN (which the debug
// build enables); release builds may read garbage without trapping. Each
// test spawns an independent subprocess so they can run concurrently.
describe.concurrent.skipIf(!isASAN && !isDebug)("tls.connect({socket: Duplex}) does not read freed Handlers", () => {
  for (const phase of ["startup", "completion"]) {
    test.serial(`terminating a worker releases queued TLS ${phase}`, async () => {
      const workerSource = `
        const tls = require("node:tls");
        const { Duplex } = require("node:stream");
        const { once } = require("node:events");
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          let a, b;
          const side = peer => new Duplex({
            allowHalfOpen: true,
            read() {},
            write(chunk, encoding, callback) { peer().push(chunk); callback(); },
          });
          a = side(() => b);
          b = side(() => a);
          const server = new tls.TLSSocket(b, { isServer: true, ...workerData.certs });
          const client = tls.connect({ socket: a, rejectUnauthorized: false });
          server.on("error", error => { throw error; });
          client.on("error", error => { throw error; });
          if (workerData.phase === "completion") {
            await once(client, "secureConnect");
            await new Promise(resolve => setImmediate(resolve));
            let completion;
            b.write = (chunk, encoding, callback) => {
              completion = typeof encoding === "function" ? encoding : callback;
              return true;
            };
            server.write("x", () => {});
            if (typeof completion !== "function") throw new Error("missing ciphertext completion");
            completion();
          }
          // Stop this invocation before StartTLS/the completion Immediate can run.
          parentPort.postMessage(workerData.phase);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        })().catch(error => { throw error; });
      `;
      await run(`
        const { Worker } = require("node:worker_threads");
        const { once } = require("node:events");
        const assert = require("node:assert/strict");
        const worker = new Worker(${JSON.stringify(workerSource)}, {
          eval: true,
          workerData: { phase: ${JSON.stringify(phase)}, certs: ${JSON.stringify(tlsCert)} },
        });
        try {
          const [ready] = await once(worker, "message");
          assert.equal(ready, ${JSON.stringify(phase)});
          assert.equal(await worker.terminate(), 1);
          console.log("ok");
        } finally {
          await worker.terminate();
        }
      `);
    });
  }

  test("closing a duplex does not call its throwing end method", async () => {
    // Closing once called end() after freeing the Handlers. Like Node, destruction
    // now avoids end() entirely, including when the transport emits close.
    await run(
      `
      const tls = require("node:tls");
      const { Duplex } = require("node:stream");

      // A throwing end method exposes any accidental graceful shutdown during close.
      const duplex = new Duplex({
        read() {},
        write(chunk, enc, cb) { cb(); },
        final(cb) { cb(); },
      });
      duplex.end = function () {
        throw new Error("end() throws during close");
      };
      // Keep the transport open so destroyed-state guards cannot hide an end call.
      duplex.destroy = function () {
        return this;
      };
      process.on("uncaughtException", err => console.log("uncaught: " + err.message));

      const sock = tls.connect({
        socket: duplex,
        rejectUnauthorized: false,
      });
      sock.on("error", () => {});
      sock.on("close", () => {});

      // Exercise transport close after the TLS engine has started.
      setImmediate(() => {
        setImmediate(() => {
          duplex.emit("close");
          setImmediate(() => {
            console.log("ok");
            process.exit(0);
          });
        });
      });
    `,
      "ok",
    );
  });

  test("when a pre-open duplex error races StartTLS", async () => {
    // An error on the duplex before the queued .StartTLS task runs
    // (is_open == false) routed to DuplexUpgradeContext.onError →
    // tls.handleConnectError(), freeing the Handlers. The .StartTLS task
    // then fired onOpen → tls.onOpen → isServer() → getHandlers() on the
    // freed allocation.
    await run(`
      const tls = require("node:tls");
      const { Duplex } = require("node:stream");

      const duplex = new Duplex({
        read() {},
        write(chunk, enc, cb) { cb(); },
        final(cb) { cb(); },
      });

      const sock = tls.connect({
        socket: duplex,
        rejectUnauthorized: false,
      });
      sock.on("error", () => {});
      sock.on("close", () => {});

      // Non-Buffer data triggers UpgradedDuplex.onReceivedData's error branch
      // → DuplexUpgradeContext.onError with is_open == false, before the
      // queued .StartTLS task has run.
      queueMicrotask(() => {
        duplex.emit("data", "string, not a buffer");
      });

      setImmediate(() => {
        setImmediate(() => {
          console.log("ok");
          process.exit(0);
        });
      });
    `);
  });

  // Serial: four debug subprocesses at once reach the default test timeout on a loaded machine.
  test.serial("a close before StartTLS does not call duplex.end()", async () => {
    // The queued StartTLS task carries out early closes. Both close paths
    // must avoid end(), even when the transport's destroy() leaves it open.
    await run(
      `
      const tls = require("node:tls");
      const { Duplex } = require("node:stream");

      function closeBeforeStartTLS(how) {
        const duplex = new Duplex({
          read() {},
          write(chunk, enc, cb) { cb(); },
          final(cb) { cb(); },
        });
        let ends = 0;
        duplex.end = function () {
          ends++;
          throw new Error("end() throws when " + how);
        };
        duplex.destroy = function () {
          return this;
        };

        const sock = tls.connect({
          socket: duplex,
          rejectUnauthorized: false,
        });
        sock.on("error", () => {});
        sock.on("close", () => {});

        if (how === "the duplex closes") duplex.emit("close");
        else sock.destroy();
        return () => how + ", end() calls: " + ends;
      }

      process.on("uncaughtException", err => console.log("uncaught: " + err.message));
      const reports = [closeBeforeStartTLS("the duplex closes"), closeBeforeStartTLS("the socket is destroyed")];

      setImmediate(() => {
        setImmediate(() => {
          for (const report of reports) console.log(report());
          console.log("ok");
          process.exit(0);
        });
      });
    `,
      ["the duplex closes, end() calls: 0", "the socket is destroyed, end() calls: 0", "ok"].join("\n"),
    );
  });

  test.serial("when an EOF listener destroys the socket and throws before StartTLS", async () => {
    // The transport's EOF reaches the TLS socket when the transport ends,
    // which can be before the queued .StartTLS task has run. 'readable' is
    // emitted from inside that dispatch and 'end' one tick after it.
    await run(
      `
      const tls = require("node:tls");
      const { Duplex } = require("node:stream");

      const seen = [];
      for (const event of ["readable", "end"]) {
        const duplex = new Duplex({
          read() {},
          write(chunk, enc, cb) { cb(); },
          final(cb) { cb(); },
        });

        const sock = tls.connect({
          socket: duplex,
          rejectUnauthorized: false,
        });
        sock.on("error", () => {});
        sock.on("close", () => {});
        sock.once(event, () => {
          seen.push("eof in '" + event + "'");
          sock.destroy();
          throw new Error("listener throws");
        });

        duplex.push(null);
        duplex.end();
      }
      process.on("uncaughtException", () => {});

      setImmediate(() => {
        setImmediate(() => {
          for (const line of seen.sort()) console.log(line);
          console.log("ok");
          process.exit(0);
        });
      });
    `,
      "eof in 'end'\neof in 'readable'\nok",
    );
  });
});

// The native context of a TLS socket over a Duplex must not be freed while a
// frame of its TLS engine is on the stack. A callback only has to turn the event
// loop synchronously for queued tasks to run under such a frame:
// `expect().resolves` and `Bun.build` with an async plugin `setup()` do. The
// fixture counts the live contexts, so these tests do not need ASAN to fail.
// Serial, like the tests above: several debug subprocesses at once reach the
// default test timeout.
describe("a TLS socket over a Duplex keeps its native context", () => {
  const fixture = join(import.meta.dir, "tls-duplex-destroy-then-turn-fixture.mjs");
  const env = { TLS_KEY: tlsCert.key, TLS_CERT: tlsCert.cert };
  // Three contexts before the turn: the socket, its peer, and one that nothing
  // holds. The turn frees the third: it ran the queued tasks.
  const kept = { before: 3, afterTurn: 2, afterClose: 0 };

  test("while a callback of the handshake closes the socket and turns the event loop", async () => {
    const expected = { "ALPNCallback": kept, "server 'keylog'": kept, "client 'secureConnect'": kept };
    await run([fixture, "handshake"], JSON.stringify(expected), env);
  });

  test("while a callback of the session closes the socket and turns the event loop", async () => {
    const expected = {
      "server 'data'": kept,
      "server 'data', turned by Bun.build()": kept,
      "client 'data'": kept,
      "the transport's write()": kept,
    };
    await run([fixture, "data"], JSON.stringify(expected), env);
  });

  test("while a callback turns the event loop and something else closes the socket", async () => {
    const expected = {
      "the transport's final(), destroy() in a later turn": kept,
      "server 'data', the transport closes during the turn": kept,
      "server 'data', its Bun.ModuleGraph is disposed": kept,
    };
    await run([fixture, "waits"], JSON.stringify(expected), env);
  });

  test("and frees it whichever way the connection ends", async () => {
    const one = { open: 1, ended: 0 };
    const pair = { open: 2, ended: 0 };
    const expected = {
      "destroy() before the engine starts": one,
      "destroy() twice": pair,
      "end() on both sides": pair,
      "a string from the transport before the engine starts": one,
      "its Bun.ModuleGraph is disposed before the engine starts": one,
      "its Bun.ModuleGraph is disposed under the transport's 'end', before the engine starts": {
        graphErrors: [],
        open: 1,
        afterTurn: 1,
        ended: 0,
      },
      "destroy(), then its Bun.ModuleGraph is disposed in the same turn": one,
    };
    await run([fixture, "ends"], JSON.stringify(expected), env);
  });
});
