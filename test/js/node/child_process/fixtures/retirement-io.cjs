// A blocked control-I/O callback must not hide an exited child or its ready pipe EOF.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { Socket } = require("node:net");
const [role, dir, node] = process.argv.slice(2);
const atomic = (name, data) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file + ".tmp", JSON.stringify(data));
  fs.renameSync(file + ".tmp", file);
};
const lines = (stream, onLine) => {
  let pending = "";
  stream.on("data", data => {
    pending += data.toString();
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      onLine(JSON.parse(line));
    }
  });
};
if (role === "--anchor") {
  setInterval(() => {}, 1000);
} else if (role === "--observer") {
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(dir, "observe.json"))) return;
    const input = JSON.parse(fs.readFileSync(path.join(dir, "observe.json"), "utf8"));
    try {
      process.kill(-input.anchorPid, 0);
    } catch (error) {
      if (process.platform === "darwin" && error.code === "EPERM") return;
      if (error.code !== "ESRCH") throw error;
      atomic("observed.json", { ...input, retiredAt: Date.now() });
      clearInterval(timer);
      process.exit(0);
    }
  }, 2);
  process.stdout.write("ready\n");
} else if (role === "--relay") {
  const anchor = spawn(node, [__filename, "--anchor"], { detached: true, stdio: "ignore" });
  const control = new Socket({ fd: 3, readable: true, writable: true });
  let acknowledged = false;
  let cancelling = false;
  const cancel = () => {
    if (cancelling) return;
    cancelling = true;
    if (!anchor.kill("SIGKILL")) process.exit(0);
  };
  process.on("SIGTERM", cancel);
  control.once("error", cancel);
  control.once("end", cancel);
  lines(control, message => {
    if (message.type === "close") {
      fs.writeSync(1, "stdout-final\n");
      fs.writeSync(2, "stderr-final\n");
      control.write(JSON.stringify({ type: "closing", result: 0 }) + "\n");
    } else if (message.type === "ack") {
      acknowledged = true;
      atomic("ack-seen.json", { at: Date.now() });
      anchor.kill("SIGTERM");
    }
  });
  anchor.once("spawn", () => control.write(JSON.stringify({ type: "ready", anchorPid: anchor.pid }) + "\n"));
  anchor.once("error", error => {
    throw error;
  });
  anchor.once("exit", () => {
    if (cancelling) process.exit(0);
    if (!acknowledged) throw new Error("anchor exited before acknowledgement");
    atomic("anchor-reaped.json", { at: Date.now() });
    // There are deliberately no fd3 writes after the acknowledgement.
    process.exit(0);
  });
} else {
  if (process.platform === "win32") throw new Error("POSIX process-group oracle");
  const nativeNode = process.env.PROBE_NODE;
  if (!nativeNode) throw new Error("PROBE_NODE must name the native fixture runtime");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-io-"));
  const started = Date.now();
  const events = [];
  const errors = [];
  const counts = {};
  const mark = (name, extra = {}) => {
    counts[name] = (counts[name] || 0) + 1;
    events.push({ name, ms: Date.now() - started, ...extra });
  };
  const record = (name, data) => {
    const file = path.join(root, name);
    fs.writeFileSync(file + ".tmp", JSON.stringify(data));
    fs.renameSync(file + ".tmp", file);
  };
  const read = name =>
    fs.existsSync(path.join(root, name)) ? JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) : null;
  let relay;
  let anchorPid;
  let deadline;
  let ackAt;
  let resumedAt;
  let observerSnapshot;
  let finished = false;
  let stdout = "";
  let stderr = "";
  const snapshot = () => ({
    exit: !!counts["relay-exit"],
    close: !!counts["relay-close"],
    fd3End: !!counts["fd3-end"],
    fd3Close: !!counts["fd3-close"],
    stdoutEnd: !!counts["stdout-end"],
    stderrEnd: !!counts["stderr-end"],
  });
  const observer = spawn(nativeNode, [__filename, "--observer", root], { stdio: ["ignore", "pipe", "pipe"] });
  observer.stderr.on("data", data => errors.push("observer: " + data));
  observer.on("error", error => errors.push(String(error)));
  observer.on("exit", code => {
    mark("observer-exit", { code });
    maybeFinish();
  });
  const watchdog = setTimeout(() => {
    errors.push("probe watchdog");
    finish();
  }, 5000);
  observer.stdout.once("data", () => {
    mark("observer-ready");
    relay = spawn(nativeNode, [__filename, "--relay", root, nativeNode], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    relay.on("error", error => errors.push(String(error)));
    relay.on("exit", (code, signal) => {
      mark("relay-exit", { code, signal });
      maybeFinish();
    });
    relay.on("close", (code, signal) => {
      mark("relay-close", { code, signal });
      maybeFinish();
    });
    for (const [name, stream] of [
      ["stdout", relay.stdout],
      ["stderr", relay.stderr],
      ["fd3", relay.stdio[3]],
    ]) {
      stream.on("end", () => mark(name + "-end"));
      stream.on("close", () => {
        mark(name + "-close");
        maybeFinish();
      });
      stream.on("error", error => errors.push(name + ": " + error));
    }
    relay.stdout.on("data", data => {
      stdout += data;
      mark("stdout-data");
    });
    relay.stderr.on("data", data => {
      stderr += data;
      mark("stderr-data");
    });
    lines(relay.stdio[3], message => {
      mark("fd3-" + message.type);
      if (message.type === "ready") {
        anchorPid = message.anchorPid;
        deadline = Date.now() + 100;
        setTimeout(() => {
          mark("deadline-timer", snapshot());
          setImmediate(() => {
            observerSnapshot = snapshot();
            mark("deadline-immediate", observerSnapshot);
            maybeFinish();
          });
        }, 100);
        relay.stdio[3].write(JSON.stringify({ type: "close" }) + "\n");
      } else if (message.type === "closing") {
        relay.stdio[3].write(JSON.stringify({ type: "ack" }) + "\n", error => {
          if (error) errors.push(String(error));
          ackAt = Date.now();
          record("observe.json", { anchorPid, ackAt });
          mark("ack-flushed");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
          resumedAt = Date.now();
          mark("host-resumed", { observation: read("observed.json"), anchorReaped: read("anchor-reaped.json") });
        });
      }
    });
  });
  function maybeFinish() {
    if (observerSnapshot && counts["relay-close"] && counts["fd3-close"] && counts["observer-exit"]) finish();
  }
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    const observed = read("observed.json");
    const ackSeen = read("ack-seen.json");
    const reaped = read("anchor-reaped.json");
    if (!(observed && ackAt <= observed.retiredAt && observed.retiredAt < deadline && deadline < resumedAt))
      errors.push("independent extinction deadline precondition failed");
    if (!(reaped && reaped.at < deadline)) errors.push("anchor not reaped before deadline");
    if (stdout !== "stdout-final\n" || stderr !== "stderr-final\n") errors.push("final output differs");
    for (const name of [
      "ack-flushed",
      "host-resumed",
      "relay-exit",
      "relay-close",
      "fd3-end",
      "fd3-close",
      "deadline-immediate",
    ]) {
      if (counts[name] !== 1) errors.push(name + " count " + (counts[name] || 0));
    }
    // This exact I/O-entry fixture's Node oracle exposes native exit and EOF
    // before the observer. Socket 'close' belongs to the later closing phase.
    if (
      !observerSnapshot?.exit ||
      !observerSnapshot?.fd3End ||
      !observerSnapshot?.stdoutEnd ||
      !observerSnapshot?.stderrEnd
    )
      errors.push("exit or readable EOF missing at deadline observer");
    const exit = events.find(event => event.name === "relay-exit");
    if (exit?.code !== 0 || exit?.signal !== null) errors.push("relay exit differs");
    console.log(
      JSON.stringify({
        runtime: process.version,
        bun: process.versions.bun || null,
        revision: typeof Bun === "undefined" ? null : Bun.revision,
        platform: process.platform,
        started,
        ackAt,
        deadline,
        resumedAt,
        observed,
        ackSeen,
        reaped,
        observerSnapshot,
        events,
        errors,
        passed: errors.length === 0,
      }),
    );
    observer.kill("SIGKILL");
    if (relay) relay.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(errors.length ? 1 : 0);
  }
}
