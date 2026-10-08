// DuplexUpgradeContext holds a TLSSocket whose Handlers allocation is freed
// (via Handlers.markInactive → vm.allocator.destroy) the first time
// active_connections hits 0. Several callbacks in DuplexUpgradeContext kept
// dispatching into the TLSSocket after that point, reading tls.handlers on
// freed memory. Each case below used to abort under ASAN; the fix nulls
// `this.tls` before the freeing call so subsequent callbacks short-circuit
// on the existing null-check.

import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug } from "harness";

async function run(script: string, expected = "ok") {
  // Spawn a subprocess so an ASAN use-after-poison report shows up as a
  // non-zero exit + stderr dump rather than killing the test runner itself.
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    // Disable the external ASAN symbolizer: when the UAF fires it can wedge
    // on a broken pipe to llvm-symbolizer and the subprocess never exits,
    // turning a clear assertion failure into a test timeout.
    env: { ...bunEnv, ASAN_OPTIONS: "symbolize=0:abort_on_error=1:allow_user_segv_handler=1" },
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
