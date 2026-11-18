// Inserted only into the temporary hosted diagnostic test.
export function invitationStackCheckpoint(snapshot: unknown, address: bigint | undefined) {
  let debuggerExitCode: number | null = null;
  let debuggerSignal: string | null = null;
  let receipt: unknown;
  let errorCategory: string | undefined;
  let debuggerEvents: string[] = [];
  let debuggerPhase: string | undefined;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const root = process.env.OPENCLAW_INVITATION_STACK_ROOT;
    const commands = process.env.OPENCLAW_INVITATION_STACK_COMMANDS;
    if (!root || !commands || address === undefined) throw new Error("checkpoint-input");
    const directory = fs.mkdtempSync(path.join(root, "worker-"));
    const startTime = fs
      .readFileSync(`/proc/${process.pid}/stat`, "utf8")
      .split(") ")
      .at(-1)!
      .split(" ")[19];
    const data = JSON.stringify({
      pid: process.pid,
      revision: Bun.revision,
      startTime,
      address: `0x${address.toString(16)}`,
      snapshot,
    });
    if (Buffer.byteLength(data) > 128 * 1024 * 1024) throw new Error("snapshot-budget");
    fs.writeFileSync(path.join(directory, "snapshot.json"), data, { mode: 0o600, flag: "wx" });
    const child = spawnSync(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/bin:/bin",
        `OPENCLAW_INVITATION_STACK_DIR=${directory}`,
        "/usr/bin/timeout",
        "--kill-after=5s",
        "60s",
        "/usr/bin/lldb",
        "--no-lldbinit",
        "--batch",
        "--one-line-before-file",
        "script import os,pathlib; pathlib.Path(os.environ['OPENCLAW_INVITATION_STACK_DIR'],'phase.txt').write_text('debugger-started')",
        "--attach-pid",
        String(process.pid),
        "--source",
        commands,
      ],
      { encoding: "utf8", timeout: 70_000, maxBuffer: 1024 * 1024 },
    );
    debuggerExitCode = child.status;
    debuggerSignal = child.signal;
    const output = (child.stdout ?? "") + (child.stderr ?? "");
    fs.writeFileSync(path.join(directory, "debugger.log"), output, { mode: 0o600, flag: "wx" });
    debuggerEvents = [
      "attach failed",
      "Operation not permitted",
      "ptrace_scope",
      "unable to locate lldb-server",
      "not allowed to execute",
      "module importing failed",
      "Traceback (most recent call last)",
      "SyntaxError",
      "ModuleNotFoundError",
      "KeyError",
      "lost connection",
      "Connection refused",
      "Failed to attach",
      "error:",
    ].filter((event) => output.includes(event));
    const phasePath = path.join(directory, "phase.txt");
    if (fs.existsSync(phasePath) && fs.statSync(phasePath).size <= 64) {
      const phase = fs.readFileSync(phasePath, "utf8");
      if (
        [
          "debugger-started",
          "collector-entered",
          "identity-qualified",
          "snapshot-indexed",
          "frames-read",
          "memory-read",
          "detached",
        ].includes(phase)
      ) {
        debuggerPhase = phase;
      }
    }
    if (child.error) throw child.error;
    const receiptPath = path.join(directory, "receipt.json");
    if (fs.statSync(receiptPath).size > 64 * 1024) throw new Error("receipt-budget");
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (error) {
    errorCategory = error instanceof Error ? error.name : "Unknown";
  }
  process.stderr.write(
    "[invitation-stack] " +
      JSON.stringify({
        version: 1,
        parentContinued: true,
        debuggerExitCode,
        debuggerSignal,
        debuggerEvents,
        debuggerPhase,
        errorCategory,
        receipt,
      }) +
      "\n",
  );
}
