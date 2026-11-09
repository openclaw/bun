// Temporary hosted reproduction of imported JSX/TSX module-format selection.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const binary = resolve("build/release/bun");
const folder = resolve("build/openclaw-ci/receiver-oracle/module-format");
const inputs = mkdtempSync(join(process.env.RUNNER_TEMP, "module-format-"));
mkdirSync(folder, { recursive: true });
mkdirSync(join(inputs, "pkg"));
mkdirSync(join(inputs, "node_modules/@types"), { recursive: true });
symlinkSync(resolve("packages/bun-types"), join(inputs, "node_modules/@types/bun"));
writeFileSync(join(inputs, "pkg/package.json"), '{"type":"module"}');
writeFileSync(join(inputs, "pkg/target.tsx"), "process.env.SEEN_DIRNAME = __dirname;\n");
writeFileSync(
  join(inputs, "entry.mjs"),
  'const imported = await import("./pkg/target.tsx"); console.log("default" in imported, typeof process.env.SEEN_DIRNAME);\n',
);
writeFileSync(
  join(inputs, "entry.cjs"),
  'const imported = require("./pkg/target.tsx"); console.log(Object.getPrototypeOf(imported) === Object.prototype, typeof process.env.SEEN_DIRNAME);\n',
);
const env = { ...process.env, BUN_AOT_VERBOSE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
delete env.BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER;
delete env.NODE_COMPILE_CACHE;
delete env.SEEN_DIRNAME;
const receipt = {
  nativeSource: "5cd0cffa4a84f8a9285fc8b55d98c3d1deabab58",
  probeSource: process.env.GITHUB_SHA,
  complete: false,
  runs: [],
};
const save = () => writeFileSync(join(folder, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
for (const entry of ["entry.mjs", "entry.cjs"]) {
  for (const aot of [false, true]) {
    const name = entry + (aot ? ".aot" : ".plain");
    const ran = spawnSync(
      "timeout",
      ["--kill-after=5s", "120s", binary, "run", ...(aot ? ["--debug-aot"] : []), entry],
      { cwd: inputs, env, encoding: "utf8", timeout: 135_000, maxBuffer: 8 * 1024 * 1024 },
    );
    writeFileSync(join(folder, name + ".stderr.log"), ran.stderr ?? "");
    receipt.runs.push({
      entry,
      aot,
      stdout: ran.stdout,
      stderr: (ran.stderr ?? "").replace(/^\[aot\] .*\r?\n/gm, ""),
      exitCode: ran.status,
      signal: ran.signal,
      error: ran.error?.message,
      imageUsed: /\[aot\] image: /.test(ran.stderr ?? ""),
    });
    save();
    if (ran.error) throw ran.error;
  }
}
receipt.complete = true;
save();
console.log(JSON.stringify(receipt));
for (const entry of ["entry.mjs", "entry.cjs"]) {
  const plain = receipt.runs.find(r => r.entry === entry && !r.aot);
  const aot = receipt.runs.find(r => r.entry === entry && r.aot);
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.stdout, entry === "entry.mjs" ? "false string\n" : "true string\n");
  assert.equal(aot.imageUsed, true, "in-place image must be used");
  assert.deepEqual(
    { stdout: aot.stdout, stderr: aot.stderr, exitCode: aot.exitCode, signal: aot.signal },
    { stdout: plain.stdout, stderr: plain.stderr, exitCode: plain.exitCode, signal: plain.signal },
  );
}
