import { dlopen, FFIType } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isMusl, isWindows, tempDir } from "harness";
import fs from "node:fs";
import { join } from "node:path";

// Cross-platform Bun.Terminal + Bun.spawn integration tests that don't rely
// on POSIX-only behaviour (termios echo, SIGWINCH, cat/echo binaries). The
// remaining POSIX-specific coverage lives in terminal.test.ts.
describe("Bun.Terminal subprocess integration", () => {
  test("constructor creates a PTY", async () => {
    await using terminal = new Bun.Terminal({});
    expect(terminal.closed).toBe(false);
  });

  test("constructor with custom size", async () => {
    await using terminal = new Bun.Terminal({ cols: 120, rows: 40 });
    expect(terminal.closed).toBe(false);
  });

  test("write returns byte count", async () => {
    await using terminal = new Bun.Terminal({});
    expect(terminal.write("hello")).toBe(5);
    expect(terminal.write("")).toBe(0);
    expect(terminal.write(new TextEncoder().encode("abc"))).toBe(3);
  });

  // The streaming writer buffers whatever it can't flush synchronously, so
  // write() must report the full input as accepted. Before the fix it returned
  // the synchronously-flushed count (~12-14KB on a PTY), and a caller that
  // re-sent the "unwritten" tail duplicated stdin on the child. ConPTY injects
  // escape sequences into the byte stream so exact counting is POSIX-only.
  test.skipIf(isWindows)("write returns the full input length when the PTY buffer fills", async () => {
    const N = 128 * 1024;
    const childSrc = `
      let buf = Buffer.alloc(0);
      process.stdin.on("data", d => {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf(0);
        if (idx >= 0) {
          process.stdout.write("CHILD_READ " + idx + "\\n");
          process.exit(0);
        }
      });
      process.stdout.write("READY\\n");
    `;

    let output = "";
    let drainCount = 0;
    const ready = Promise.withResolvers<void>();
    const done = Promise.withResolvers<string>();
    const drained = Promise.withResolvers<void>();

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", childSrc],
      env: bunEnv,
      terminal: {
        data(_t, chunk) {
          output += new TextDecoder().decode(chunk);
          if (output.includes("READY")) ready.resolve();
          const m = output.match(/CHILD_READ (\d+)/);
          if (m) done.resolve(m[1]);
        },
        drain() {
          drainCount++;
          drained.resolve();
        },
        exit() {
          const err = new Error("terminal exit; output=" + JSON.stringify(output));
          ready.reject(err);
          done.reject(err);
          drained.reject(err);
        },
      },
    });
    const terminal = proc.terminal!;
    terminal.setRawMode(true);

    await ready.promise;

    // A single write that overflows the kernel PTY buffer: the writer accepts
    // everything (buffering the tail), so the return must be the input length.
    const payload = Buffer.alloc(N, 65);
    const r1 = terminal.write(payload);
    expect(r1).toBe(N);

    // Second write while the first is still buffered: must also return its own
    // input length (previously could include bytes drained from the first).
    const r2 = terminal.write(Buffer.alloc(64, 66));
    expect(r2).toBe(64);

    // Terminator so the child can report without a timeout.
    terminal.write(new Uint8Array([0]));

    // Child must receive exactly N + 64 bytes before the terminator.
    const childRead = Number(await done.promise);
    expect(childRead).toBe(N + 64);

    // Buffered data was drained to reach the child, so drain must have fired.
    await drained.promise;
    expect(drainCount).toBeGreaterThan(0);

    await proc.exited;
    terminal.close();
  });

  test("resize succeeds", async () => {
    await using terminal = new Bun.Terminal({ cols: 80, rows: 24 });
    expect(() => terminal.resize(100, 30)).not.toThrow();
    expect(() => terminal.resize(40, 10)).not.toThrow();
  });

  test("close marks terminal closed and write throws", () => {
    const terminal = new Bun.Terminal({});
    terminal.close();
    expect(terminal.closed).toBe(true);
    expect(() => terminal.write("x")).toThrow();
    expect(() => terminal.resize(10, 10)).toThrow();
  });

  test.skipIf(!isWindows)("termios flag accessors return 0 on Windows", async () => {
    await using terminal = new Bun.Terminal({});
    expect(terminal.inputFlags).toBe(0);
    expect(terminal.outputFlags).toBe(0);
    expect(terminal.localFlags).toBe(0);
    expect(terminal.controlFlags).toBe(0);
  });

  test("data callback receives output from spawned process", async () => {
    let output = "";
    let callbackTerminal: Bun.Terminal | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(term, chunk: Uint8Array) {
        callbackTerminal = term;
        output += new TextDecoder().decode(chunk);
        if (output.includes("hello-from-conpty")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "console.log('hello-from-conpty')"],
      env: bunEnv,
      terminal,
    });

    await promise;
    await proc.exited;
    terminal.close();

    expect(callbackTerminal).toBe(terminal);
    expect(output).toContain("hello-from-conpty");
  });

  test("subprocess sees a TTY on stdout", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(_term, chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk);
        if (output.includes("isTTY=")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "process.stdout.write('isTTY=' + process.stdout.isTTY)"],
      env: bunEnv,
      terminal,
    });

    await promise;
    await proc.exited;
    terminal.close();

    expect(output).toContain("isTTY=true");
  });

  test("Bun.spawn with inline terminal option", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "console.log('inline-terminal')"],
      env: bunEnv,
      terminal: {
        cols: 80,
        rows: 24,
        data(_term, chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk);
          if (output.includes("inline-terminal")) resolve();
        },
      },
    });

    expect(proc.terminal).toBeDefined();
    expect(proc.stdin).toBeNull();
    expect(proc.stdout).toBeNull();
    expect(proc.stderr).toBeNull();

    await promise;
    await proc.exited;
    proc.terminal?.close();

    expect(output).toContain("inline-terminal");
  });

  test("terminal.write reaches subprocess stdin", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(_term, chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk);
        if (output.includes("ECHO:abc")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `process.stdin.setEncoding('utf8');
         process.stdin.on('data', d => { process.stdout.write('ECHO:' + d); process.exit(0); });`,
      ],
      env: bunEnv,
      terminal,
    });

    terminal.write("abc\r");
    await promise;
    await proc.exited;
    terminal.close();

    expect(output).toContain("ECHO:abc");
  });

  test("subprocess sees correct terminal dimensions", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 123,
      rows: 45,
      data(_term, chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk);
        if (output.includes("cols=")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "process.stdout.write('cols=' + process.stdout.columns + ' rows=' + process.stdout.rows)"],
      env: bunEnv,
      terminal,
    });

    await promise;
    await proc.exited;
    terminal.close();

    expect(output).toContain("cols=123");
    expect(output).toContain("rows=45");
  });

  test("exit callback fires after close", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const terminal = new Bun.Terminal({
      exit() {
        resolve();
      },
    });
    terminal.close();
    await promise;
  });

  test("can create and close many terminals", () => {
    for (let i = 0; i < 20; i++) {
      const t = new Bun.Terminal({ cols: 80, rows: 24 });
      t.close();
      expect(t.closed).toBe(true);
    }
  });

  // termios c_lflag bit layout is platform-specific. These match sys/termios.h:
  // Linux uses the "System V" layout; Darwin/BSD share the "4.3BSD" layout.
  const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
  const ECHO = 0x8; // same on both

  // Regression: a Bun pipeline producer (stdout is a pipe, stdin/stderr are
  // TTYs) that never calls setRawMode must not write its startup termios
  // snapshot back to the terminal device at exit. The bug scenario is
  // literally `bun foo.js | less`: termios is a property of the /dev/pts/*
  // device, not the fd, so restoring here clobbers raw mode set on the same
  // device by the downstream consumer. See #29592.
  //
  // openpty via bun:ffi so we can wire stdin/stderr to the slave but keep
  // stdout as a pipe — exactly the `bun foo.js | less` shape that triggers
  // the bug.
  //
  //   glibc: openpty in libutil.so.1, termios in libc.so.6.
  //   musl:  everything in libc.musl-{x86_64,aarch64}.so.1.
  //   macOS: everything in libc.dylib; tcflag_t is `unsigned long` (8 bytes
  //          on LP64), so c_lflag sits at offset 24 instead of 12. The flag
  //          bits all fit in the low u32 on both platforms, so reading a
  //          u32 at the right offset round-trips cleanly.
  test.skipIf(isWindows)("pipeline producer exit does not clobber raw mode on shared tty device", async () => {
    const LFLAG_OFFSET = process.platform === "darwin" ? 24 : 12;

    const openptyDecl = {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    } as const;
    const termiosDecls = {
      tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    } as const;

    // Musl and macOS both keep openpty + termios in a single libc. Only
    // glibc splits openpty out into libutil.
    const lib =
      process.platform === "darwin"
        ? dlopen("libc.dylib", { openpty: openptyDecl, ...termiosDecls })
        : isMusl
          ? dlopen(process.arch === "arm64" ? "libc.musl-aarch64.so.1" : "libc.musl-x86_64.so.1", {
              openpty: openptyDecl,
              ...termiosDecls,
            })
          : dlopen("libutil.so.1", { openpty: openptyDecl });
    const libc = process.platform === "darwin" || isMusl ? lib : dlopen("libc.so.6", termiosDecls);

    const masterBuf = new Int32Array(1);
    const slaveBuf = new Int32Array(1);
    expect(lib.symbols.openpty(masterBuf, slaveBuf, null, null, null)).toBe(0);
    const master = masterBuf[0];
    const slave = slaveBuf[0];

    // termios struct size:
    //   Linux  = 60 (4× u32 flags + u8 c_line + 32 cc + 3 pad + 2× u32 speed)
    //   Darwin = 72 (4× u64 flags + 20 cc + pad + 2× u64 speed)
    // 128 is generous on both platforms.
    const termiosBuf = new Uint8Array(128);

    function getLflag(): number {
      expect(libc.symbols.tcgetattr(master, termiosBuf)).toBe(0);
      return new DataView(termiosBuf.buffer).getUint32(LFLAG_OFFSET, true);
    }

    function setLflag(value: number) {
      expect(libc.symbols.tcgetattr(master, termiosBuf)).toBe(0);
      new DataView(termiosBuf.buffer).setUint32(LFLAG_OFFSET, value, true);
      expect(libc.symbols.tcsetattr(master, 0, termiosBuf)).toBe(0);
    }

    try {
      // Assert the PTY starts cooked so the test can't pass vacuously.
      expect(getLflag() & ICANON).not.toBe(0);
      expect(getLflag() & ECHO).not.toBe(0);

      const proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          // Child: stdout is a pipe (pipeline producer), stdin/stderr are
          // the PTY slave. Writes READY to stdout, then blocks on stdin
          // until the parent flips termios and tells us to exit.
          `process.stdout.write("READY\\n"); process.stdin.once("data", () => process.exit(0));`,
        ],
        env: bunEnv,
        stdin: slave,
        stdout: "pipe",
        stderr: slave,
      });

      // Wait for READY so we know the child is up and has finished
      // `bun_initialize_process` (the termios snapshot).
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = proc.stdout.getReader();
      while (!buffer.includes("READY")) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      reader.releaseLock();

      // Simulate `less` flipping the shared device to raw mode.
      setLflag(getLflag() & ~(ICANON | ECHO));
      expect(getLflag() & ICANON).toBe(0);
      expect(getLflag() & ECHO).toBe(0);

      // Release the child.
      fs.writeSync(master, "\n");
      const exitCode = await proc.exited;

      // Termios bits first: these are the regression.
      expect(getLflag() & ICANON).toBe(0);
      expect(getLflag() & ECHO).toBe(0);
      expect(exitCode).toBe(0);
    } finally {
      libc.symbols.close(master);
      libc.symbols.close(slave);
    }
  });

  // Companion: an interactive-wrapper case (stdout IS a TTY, like `bun run
  // vim` where the child may have taken termios raw and crashed) keeps the
  // unconditional restore. That's the `bun_restore_stdio` branch the
  // pipeline-producer gate does not apply to: after the child exits, the
  // parent's startup snapshot is written back so the shell comes back cooked.
  test.skipIf(isWindows)("interactive wrapper (stdout tty) restores cooked termios on child exit", async () => {
    const ready = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawReady = false;
    await using terminal = new Bun.Terminal({
      data(_, chunk: Uint8Array) {
        if (sawReady) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.includes("READY")) {
          sawReady = true;
          ready.resolve();
        }
      },
    });

    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);

    const proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        // Interactive wrapper: all three stdio are the PTY. The child
        // itself does not call setRawMode — but we flip termios from the
        // parent before the child exits, to simulate a TUI that set raw
        // mode via FFI/ioctl rather than through Bun__ttySetMode.
        `process.stdout.write("READY\\n"); process.stdin.once("data", () => process.exit(0));`,
      ],
      env: bunEnv,
      terminal,
    });

    await ready.promise;

    // Child took termios raw externally (simulated by the parent here).
    terminal.localFlags = terminal.localFlags & ~(ICANON | ECHO);
    expect(terminal.localFlags & ICANON).toBe(0);
    expect(terminal.localFlags & ECHO).toBe(0);

    terminal.write("\n");
    const exitCode = await proc.exited;

    // Because stdout is a TTY (interactive wrapper, not a pipeline
    // producer), bun_restore_stdio keeps the unconditional restore and
    // writes the cooked startup snapshot back. This matches the pre-PR
    // safety net for `bun run <tui>` after the TUI crashes.
    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);
    expect(exitCode).toBe(0);
  });

  // Companion to the regression test above: setRawMode still has its own
  // restore path via uv_tty_reset_mode's atexit hook. A child that actually
  // modifies termios must leave the device in its pre-setRawMode state.
  //
  // Handshake with the child across its entire lifetime so the assertions
  // distinguish the three cases we care about:
  //   1. child wrote raw → assert cooked before, raw while live, cooked after
  //   2. setRawMode became a no-op → "raw while live" assertion fails
  //   3. our bookkeeping skipped the restore → "cooked after" assertion fails
  test.skipIf(isWindows)("child that called setRawMode restores termios on exit", async () => {
    const raw = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawRaw = false;
    await using terminal = new Bun.Terminal({
      data(_, chunk: Uint8Array) {
        if (sawRaw) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.includes("RAW")) {
          sawRaw = true;
          raw.resolve();
        }
      },
    });

    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);

    // Child enters raw mode, announces it, then blocks on stdin so the
    // parent can observe termios state while the child is still alive.
    const proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `process.stdin.setRawMode(true); process.stdout.write("RAW\\n"); process.stdin.once("data", () => process.exit(0));`,
      ],
      env: bunEnv,
      terminal,
    });

    await raw.promise;
    expect(terminal.localFlags & ICANON).toBe(0);
    expect(terminal.localFlags & ECHO).toBe(0);

    terminal.write("\n");
    const exitCode = await proc.exited;
    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);
    expect(exitCode).toBe(0);
  });

  // Regression test for a Windows-only use-after-free: cancelling a stdin
  // stream while a cooked-mode console read was parked used to free the
  // reader's buffer immediately (finish() shrink / Drop). libuv's line reads
  // block a worker thread in ReadConsoleW and convert the result into the
  // alloc_cb buffer from that thread; uv_read_stop cancels asynchronously by
  // injecting a VK_RETURN, so the worker still wrote "\r\n" through the
  // stale pointer, corrupting whatever mimalloc handed the freed 8 KiB
  // block to next (a plausible mechanism for production reports of full-GC
  // crashes on clobbered ArrayBuffers). Fixed by serving tty reads from the
  // handle-owned uv::Tty::read_scratch. The child adopts the
  // previously-freed size class with ArrayBuffer probes and reports any
  // mutation.
  test.skipIf(!isWindows)("cancelling a parked console stdin read does not corrupt the heap", async () => {
    using dir = tempDir("conpty-stdin-read-cancel", {
      "child-fixture.ts": `
        const reader = Bun.stdin.stream().getReader();
        // Warm-up round-trip: arm a cooked-mode console line read and await
        // the line the parent writes once it sees CHILD-READY. Resolving
        // proves the whole line-read machinery (libuv worker thread
        // included) works end to end before cancellation is tested.
        const warmup = reader.read();
        console.log("CHILD-READY");
        await warmup;
        // Arm the read under test; no more input arrives, so the libuv
        // worker parks in ReadConsoleW holding the read buffer (pre-fix:
        // the reader's spare capacity; post-fix: the tty-owned scratch).
        reader.read().catch(() => {});
        // The park itself is unobservable from JS; there is no condition to
        // await. With the machinery proven warm above, a short delay makes
        // it overwhelmingly likely the worker is inside ReadConsoleW. If it
        // is not yet, cancellation traps the read before any write and the
        // run is vacuous rather than wrong.
        await Bun.sleep(150);
        await reader.cancel();
        // Immediately adopt the 8 KiB block the buggy teardown just freed;
        // mimalloc serves freshly freed blocks of a size class first.
        const probes: Uint8Array[] = [];
        for (let i = 0; i < 32; i++) {
          const probe = new Uint8Array(new ArrayBuffer(8192));
          probe.fill(0xaa);
          probes.push(probe);
        }
        // Bounded window for the cancelled console read's late write to land.
        const deadline = Date.now() + 600;
        let corrupted = false;
        while (Date.now() < deadline && !corrupted) {
          for (const probe of probes) {
            for (let i = 0; i < 64; i++) {
              if (probe[i] !== 0xaa) corrupted = true;
            }
          }
          Bun.gc(true);
          await Bun.sleep(20);
        }
        console.log(corrupted ? "PROBE-CORRUPTED" : "PROBE-CLEAN");
        process.exit(corrupted ? 42 : 0);
      `,
    });

    const ready = Promise.withResolvers<void>();
    const probeReported = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    let output = "";
    await using terminal = new Bun.Terminal({
      data(_, chunk: Uint8Array) {
        output += decoder.decode(chunk, { stream: true });
        if (output.includes("CHILD-READY")) ready.resolve();
        if (output.includes("PROBE-")) probeReported.resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "child-fixture.ts"],
      env: bunEnv,
      cwd: String(dir),
      terminal,
    });
    // Fail fast with the child's output if it dies before the handshake.
    proc.exited.then(code => ready.reject(new Error(`child exited before handshake: ${code}\n${output}`)));

    await ready.promise;
    terminal.write("warmup\r");

    const exitCode = await proc.exited;
    // The exit IOCP and the final ConPTY pipe-data IOCP are independent, so
    // the verdict line can arrive after proc.exited resolves. The child
    // prints PROBE-* before exit(0)/exit(42) on both paths, so the marker is
    // guaranteed to arrive for those codes; on any other exit (crash) the
    // marker may never come, so don't wait for it.
    if (exitCode === 0 || exitCode === 42) await probeReported.promise;
    expect(output).toContain("PROBE-CLEAN");
    expect(output).not.toContain("PROBE-CORRUPTED");
    expect(exitCode).toBe(0);
  });
});

describe("Bun.Terminal output flow control", () => {
  test.concurrent("pause inside data applies backpressure and resume is asynchronous", async () => {
    using dir = tempDir("terminal-flow", { progress: Buffer.alloc(4) });
    const progressPath = join(String(dir), "progress");
    const total = 4 * 1024 * 1024;
    const first = Promise.withResolvers<void>();
    const eof = Promise.withResolvers<void>();
    const chunks: Buffer[] = [];
    let callbacks = 0;
    let synchronous = false;
    let inResume = false;
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        const fs = require("node:fs");
        const fd = fs.openSync(${JSON.stringify(progressPath)}, "r+");
        const chunk = Buffer.alloc(256, 120);
        const progress = Buffer.alloc(4);
        for (let written = 0; written < ${total};) {
          written += fs.writeSync(1, chunk);
          progress.writeUInt32LE(written);
          fs.writeSync(fd, progress, 0, 4, 0);
        }
        fs.closeSync(fd);
        fs.writeSync(1, "FLOW_DONE");
      `,
      ],
      env: bunEnv,
      terminal: {
        data(terminal, data) {
          chunks.push(Buffer.from(data));
          callbacks++;
          synchronous ||= inResume;
          if (callbacks === 1) {
            terminal.pause();
            terminal.pause();
            first.resolve();
          }
        },
        exit() {
          first.reject(new Error("PTY exited before first data"));
          eof.resolve();
        },
      },
    });
    await using terminal = proc.terminal!;
    proc.exited.then(code => first.reject(new Error(`child exited before first data: ${code}`)));
    await first.promise;
    const received = chunks.reduce((n, chunk) => n + chunk.length, 0);
    let lastProgress = -1;
    let stableSince = performance.now();
    const deadline = stableSince + 3000;
    // A blocked write has no notification; require stable progress over a bounded polling window.
    while (performance.now() - stableSince < 100) {
      const progress = fs.readFileSync(progressPath).readUInt32LE();
      if (progress !== lastProgress) {
        lastProgress = progress;
        stableSince = performance.now();
      }
      expect(callbacks).toBe(1);
      expect(performance.now()).toBeLessThan(deadline);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(lastProgress).toBeGreaterThan(0);
    expect(lastProgress).toBeLessThan(total / 2);
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBe(received);
    inResume = true;
    terminal.resume();
    terminal.resume();
    inResume = false;
    await eof.promise;
    const output = Buffer.concat(chunks);
    // ConPTY renders a screen and injects control sequences; POSIX PTYs preserve these bytes exactly.
    if (isWindows) {
      expect(Bun.stripANSI(output.toString())).toContain("FLOW_DONE");
    } else {
      expect(output.equals(Buffer.concat([Buffer.alloc(total, 120), Buffer.from("FLOW_DONE")]))).toBe(true);
    }
    expect(synchronous).toBe(false);
    expect(fs.readFileSync(progressPath).readUInt32LE()).toBe(total);
    expect(await proc.exited).toBe(0);
    expect(terminal.pause()).toBeUndefined();
    expect(terminal.resume()).toBeUndefined();
  });

  test.concurrent("pause preserves the child output tail until asynchronous resume", async () => {
    using dir = tempDir("terminal-paused-tail", {});
    const writtenPath = join(String(dir), "written");
    const chunks: Buffer[] = [];
    const eof = Promise.withResolvers<void>();
    let exited = false;
    let inResume = false;
    let synchronous = false;
    let bytesAtExit = 0;
    // Keep the tail small enough to fit the kernel queue before the child exits.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        const fs = require("node:fs");
        fs.writeSync(1, Buffer.alloc(512, 120));
        fs.writeFileSync(${JSON.stringify(writtenPath)}, "written");
      `,
      ],
      env: bunEnv,
      terminal: {
        data(_terminal, data) {
          synchronous ||= inResume;
          chunks.push(Buffer.from(data));
        },
        exit() {
          exited = true;
          bytesAtExit = Buffer.concat(chunks).length;
          eof.resolve();
        },
      },
    });
    await using terminal = proc.terminal!;
    terminal.pause();
    terminal.pause();
    // macOS keeps the exiting session leader in exit until its PTY output drains.
    const deadline = performance.now() + 3000;
    while (!fs.existsSync(writtenPath)) {
      expect(performance.now()).toBeLessThan(deadline);
      if (proc.exitCode !== null && proc.exitCode !== 0) {
        throw new Error(`child failed before writing its tail: ${proc.exitCode}`);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(chunks).toHaveLength(0);
    expect(exited).toBe(false);
    inResume = true;
    terminal.resume();
    inResume = false;
    expect(chunks).toHaveLength(0);
    await eof.promise;
    const output = Buffer.concat(chunks);
    if (isWindows) {
      expect(Bun.stripANSI(output.toString()).replace(/[\r\n]/g, "")).toBe(Buffer.alloc(512, 120).toString());
    } else {
      expect(output.equals(Buffer.alloc(512, 120))).toBe(true);
    }
    expect(bytesAtExit).toBe(output.length);
    expect(synchronous).toBe(false);
    expect(await proc.exited).toBe(0);
  });

  test.concurrent("close and async disposal while paused", async () => {
    const terminal = new Bun.Terminal({});
    terminal.pause();
    terminal.close();
    expect(terminal.closed).toBe(true);
    expect(terminal.pause()).toBeUndefined();
    expect(terminal.resume()).toBeUndefined();
    terminal.close();
    const disposed = new Bun.Terminal({});
    disposed.pause();
    disposed.resume();
    disposed.pause();
    await disposed[Symbol.asyncDispose]();
    expect(disposed.closed).toBe(true);
  });

  test.concurrent.each([false, true])("pause preserves event-loop refness (unref=%s)", async unref => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        const terminal = new Bun.Terminal({});
        terminal.pause();
        ${unref ? "terminal.unref();" : "terminal.unref(); terminal.ref();"}
        process.on("beforeExit", () => {
          console.log("beforeExit");
          terminal.close();
        });
        // The unreferenced timer only runs if the paused terminal still keeps the loop alive.
        setTimeout(() => { console.log("kept alive"); terminal.close(); }, 20).unref();
      `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout).toBe(unref ? "beforeExit\n" : "kept alive\nbeforeExit\n");
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
});

// macOS can reject EVFILT_PROC while a PTY session leader is still draining in exit().
// Delay the real registration until exit starts; do not synthesize ESRCH.
test.skipIf(process.platform !== "darwin")("ESRCH while a terminal child exits does not block PTY reads", async () => {
  using dir = tempDir("terminal-esrch", {
    "delay-watch.c": `
#include <sys/event.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>

static int delayed_kevent64(int kq, const struct kevent64_s *changes, int count,
    struct kevent64_s *events, int capacity, unsigned int flags, const struct timespec *timeout) {
  for (int i = 0; i < count; i++) {
    if (changes[i].filter != EVFILT_PROC || !(changes[i].flags & EV_ADD)) continue;
    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
      struct proc_bsdinfo info;
      int size = proc_pidinfo((int)changes[i].ident, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
      if (size != sizeof(info) || (info.pbi_flags & PROC_FLAG_INEXIT)) break;
      clock_gettime(CLOCK_MONOTONIC, &now);
      if (now.tv_sec - start.tv_sec >= 2) break;
      struct timespec pause = {0, 100000};
      nanosleep(&pause, NULL);
    }
  }
  int result = kevent64(kq, changes, count, events, capacity, flags, timeout);
  if (result == -1 && errno == ESRCH) {
    int saved = errno;
    write(2, "ESRCH-before-reap\\n", 18);
    errno = saved;
  }
  return result;
}
__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } interpose = {
  (const void *)delayed_kevent64, (const void *)kevent64
};
`,
    "fixture.js": `
      let output = "";
      const proc = Bun.spawn(["/bin/sh", "-c", 'printf "%0512d" 0; exit 3'], {
        terminal: { data(_, bytes) { output += new TextDecoder().decode(bytes); } },
      });
      const code = await proc.exited;
      proc.terminal.close();
      console.log(JSON.stringify({ length: output.length, code }));
    `,
  });
  const library = `${dir}/delay-watch.dylib`;
  await using compiler = Bun.spawn({
    cmd: ["cc", "-dynamiclib", `${dir}/delay-watch.c`, "-o", library],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const compilerError = await compiler.stderr.text();
  expect(compilerError).toBe("");
  expect(await compiler.exited).toBe(0);
  await using proc = Bun.spawn({
    cmd: [bunExe(), `${dir}/fixture.js`],
    env: { ...bunEnv, DYLD_INSERT_LIBRARIES: library },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toContain("ESRCH-before-reap");
  expect(JSON.parse(stdout)).toEqual({ length: 512, code: 3 });
  expect(exitCode).toBe(0);
});
