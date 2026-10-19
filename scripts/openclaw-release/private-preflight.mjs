import childProcess, { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = realpathSync(process.env.LAND175276_ROOT);
const source = realpathSync(process.env.LAND175276_CONSUMER);
function assertPrivate(candidate) {
  const part = relative(root, candidate);
  if (part === ".." || part.startsWith(".." + sep) || resolve(root, part) !== candidate)
    throw new Error("Unsafe acceptance path: " + candidate);
}
for (const key of ["TMPDIR", "TEMP", "TMP", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"])
  assertPrivate(realpathSync(process.env[key]));
const env = {
  ...process.env,
  NODE_OPTIONS: "",
  BUN_OPTIONS: "",
  TSX_TSCONFIG_PATH: join(source, "tsconfig.json"),
};
const script =
  'import {resolveManagedUpdateLeaseDatabasePath as resolve} from "./src/infra/update-managed-service-handoff-lease.ts"; console.log(JSON.stringify({databasePath:resolve()}));';
// The probe imports the real resolver but never opens a handoff store. Clearing only
// its preload prevents recursion; its temp/state environment is the child's own.
const result = spawnSync(
  process.execPath,
  ["--import", pathToFileURL(join(source, "scripts/tsx.mjs")).href, "--input-type=module", "-e", script],
  { cwd: source, env, encoding: "utf8", timeout: 60000 },
);
if (result.error || result.status !== 0 || result.signal)
  throw new Error("Private source resolver failed: " + (result.error ?? result.stderr));
const { databasePath } = JSON.parse(result.stdout.trim());
const database = existsSync(databasePath)
  ? realpathSync(databasePath)
  : join(realpathSync(dirname(databasePath)), databasePath.split(/[\\/]/).pop());
assertPrivate(database);
writeFileSync(
  join(root, "preflights", process.pid + "-" + randomUUID() + ".json"),
  JSON.stringify(
    {
      pid: process.pid,
      ppid: process.ppid,
      executable: process.execPath,
      argv: process.argv,
      databasePath,
      resolved: database,
      source,
      tmpdir: process.env.TMPDIR,
      node: process.version,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);

// Fresh env objects must not drop the private resolver gate on descendant runtimes.
const privateKeys = [
  "LAND175276_ROOT",
  "LAND175276_CONSUMER",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
];
const inherited = Object.fromEntries(privateKeys.map(key => [key, process.env[key]]));
const preload = pathToFileURL(fileURLToPath(import.meta.url)).href;
function childOptions(options = {}) {
  const env = {
    ...inherited,
    ...(options.env ?? process.env),
    LAND175276_CONSUMER: source,
  };
  env.LAND175276_ROOT ??= root;
  assertPrivate(realpathSync(env.LAND175276_ROOT));
  for (const [key, flag] of [
    ["NODE_OPTIONS", "--import="],
    ["BUN_OPTIONS", "--preload="],
  ]) {
    if (!env[key]?.includes(flag + preload)) env[key] = ((env[key] ?? "") + " " + flag + preload).trim();
  }
  return { ...options, env };
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    const index = Array.isArray(args[1]) ? 2 : 1;
    if (typeof args[index] === "function") args.splice(index, 0, childOptions());
    else args[index] = childOptions(args[index]);
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();
if (globalThis.Bun) {
  for (const name of ["spawn", "spawnSync"]) {
    const original = Bun[name];
    Bun[name] = function (command, options) {
      return Array.isArray(command)
        ? original.call(this, command, childOptions(options))
        : original.call(this, childOptions(command));
    };
  }
}
