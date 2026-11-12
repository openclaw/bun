// Hosted-only proof of the external ESM boundary from the retained plugin-alias repair.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const binary = resolve("build/release/bun");
const report = resolve("build/openclaw-ci/external-plugin-alias");
mkdirSync(report, { recursive: true });
const receipt = {
  nativeSource: "cd861bb9f53102e92e23ce28684c258055c7e612",
  engineSource: "651eeaca6e2792378928033b1ae7ac66d6f91eab",
  controllerSource: process.env.GITHUB_SHA,
  executableSHA256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  complete: false,
  shippingArchiveQualified: false,
  runs: [],
};
const save = () => writeFileSync(join(report, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
const inputs = mkdtempSync(join(process.env.RUNNER_TEMP, "external-plugin-alias-"));
mkdirSync(join(inputs, "node_modules/@types"), { recursive: true });
symlinkSync(resolve("packages/bun-types"), join(inputs, "node_modules/@types/bun"));
const files = {
  "bunfig.toml": '[install]\nauto = "disable"\n',
  "sdk.cjs": "exports.value = 42;\n",
  "external.mjs": 'import { value } from "uninstalled-package/sdk"; export { value };\n',
  "main.ts": String.raw`
import { createRequire } from "node:module";
import { join } from "node:path";
const resolutions: string[] = [];
Bun.plugin({
  name: "external-sdk-alias",
  setup(build) {
    build.onResolve({ filter: /^uninstalled-package\/sdk$/ }, args => {
      resolutions.push(args.path);
      return { path: join(process.cwd(), "sdk.cjs"), namespace: "file" };
    });
  },
});
const value = createRequire(import.meta.url)("./external.mjs").value;
console.log(JSON.stringify({ value, resolutions }));
`,
  "without-hook.mjs":
    'import { createRequire } from "node:module";\nconsole.log(createRequire(import.meta.url)("./external.mjs").value);\n',
};
receipt.fixtures = {};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(inputs, name), text);
  receipt.fixtures[name] = createHash("sha256").update(text).digest("hex");
}
save();
function execute(label, command, seconds = 120) {
  const ran = spawnSync("timeout", ["--kill-after=5s", seconds + "s", ...command], {
    cwd: inputs,
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", BUN_DEBUG_QUIET_LOGS: "1" },
    encoding: "utf8",
    timeout: (seconds + 15) * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(report, label + ".stdout.log"), ran.stdout ?? "");
  writeFileSync(join(report, label + ".stderr.log"), ran.stderr ?? "");
  const row = {
    label,
    stdout: ran.stdout,
    stderr: ran.stderr,
    exitCode: ran.status,
    signal: ran.signal,
    error: ran.error?.message,
  };
  receipt.runs.push(row);
  save();
  assert.ifError(ran.error);
  assert.equal(row.signal, null);
  return row;
}
const identity = execute("identity", [
  binary,
  "-p",
  "JSON.stringify({bun:Bun.revision,webkit:process.versions.webkit})",
]);
assert.equal(identity.exitCode, 0);
assert.deepEqual(JSON.parse(identity.stdout), { bun: receipt.nativeSource, webkit: receipt.engineSource });
const missing = execute("missing-hook-control", [binary, "without-hook.mjs"]);
assert.notEqual(missing.exitCode, 0);
assert.equal(missing.stdout, "");
assert.match(missing.stderr, /uninstalled-package/);
const expected = { stdout: '{"value":42,"resolutions":["uninstalled-package/sdk"]}\n', stderr: "", exitCode: 0 };
const outcome = row => ({ stdout: row.stdout, stderr: row.stderr, exitCode: row.exitCode });
assert.deepEqual(outcome(execute("ordinary", [binary, "main.ts"])), expected);
const executable = join(inputs, "program");
const built = execute(
  "compile",
  [binary, "build", "--compile", "--aot", "--external=./external.mjs", "main.ts", "--outfile", executable],
  240,
);
assert.equal(built.exitCode, 0, JSON.stringify(built));
assert.equal(readFileSync(executable).subarray(0, 4).toString("hex"), "7f454c46");
// The changed result proves this module still comes from disk after compilation.
const external = 'import { value as resolved } from "uninstalled-package/sdk"; export const value = resolved + 1;\n';
writeFileSync(join(inputs, "external.mjs"), external);
receipt.externalAfterCompileSHA256 = createHash("sha256").update(external).digest("hex");
assert.deepEqual(outcome(execute("standalone", [executable])), {
  ...expected,
  stdout: '{"value":43,"resolutions":["uninstalled-package/sdk"]}\n',
});
receipt.complete = true;
save();
console.log("Ordinary and standalone AOT external ESM imports reach the extensionless SDK alias hook.");
