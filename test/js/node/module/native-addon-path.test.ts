import { expect, test } from "bun:test";
import { bunEnv, bunExe, canBuildNodeAddons, tempDir } from "harness";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

test("native addon loading namespaces the disk path without changing the module cache key", async () => {
  using dir = tempDir("native-addon-path", {
    [`${"x".repeat(100)}/${"y".repeat(100)}/addon.node`]: "",
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

test.skipIf(!canBuildNodeAddons())(
  "N-API module URLs identify the addon after namespaced loading",
  async () => {
    using dir = tempDir("native-addon-url", {
      "addon.c": `
        #define NAPI_EXPERIMENTAL
        #include <node_api.h>

        static napi_value filename(napi_env env, napi_callback_info info) {
          const char *path = NULL;
          if (node_api_get_module_file_name(env, &path) != napi_ok || path == NULL) {
            napi_throw_error(env, NULL, "Cannot get module filename");
            return NULL;
          }
          napi_value result;
          napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &result);
          return result;
        }

        NAPI_MODULE_INIT() {
          napi_value fn;
          napi_create_function(env, "filename", NAPI_AUTO_LENGTH, filename, NULL, &fn);
          napi_set_named_property(env, exports, "filename", fn);
          return exports;
        }
      `,
      "binding.gyp": JSON.stringify({ targets: [{ target_name: "addon", sources: ["addon.c"] }] }),
      "package.json": JSON.stringify({
        name: "native-addon-url-test",
        version: "1.0.0",
        gypfile: true,
        scripts: { install: `${JSON.stringify(bunExe())} --bun node-gyp rebuild` },
        devDependencies: { "node-gyp": "^11.2.0" },
      }),
      "load.cjs": `
        const assert = require("node:assert/strict");
        const { toNamespacedPath } = require("node:path");
        const { fileURLToPath } = require("node:url");
        const filename = process.argv[2];
        let addon;
        if (process.argv[3] === "require") {
          addon = require(filename);
        } else {
          const module = { exports: {} };
          process.dlopen(module, toNamespacedPath(filename));
          addon = module.exports;
        }
        assert.equal(fileURLToPath(addon.filename()), filename);
        console.log("ok");
      `,
    });
    await using build = Bun.spawn({
      cmd: [bunExe(), "install"],
      cwd: dir,
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildOut, buildErr, buildExit] = await Promise.all([build.stdout.text(), build.stderr.text(), build.exited]);
    expect({ buildExit, error: buildExit ? buildOut + buildErr : "" }).toEqual({ buildExit: 0, error: "" });
    const addonDir = join(dir, "x".repeat(100), "y".repeat(100), "native # % é");
    mkdirSync(addonDir, { recursive: true });
    const addonPath = join(addonDir, "addon.node");
    copyFileSync(join(dir, "build", "Release", "addon.node"), addonPath);
    for (const mode of ["require", "direct"]) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), join(dir, "load.cjs"), addonPath, mode],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    }
  },
  180_000,
);

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
