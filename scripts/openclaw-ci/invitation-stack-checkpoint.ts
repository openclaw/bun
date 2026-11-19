// Inserted only into the temporary hosted diagnostic test.
export function invitationStackCheckpoint(
  snapshot: unknown,
  address: bigint | undefined,
  attachOnly = false,
  identityReferences?: WeakRef<object>[],
  parseAddress?: (description: string) => bigint | undefined,
) {
  let debuggerExitCode: number | null = null;
  let debuggerSignal: string | null = null;
  let receipt: unknown;
  let errorCategory: string | undefined;
  let debuggerEvents: string[] = [];
  let debuggerPhase: string | undefined;
  let identity: unknown;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const root = process.env.OPENCLAW_INVITATION_STACK_ROOT;
    const commands = process.env.OPENCLAW_INVITATION_STACK_COMMANDS;
    const gdb = process.env.OPENCLAW_INVITATION_GDB === "1";
    if (!root || !commands || (!attachOnly && address === undefined))
      throw new Error("checkpoint-input");
    if (
      identityReferences &&
      (attachOnly || !gdb || !parseAddress || identityReferences.length > 16)
    )
      throw new Error("identity-input");
    const directory = fs.mkdtempSync(path.join(root, "worker-"));
    fs.writeFileSync(path.join(directory, "mode.txt"), attachOnly ? "attachment-only" : "stack", {
      mode: 0o600,
      flag: "wx",
    });
    const startTime = fs
      .readFileSync(`/proc/${process.pid}/stat`, "utf8")
      .split(") ")
      .at(-1)!
      .split(" ")[19];
    const data = JSON.stringify({
      pid: process.pid,
      revision: Bun.revision,
      startTime,
      address: address === undefined ? undefined : `0x${address.toString(16)}`,
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
        `OPENCLAW_INVITATION_STACK_ATTACH_ONLY=${attachOnly ? "1" : "0"}`,
        `OPENCLAW_INVITATION_STACK_IDENTIFY=${identityReferences ? "1" : "0"}`,
        "/usr/bin/prlimit",
        "--fsize=8388608:8388608",
        "--",
        "/usr/bin/timeout",
        "--kill-after=5s",
        "60s",
        ...(gdb
          ? [
              "/usr/bin/gdb",
              "--nx",
              "--quiet",
              "--batch",
              "-iex",
              "set auto-load off",
              "-iex",
              "set script-extension strict",
              "-iex",
              "set debuginfod enabled off",
              "-iex",
              "python import os,pathlib; pathlib.Path(os.environ['OPENCLAW_INVITATION_STACK_DIR'],'phase.txt').write_text('debugger-started')",
              "--pid",
              String(process.pid),
              "--command",
              commands,
            ]
          : [
              "/usr/bin/lldb",
              "--no-lldbinit",
              "--batch",
              "--one-line-before-file",
              "settings set plugin.jit-loader.gdb.enable off",
              "--one-line-before-file",
              "settings set target.preload-symbols false",
              "--one-line-before-file",
              "script import os,json; d=os.environ['OPENCLAW_INVITATION_STACK_DIR']; p=os.path.join(d,'attach.log'); lldb.debugger.HandleCommand('log enable -f ' + json.dumps(p) + ' gdb-remote packets'); st=os.stat(d); os.chown(p,st.st_uid,st.st_gid)",
              "--one-line-before-file",
              "script import os,pathlib; pathlib.Path(os.environ['OPENCLAW_INVITATION_STACK_DIR'],'phase.txt').write_text('debugger-started')",
              "--attach-pid",
              String(process.pid),
              "--source",
              commands,
            ]),
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
      "Error in sourced command file",
      "Python scripting is not supported",
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
    const parsedReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const publicKeys = new Set([
      "version",
      "attached",
      "detached",
      "captured",
      "diagnosticOnly",
      "qualifiesRepin",
      "jitModuleLoading",
      "limitation",
      "captureMode",
      "identityQualified",
      "executableSHA256",
      "snapshotCells",
      "mainThreadQualified",
      "omittedThreadCount",
      "frames",
      "framesCapped",
      "stackBytes",
      "matches",
      "registerMatches",
      "errorCategory",
      "detachErrorCategory",
    ]);
    if (Object.keys(parsedReceipt).some((key) => !publicKeys.has(key)))
      throw new Error("receipt-schema");
    receipt = parsedReceipt;
    if (identityReferences && parseAddress) {
      if (
        debuggerExitCode !== 0 ||
        debuggerSignal ||
        !parsedReceipt.captured ||
        !parsedReceipt.detached
      )
        throw new Error("identity-unsettled");
      const identitiesPath = path.join(directory, "function-identities.json");
      if (fs.statSync(identitiesPath).size > 16 * 1024) throw new Error("identity-budget");
      const data = JSON.parse(fs.readFileSync(identitiesPath, "utf8"));
      if (
        data.version !== 1 ||
        data.pid !== process.pid ||
        data.startTime !== startTime ||
        !Array.isArray(data.functions) ||
        data.functions.length > 96 ||
        !Array.isArray(parsedReceipt.snapshotCells)
      )
        throw new Error("identity-binding");
      const functions = new Map<string, string>();
      for (const item of data.functions) {
        if (
          typeof item.cell !== "string" ||
          !/^n\d{1,3}$/.test(item.cell) ||
          typeof item.address !== "string" ||
          !/^0x[0-9a-f]{1,16}$/.test(item.address) ||
          functions.has(item.address) ||
          !parsedReceipt.snapshotCells.some(
            (cell: { cell: string; class: string }) =>
              cell.cell === item.cell && cell.class === "Function",
          )
        )
          throw new Error("identity-cell");
        functions.set(item.address, item.cell);
      }
      const { jscDescribe } = require("bun:jsc") as typeof import("bun:jsc");
      identity = {
        version: 1,
        callbacks: identityReferences.map((reference, index) => {
          const value = reference.deref();
          if (!value) return { index, status: "collected", cells: [] };
          const pointer = parseAddress(jscDescribe(value));
          if (pointer === undefined) return { index, status: "unavailable", cells: [] };
          const cell = functions.get(`0x${pointer.toString(16)}`);
          return { index, status: cell ? "matched" : "unmatched", cells: cell ? [cell] : [] };
        }),
      };
    }
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
        identity,
      }) +
      "\n",
  );
}
