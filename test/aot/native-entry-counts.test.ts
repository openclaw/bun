import { expect } from "bun:test";
import { test } from "./supported";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

async function run(cmd: string[], cwd: string, env: Record<string, string | undefined>) {
  await using child = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  return { stdout, stderr, exitCode };
}

function snapshot(path: string) {
  const lines = readFileSync(path, "utf8").split("\n");
  expect(lines.pop()).toBe("");
  const header = lines.shift()!.split("\t");
  expect(header.slice(0, 2)).toEqual(["# AOT-SNAPSHOT", "1"]);
  expect(header).toHaveLength(6);
  expect(header[5]).toBe("final");
  for (const value of header.slice(2, 5)) expect(value).toMatch(/^[1-9][0-9]*$/);
  expect(lines.pop()).toBe(`# END\t${header[4]}`);
  return { vm: Number(header[3]), pid: Number(header[2]), lines };
}

const workerFiles = {
  "main.mjs": `
import { Worker } from "node:worker_threads";
const workers = Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
  const worker = new Worker(new URL("./worker.mjs", import.meta.url));
  worker.on("error", reject);
  worker.on("exit", code => code === 0 ? resolve() : reject(new Error("worker exit " + code)));
}));
await Promise.all(workers);
Bun.gc(true);
console.log("all workers exited");
`,
  "worker.mjs": `
const objects = [];
for (let round = 0; round < 4; round++) {
  for (let i = 0; i < 1000; i++) objects.push({ value: i + round });
  Bun.gc(true);
}
if (objects.length !== 4000) throw new Error("missing objects");
`,
};

test("AOT snapshots preserve every worker VM and distinguish absent native instrumentation", async () => {
  using dir = tempDir("aot-worker-counter-snapshots", workerFiles);
  const cwd = String(dir);
  const executable = join(cwd, "main" + (isWindows ? ".exe" : ""));
  const build = await run([bunExe(), "build", "--compile", "--aot", "main.mjs", "worker.mjs", "--outfile", executable], cwd, bunEnv);
  expect({ stderr: build.stderr, exitCode: build.exitCode }).toEqual({ stderr: "", exitCode: 0 });
  const result = await run([executable], cwd, {
    ...bunEnv,
    BUN_DESTRUCT_VM_ON_EXIT: "1",
    BUN_JSC_crashIfInterpreterIsUsed: "1",
    BUN_JSC_useAOTOperationCounters: "1",
    BUN_JSC_aotTypeCoverageCountsPath: join(cwd, "counts-%p"),
  });
  expect(result).toEqual({ stdout: "all workers exited\n", stderr: "", exitCode: 0 });
  const files = readdirSync(cwd);
  const operations = files.filter(name => name.endsWith(".operations"));
  expect(operations).toHaveLength(4);
  expect(files.filter(name => name.endsWith(".tmp") || name.endsWith(".native-entries"))).toEqual([]);
  const snapshots = operations.map(name => snapshot(join(cwd, name)));
  expect(new Set(snapshots.map(value => value.pid)).size).toBe(1);
  expect(snapshots.map(value => value.vm).sort()).toEqual([1, 2, 3, 4]);
  for (const value of snapshots) {
    expect(value.lines.length).toBeGreaterThan(0);
    for (const line of value.lines) expect(line).toMatch(/^[0-9]+\t[^\t\n]+$/);
  }
}, 240_000);

test("native entry snapshots use image identities and exact body lengths for all VMs", async () => {
  using dir = tempDir("aot-native-entry-counts", workerFiles);
  const cwd = String(dir);
  const executable = join(cwd, "main" + (isWindows ? ".exe" : ""));
  const mapPath = join(cwd, "main.map");
  const build = await run([bunExe(), "build", "--compile", "--aot", "main.mjs", "worker.mjs", "--outfile", executable], cwd, {
    ...bunEnv,
    BUN_JSC_countAOTNativeEntries: "1",
    BUN_JSC_aotMapFilePath: mapPath,
  });
  expect({ stderr: build.stderr, exitCode: build.exitCode }).toEqual({ stderr: "", exitCode: 0 });
  const result = await run([executable], cwd, {
    ...bunEnv,
    BUN_DESTRUCT_VM_ON_EXIT: "1",
    BUN_JSC_crashIfInterpreterIsUsed: "1",
    BUN_JSC_aotTypeCoverageCountsPath: join(cwd, "native-%p-%v"),
  });
  expect(result).toEqual({ stdout: "all workers exited\n", stderr: "", exitCode: 0 });
  const native = readdirSync(cwd).filter(name => name.endsWith(".native-entries"));
  expect(native).toHaveLength(4);
  const bodies = new Map(readFileSync(mapPath, "utf8").split("\n").filter(line => line.startsWith("F\t")).map(line => {
    const fields = line.split("\t");
    return [Number(fields[1]), Number(fields[3])];
  }));
  expect(bodies.size).toBeGreaterThan(0);
  const snapshots = native.map(name => snapshot(join(cwd, name)));
  expect(snapshots.map(value => value.vm).sort()).toEqual([1, 2, 3, 4]);
  for (const value of snapshots) {
    const metadata = value.lines.shift()!.split("\t");
    expect(metadata[0]).toBe("image");
    expect(metadata[1]).toMatch(/^[0-9a-f]{40}$/i);
    expect(metadata[4]).toBe("complete");
    expect(Number(metadata[3])).toBe(bodies.size);
    expect(value.lines).toHaveLength(bodies.size);
    let entered = 0;
    for (const [index, line] of value.lines.entries()) {
      const [id, kind, bytes, count] = line.split("\t");
      expect(Number(id)).toBe(index);
      expect(["typed", "generic-typed", "untyped", "generic-untyped", "generated"]).toContain(kind);
      expect(Number(bytes)).toBe(bodies.get(index));
      expect(count).toMatch(/^[0-9]+$/);
      entered += Number(count);
    }
    expect(entered).toBeGreaterThan(0);
  }
}, 240_000);

test("native entries count a dynamically dispatched typed callback and leave uncalled bodies at zero", async () => {
  using dir = tempDir("aot-known-native-entry-counts", {
    "main.ts": `/// <reference path="./globals.d.ts" />
import { EventEmitter } from "node:events";
let total = 0;
function observed(value: number) { total += value; }
function neverCalled(value: number) { total -= value; }
const emitter = new EventEmitter();
emitter.on("counted", observed);
emitter.on("uncalled", neverCalled);
for (let i = 0; i < 37; i++) emitter.emit("counted", 2);
console.log(total);
Bun.gc(true);
`,
    "globals.d.ts": `
declare const console: { log(value: unknown): void };
declare const Bun: { gc(full?: boolean): void };
declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (value: number) => void): this;
    emit(event: string, value: number): boolean;
  }
}
`,
  });
  const cwd = String(dir);
  const executable = join(cwd, "main" + (isWindows ? ".exe" : ""));
  const mapPath = join(cwd, "main.map");
  const build = await run([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable], cwd, {
    ...bunEnv,
    BUN_JSC_countAOTNativeEntries: "1",
    BUN_JSC_aotMapFilePath: mapPath,
  });
  expect({ stderr: build.stderr, exitCode: build.exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(await run([executable], cwd, {
    ...bunEnv,
    BUN_DESTRUCT_VM_ON_EXIT: "1",
    BUN_JSC_crashIfInterpreterIsUsed: "1",
    BUN_JSC_aotTypeCoverageCountsPath: join(cwd, "counts"),
  })).toEqual({ stdout: "74\n", stderr: "", exitCode: 0 });
  const names = new Map(readFileSync(mapPath, "utf8").split("\n").filter(line => line.startsWith("F\t")).map(line => {
    const fields = line.split("\t");
    return [Number(fields[1]), fields[7]];
  }));
  const rows = snapshot(join(cwd, "counts-vm-1.native-entries")).lines.slice(1).map(line => line.split("\t"));
  const ofName = (name: string) => rows.filter(fields => names.get(Number(fields[0])) === name && fields[1] === "typed");
  const called = ofName("observed");
  const uncalled = ofName("neverCalled");
  expect(called.length).toBeGreaterThan(0);
  expect(uncalled.length).toBeGreaterThan(0);
  expect(called.reduce((sum, fields) => sum + Number(fields[3]), 0)).toBe(37);
  expect(uncalled.reduce((sum, fields) => sum + Number(fields[3]), 0)).toBe(0);
}, 240_000);
