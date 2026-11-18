// Inserted only into the temporary hosted diagnostic test.
export function invitationStackCheckpoint(snapshot: unknown, address: bigint | undefined) {
  let debuggerExitCode: number | null = null;
  let debuggerSignal: string | null = null;
  let receipt: unknown;
  let errorCategory: string | undefined;
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
        "--attach-pid",
        String(process.pid),
        "--source",
        commands,
      ],
      { stdio: "ignore", timeout: 70_000 },
    );
    debuggerExitCode = child.status;
    debuggerSignal = child.signal;
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
        errorCategory,
        receipt,
      }) +
      "\n",
  );
}
