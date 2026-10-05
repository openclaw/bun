import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "node:path";

test("native addon loading namespaces the disk path without changing the module cache key", async () => {
  using dir = tempDir("native-addon-path", {
    [join("x".repeat(100), "y".repeat(100), "addon.node")]: "",
    "load.cjs": `
      const assert = require("node:assert/strict");
      const path = require("node:path");
      const filename = path.join(__dirname, "x".repeat(100), "y".repeat(100), "addon.node");
      const original = process.dlopen;
      let calls = 0;
      process.dlopen = (module, nativePath) => {
        calls++;
        assert.equal(nativePath, path.toNamespacedPath(filename));
        assert.equal(module.id, filename);
        module.exports.loaded = true;
      };
      try {
        const first = require(filename);
        assert.deepEqual(first, { loaded: true });
        assert.equal(require(filename), first);
        assert.equal(require.resolve(filename), filename);
        assert.equal(require.cache[filename].exports, first);
        assert.equal(calls, 1);
      } finally {
        process.dlopen = original;
      }
      console.log("ok");
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), join(dir, "load.cjs")],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
});

test("compiled native addons keep their virtual extraction path", async () => {
  using dir = tempDir("embedded-native-addon-path", {
    "addon.node": "native addon fixture",
    "load.cjs": `
      const assert = require("node:assert/strict");
      let calls = 0;
      process.dlopen = (module, filename) => {
        calls++;
        const prefix = process.platform === "win32" ? "B:/~BUN/" : "/$bunfs/";
        assert.ok(filename.startsWith(prefix), filename);
        module.exports.loaded = true;
      };
      assert.deepEqual(require("./addon.node"), { loaded: true });
      assert.equal(calls, 1);
      console.log("ok");
    `,
  });
  const executable = join(dir, "compiled" + (process.platform === "win32" ? ".exe" : ""));
  await using build = Bun.spawn({
    cmd: [bunExe(), "build", join(dir, "load.cjs"), "--compile", "--outfile", executable],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [buildOut, buildErr, buildExit] = await Promise.all([build.stdout.text(), build.stderr.text(), build.exited]);
  expect({ buildExit, error: buildExit ? buildOut + buildErr : "" }).toEqual({ buildExit: 0, error: "" });
  await using proc = Bun.spawn({ cmd: [executable], env: bunEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
});
