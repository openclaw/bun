import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [exeArg, sourceArg, outputArg, dumpTool, debuggerTool, symbolsArg] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert(exeArg && sourceArg && outputArg && dumpTool && debuggerTool && symbolsArg);
const exe = resolve(exeArg), source = resolve(sourceArg), output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const name = "wakes a parked worker for an immediate GC timer";
const file = "test/js/node/worker_threads/worker_threads.test.ts";
const code = readFileSync(join(source, file), "utf8");
const begin = code.indexOf(`  test.concurrent("${name}"`);
assert(begin >= 0);
assert.equal(createHash("sha256").update(code.slice(begin, code.indexOf("\n  test(", begin))).digest("hex"), "bad4f3c5c0bd81289843ce29719182dc536ecffc4b2c247e1882095c01f56efc");
// Keep the dump synthetic: the target must not inherit credentials or action tokens.
const allowed = /^(SystemRoot|WINDIR|SystemDrive|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|OS|PATHEXT|PATH)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
Object.assign(env, {
  BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1", BUN_GARBAGE_COLLECTOR_LEVEL: "1",
  BUN_JSC_randomIntegrityAuditRate: "1.0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  BUN_DEBUG_QUIET_LOGS: "1", NO_COLOR: "1", CI: "true",
});
env.PATH = `${dirname(exe)};${env.PATH ?? env.Path ?? ""}`;
const identity = spawnSync(exe, ["-p", "JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,arch:process.arch})"], { env, encoding: "utf8" });
assert.equal(identity.status, 0);
const info = { executable: exe, sha256: createHash("sha256").update(readFileSync(exe)).digest("hex"), runtime: JSON.parse(identity.stdout), caseHash: "bad4f3c5c0bd81289843ce29719182dc536ecffc4b2c247e1882095c01f56efc" };
const child = spawn(exe, ["test", file, "-t", name], { cwd: source, env, windowsHide: true });
let stdout = "", stderr = "", result;
child.stdout.on("data", data => { stdout += data; });
child.stderr.on("data", data => { stderr += data; });
child.on("error", error => { result = { error: error.message }; });
const completion = new Promise(resolveDone => child.on("close", (exitCode, signal) => { result = { ...result, exitCode, signal }; resolveDone(); }));
await delay(2500);
if (result === undefined) {
  const query = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object ProcessId,Name | ConvertTo-Json -Compress`], { encoding: "utf8" });
  writeFileSync(join(output, "child-query.log"), query.stdout + query.stderr);
  if (query.status === 0 && query.stdout.trim()) {
    const values = JSON.parse(query.stdout), children = Array.isArray(values) ? values : [values];
    const target = children.filter(item => /^bun(?:-profile)?\.exe$/i.test(item.Name));
    info.children = target;
    for (const item of target) {
      const dump = join(output, `child-${item.ProcessId}.dmp`);
      const captured = spawnSync(dumpTool, ["-accepteula", "-ma", String(item.ProcessId), dump], { encoding: "utf8", timeout: 30_000 });
      writeFileSync(join(output, "capture.log"), (captured.stdout ?? "") + (captured.stderr ?? ""));
      info.capture = { exitCode: captured.status, error: captured.error?.message };
      if (captured.status === 0 && debuggerTool !== "-") {
        // Correct PDBs only: a mismatched normal-build PDB must never be forced.
        const inspected = spawnSync(debuggerTool, ["-z", dump, "-y", symbolsArg, "-c", ".reload; lm; ~* kP; !runaway; q"], { encoding: "utf8", timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
        writeFileSync(join(output, "debugger.log"), (inspected.stdout ?? "") + (inspected.stderr ?? ""));
        info.debugger = { exitCode: inspected.status, error: inspected.error?.message };
      }
    }
  }
}
let watchdog;
await Promise.race([completion, new Promise(resolveWatchdog => { watchdog = setTimeout(() => {
  if (result === undefined) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    info.watchdog = true;
  }
  resolveWatchdog();
}, 35_000); })]);
clearTimeout(watchdog);
writeFileSync(join(output, "test.log"), stdout + stderr);
info.test = result;
writeFileSync(join(output, "probe.json"), JSON.stringify(info, null, 2) + "\n");
console.log(JSON.stringify(info));
