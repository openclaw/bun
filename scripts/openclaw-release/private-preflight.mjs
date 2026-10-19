import childProcess, { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
  const prepared = { ...options };
  const env = { ...inherited };
  // Node includes enumerable prototype keys in options.env as well as own keys.
  const supplied = prepared.env || process.env;
  for (const key in supplied) env[key] = supplied[key];
  env.LAND175276_CONSUMER = source;
  env.LAND175276_ROOT ??= root;
  assertPrivate(realpathSync(env.LAND175276_ROOT));
  for (const [key, flag] of [
    ["NODE_OPTIONS", "--import="],
    ["BUN_OPTIONS", "--preload="],
  ]) {
    if (!env[key]?.includes(flag + preload)) env[key] = ((env[key] ?? "") + " " + flag + preload).trim();
  }
  return { ...prepared, env };
}
// Match the individual Node overloads; null/undefined argv does not consume the
// third argument. Leave invalid argv/options to the native API's own validator.
function argvOptions(args, callbackMode, nullableOptions) {
  const argv = args[1];
  let index;
  if (argv == null || Array.isArray(argv)) index = 2;
  else if (typeof argv === "object") index = 1;
  else if (callbackMode && typeof argv === "function") return [args[0], [], childOptions(), argv];
  else return args;
  const options = args[index];
  // execFileSync accepts a function in the argv slot, but not as options.
  if (callbackMode === "async" && typeof options === "function") {
    args[index] = childOptions();
    args[index + 1] = options;
    args.length = index + 2;
  } else if (
    options === undefined ||
    (nullableOptions && options === null) ||
    (options !== null && typeof options === "object" && !Array.isArray(options))
  )
    args[index] = childOptions(options ?? {});
  return args;
}
function shellOptions(args) {
  if (typeof args[1] === "function") return [args[0], childOptions(), args[1]];
  args[1] = childOptions(args[1] ?? {});
  return args;
}
for (const [name, prepare] of [
  ["spawn", args => argvOptions(args, false, false)],
  ["spawnSync", args => argvOptions(args, false, false)],
  ["fork", args => argvOptions(args, false, true)],
  ["execFile", args => argvOptions(args, "async", true)],
  ["execFileSync", args => argvOptions(args, "sync", true)],
  ["exec", shellOptions],
  ["execSync", shellOptions],
]) {
  const original = childProcess[name];
  const wrapped = function (...args) {
    return Reflect.apply(original, this, prepare(args));
  };
  if (name === "exec" || name === "execFile") {
    // The native custom closure calls the original function. Recreate its small
    // result/child/error contract around this wrapper so fresh envs stay gated.
    Object.defineProperty(wrapped, promisify.custom, {
      value: function (...args) {
        let resolve, reject;
        const promise = new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
        promise.child = wrapped(...args, (error, stdout, stderr) => {
          if (error !== null) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          } else resolve({ stdout, stderr });
        });
        return promise;
      },
    });
  }
  childProcess[name] = wrapped;
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
