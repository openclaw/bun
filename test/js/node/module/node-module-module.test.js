import "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "fs";
import { bunEnv, bunExe, isWindows, normalizeBunSnapshot, ospath, tempDir } from "harness";
import Module, { _nodeModulePaths, builtinModules, createRequire, isBuiltin, stripTypeScriptTypes, wrap } from "module";
import path from "path";
import { Worker } from "worker_threads";

describe.concurrent("registerHooks Node 24 parity", () => {
  test.each([
    ...["plain", "base64", "short-circuit", "fragment-comma"].map(kind => [
      `data-missing-comma-${kind}`,
      '{"name":"TypeError","code":"ERR_INVALID_URL","message":"Invalid URL","input":true,"formats":[null]}',
    ]),
    ["data-missing-comma-source", '{"value":42,"formats":[null]}'],
    // Known JSC divergence: loadModule/moduleLoadTopSettled cannot separate builtin source overrides from in-flight records.
    [
      "builtin-inflight-override-deregister",
      '{"one":{"error":"ERR_MODULE_HOOK_REENTRANCY"},"two":{"value":"native"},"loads":2}',
    ],
    [
      "builtin-inflight-override-settled",
      '{"one":{"error":"ERR_MODULE_HOOK_REENTRANCY"},"two":{"value":"native"},"loads":2}',
    ],
    ["builtin-inflight-override-direct", '{"one":{"value":1},"two":{"error":"ERR_MODULE_HOOK_REENTRANCY"},"loads":2}'],
    [
      "builtin-inflight-override-outer",
      '{"one":{"error":"ERR_MODULE_HOOK_REENTRANCY"},"two":{"value":"native"},"loads":2}',
    ],
    [
      "builtin-inflight-override-inner",
      '{"one":{"value":"native"},"two":{"error":"ERR_MODULE_HOOK_REENTRANCY"},"loads":2}',
    ],
    ...["direct", "require-during-load"].map(kind => [
      `shared-builtin-${kind}`,
      '{"same":true,"events":[[null,{}],["builtin",null]]}',
    ]),
    ["shared-builtin-import-during-load", '{"same":true,"events":[[null,{}],[null,{}]]}'],
    ...["punctuation", "highbit", "padding", "length"].map(kind => [
      `data-base64-${kind}`,
      '{"name":"TypeError","code":"ERR_INVALID_URL","message":"Invalid URL","input":true}',
    ]),
    ...["whitespace", "unpadded"].map(kind => [`data-base64-${kind}`, "42"]),
    ...["import", "require"].map(kind => [
      `shared-request-diamond-${kind}`,
      '{"same":true,"loads":1,"resolutions":2,"factsEqual":true}',
    ]),
    ["shared-request-async-dependency", '{"same":true,"loads":1}'],
    ["shared-request-commonjs-self", '{"same":true,"value":42,"loads":1}'],
    // Known JSC divergence: loadModule/moduleLoadTopSettled cannot retain Node's two active-hook records.
    [
      "record-identity-active-identical",
      JSON.stringify({
        code: "ERR_MODULE_HOOK_REENTRANCY",
        message:
          'Cannot load "virtual:identical" while its module.registerHooks() fetch is in flight: JavaScriptCore cannot preserve per-request module record identity.',
        loads: 1,
      }),
    ],
    // Bun-internal modules bypass customization hooks and retain native import/require handoff.
    ...["sqlite", "jsc"].map(name => [`bun-internal-handoff-${name}`, '{"same":true,"intercepted":false}']),
    ...["upper", "mixed", "space", "mime", "json"].map(variant => [`data-header-${variant}`, "42"]),
    ["data-header-json-case-sensitive", "ERR_INVALID_RETURN_PROPERTY_VALUE"],
    ["data-query-source", "before?after"],
    ...["import", "require"].flatMap(kind =>
      ["module", "commonjs"].map(format => [`single-letter-scheme-${kind}-${format}`, "42"]),
    ),
    // Known divergence: Bun's single import/require registry reuses a completed record.
    // Node runs load again for require() and can return distinct CommonJS-request source ("outer").
    ["record-identity-completed-handoff", '{"values":["one","one"],"loads":1}'],
    // Known JSC divergence: hostLoadImportedModule repeats pending cycle edges before loadedModules is populated.
    ["static-cycle-import", '{"answer":42,"leafResolves":2}'],
    ["static-cycle-require", '{"answer":42,"leafResolves":2}'],
    // Known JSC divergence: hostLoadImportedModule chooses the registry type before host resolution.
    [
      "attributes-static-returned-identity",
      JSON.stringify({
        name: "Error",
        code: "ERR_MODULE_HOOK_ATTRIBUTE_IDENTITY",
        message:
          'Cannot apply resolve-returned type attributes to static import "<url>": JavaScriptCore selects the module registry type before calling module.registerHooks() resolve hooks.',
      }),
    ],
    [
      "attributes-static-wrong-type",
      JSON.stringify({
        code: "ERR_MODULE_HOOK_ATTRIBUTE_IDENTITY",
        message:
          'Cannot apply resolve-returned type attributes to static import "<url>": JavaScriptCore selects the module registry type before calling module.registerHooks() resolve hooks.',
        loads: 1,
      }),
    ],
    // Known JSC divergence: loadModule/moduleLoadTopSettled cannot retain separate same-key records.
    ...["dynamic-reentrant", "static-reentrant", "sync-handoff"].map(variant => [
      `record-identity-${variant}`,
      JSON.stringify({
        values: [variant === "static-reentrant" ? "outer" : "one", null],
        errors: [
          null,
          {
            name: "Error",
            code: "ERR_MODULE_HOOK_REENTRANCY",
            message:
              'Cannot load "virtual:parallel" while its module.registerHooks() fetch is in flight: JavaScriptCore cannot preserve per-request module record identity.',
          },
        ],
        loads: 1,
      }),
    ]),
    [
      "require-resolve-paths",
      '{"descriptor":[true,true,true],"scoped":true,"copied":true,"unbound":true,"builtin":true}',
    ],
    ["materialized-imports-cjs", '{"value":42,"retried":true}'],
    ["materialized-imports-esm", '{"value":42,"retried":true}'],
    ["commonjs-tla", "true"],
    ["bun-default-conditions", '["bun","node"]'],
    ...["resolve", "load"].map(kind => [`bun-transparent-json-${kind}`, "42"]),
    ...["resolve", "load", "both"].map(kind => [
      `bun-native-aliases-${kind}`,
      JSON.stringify([
        ...[
          "ws",
          "ws/lib/websocket",
          "next/dist/compiled/ws",
          "undici",
          "node-fetch",
          "isomorphic-fetch",
          "@vercel/fetch",
          "abort-controller",
        ].map(name => [name, name === "undici" ? "object" : "function", true]),
        ["utf-8-validate", true, true],
      ]),
    ]),
    [
      "attributes-reject-mismatch",
      '{"name":"TypeError","code":"ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE","message":"Module \\"<url>\\" is not of type \\"json\\""}',
    ],
    [
      "attributes-reject-missing",
      '{"name":"TypeError","code":"ERR_IMPORT_ATTRIBUTE_MISSING","message":"Module \\"<url>\\" needs an import attribute of \\"type: json\\""}',
    ],
    [
      "attributes-reject-key",
      '{"name":"TypeError","code":"ERR_IMPORT_ATTRIBUTE_UNSUPPORTED","message":"Import attribute \\"flavor\\" with value \\"wrong\\" is not supported in <url>"}',
    ],
    [
      "attributes-reject-value",
      '{"name":"TypeError","code":"ERR_IMPORT_ATTRIBUTE_UNSUPPORTED","message":"Import attribute \\"type\\" with value \\"javascript\\" is not supported in <url>"}',
    ],
    [
      "attributes-reject-number",
      '{"name":"TypeError","code":"ERR_INVALID_ARG_TYPE","message":"The \\"type\\" argument must be of type string. Received type number (42)"}',
    ],
    ["attributes-returned-identity", '{"same":true,"loads":1}'],
    ["attributes-nontype-identity", '{"same":true,"loads":1}'],
    [
      "concurrent-attributes",
      '{"seen":[["resolve",{"flavor":"one"}],["load",{"flavor":"one"}],["resolve",{"flavor":"two"}]],"values":["one","one"]}',
    ],
    ["self-deregister-format", "42"],
    ["redirect-load-json", '["json",42]'],
    ["redirect-load-mjs", '["module",42]'],
    ["redirect-load-package", '["module",42]'],
    ["data-percent", "1"],
    ["data-wasm-bytes", "170"],
    ["resolve-only-format", "42"],
    ["load-detection", '["module","module","module","module","commonjs","module-typescript"]'],
    ...[
      "require-cjs",
      "import-cjs",
      "require-esm",
      "import-esm",
      "require-esm-special",
      "require-json",
      "import-json",
    ].map(mode => [
      `builtin-override-${mode}`,
      mode === "import-cjs"
        ? '{"value":42,"same":true,"loads":2,"cached":true}'
        : '{"value":42,"same":true,"loads":1,"cached":false}',
    ]),
    ...["arraybuffer", "uint8array", "buffer"].map(mode => [`wasm-${mode}`, "170"]),
    ["parent", "nested"],
    ["conditions", "custom"],
    ["cli-conditions", "true"],
    ["cjs-source", "object"],
    ["cjs-transform", "43"],
    ["untyped-typescript-load", '{"value":42,"observed":["typescript","typescript","string"]}'],
    ["query", '{"same":false,"observed":["target.mjs?one","target.mjs?two"]}'],
    ["fragment", '{"same":false,"observed":["target.mjs#one","target.mjs#two"]}'],
    ...["dynamic", "static"].map(kind => [`empty-url-suffix-${kind}`, '{"distinct":4,"observed":["","?","#","?#"]}']),
    ["custom-scheme", "variant:one"],
    ["format-lifetime", "42"],
    ["attributes", '[["resolve",{"type":"json"}],["load",{"type":"json"}]]'],
    ["attributes-override", '[["resolve",{}],["load",{"type":"json"}]]'],
    ["meta-resolve", "true"],
    ["load-result-url", "true"],
    ["require-query", "true"],
    ["meta-parent-query", "true"],
    ["require-properties", "true"],
    ["source-formats", '["module-typescript","commonjs-typescript","module-typescript","module"]'],
    ["materialized-file", "42"],
    ["materialized-package", '{"root":1,"nested":2,"after":2}'],
    ["data-json", "42"],
  ])("%s", async (mode, expected) => {
    using dir = tempDir("register-hooks-parity", {});
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        ...(mode === "cli-conditions" ? ["--conditions=w73-custom"] : []),
        path.join(import.meta.dir, "register-hooks-parity.fixture.mjs"),
        mode,
        String(dir),
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout: stdout.trim(), stderr }).toEqual({ stdout: expected, stderr: "" });
    expect(exitCode).toBe(0);
  });
  // WebKit fb1167ebf2cb: JSModuleLoader::hostLoadImportedModule (:784) resolves without m_attributes.
  test.todo("static import attributes reach resolve and load hooks");
});

test("registerHooks builtin overrides belong to the requiring ModuleGraph", async () => {
  using dir = tempDir("hooks-builtin-graph", {
    "entry.mjs": 'export const value = require("node:zlib"); export const again = () => require("node:zlib");',
    "main.mjs": `
      import { registerHooks } from "node:module";
      const hook = registerHooks({ load(url, context, next) {
        return url === "node:zlib"
          ? { format: "commonjs", source: "module.exports = w73BuiltinTag;", shortCircuit: true }
          : next(url, context);
      }});
      const first = new Bun.ModuleGraph({ globals: { w73BuiltinTag: 42 } });
      const second = new Bun.ModuleGraph({ globals: { w73BuiltinTag: 43 } });
      try {
        const one = await first.import(import.meta.dir + "/entry.mjs");
        const two = await second.import(import.meta.dir + "/entry.mjs");
        Bun.gc(true);
        console.log(JSON.stringify([one.value, two.value, one.again(), two.again()]));
      } finally {
        first.dispose(); second.dispose(); hook.deregister();
      }
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), path.join(String(dir), "main.mjs")],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout: stdout.trim(), stderr }).toEqual({ stdout: "[42,43,42,43]", stderr: "" });
  expect(exitCode).toBe(0);
});

describe.concurrent("node-module-module", () => {
  test("builtinModules exists", () => {
    expect(Array.isArray(builtinModules)).toBe(true);
    // "bun:wrap" is no longer listed: it is internal transpiler plumbing,
    // not a requireable public module.
    expect(builtinModules).toHaveLength(76);
  });

  test("isBuiltin() works", () => {
    expect(isBuiltin("fs")).toBe(true);
    expect(isBuiltin("path")).toBe(true);
    expect(isBuiltin("crypto")).toBe(true);
    expect(isBuiltin("assert")).toBe(true);
    expect(isBuiltin("util")).toBe(true);
    expect(isBuiltin("events")).toBe(true);
    expect(isBuiltin("node:events")).toBe(true);
    expect(isBuiltin("node:bacon")).toBe(false);
    expect(isBuiltin("node:test")).toBe(true);
    expect(isBuiltin("test")).toBe(false); // "test" does not alias to "node:test"
  });

  test("syncBuiltinESMExports updates existing builtin bindings", async () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      import timersDefault, { setTimeout as esmSetTimeout } from "node:timers/promises";
      import fsDefault, { readFile as esmReadFile, readFileSync as esmReadFileSync } from "node:fs";
      import eventsDefault, { once as esmOnce } from "node:events";

      const require = createRequire(import.meta.url);
      const timers = require("node:timers/promises");
      const fs = require("node:fs");
      const events = require("node:events");
      assert.strictEqual(timersDefault, timers);
      assert.strictEqual(fsDefault, fs);
      assert.strictEqual(eventsDefault, events);

      const firstTimeout = () => "first timeout";
      const firstReadFile = () => "first read";
      const firstOnce = () => "first once";
      timers.setTimeout = firstTimeout;
      fs.readFile = firstReadFile;
      events.once = firstOnce;
      delete fs.readFileSync;
      fs.newAPI = () => "new";
      syncBuiltinESMExports();

      assert.strictEqual(esmSetTimeout, firstTimeout);
      assert.strictEqual(esmReadFile, firstReadFile);
      assert.strictEqual(esmReadFileSync, undefined);
      assert.strictEqual(esmOnce, firstOnce);
      const fsNamespace = await import("node:fs");
      assert.strictEqual("newAPI" in fsNamespace, false);

      const onceDescriptor = Object.getOwnPropertyDescriptor(events, "once");
      const sentinel = new Error("sync getter");
      Object.defineProperty(events, "once", {
        configurable: true,
        enumerable: onceDescriptor.enumerable,
        get() {
          throw sentinel;
        },
      });
      assert.throws(() => syncBuiltinESMExports(), error => error === sentinel);
      Object.defineProperty(events, "once", onceDescriptor);

      const secondTimeout = () => "second timeout";
      const secondReadFile = () => "second read";
      const secondOnce = () => "second once";
      timers.setTimeout = secondTimeout;
      fs.readFile = secondReadFile;
      events.once = secondOnce;
      syncBuiltinESMExports();
      syncBuiltinESMExports();
      assert.strictEqual(esmSetTimeout, secondTimeout);
      assert.strictEqual(esmReadFile, secondReadFile);
      assert.strictEqual(esmOnce, secondOnce);
      assert.strictEqual(timersDefault, timers);
      assert.strictEqual(fsDefault, fs);
      assert.strictEqual(eventsDefault, events);
      console.log("synced");
    `;

    await using proc = Bun.spawn({
      cmd: [bunExe(), "--eval", source],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "synced\n", stderr: "", exitCode: 0 });
  });

  test("syncBuiltinESMExports preserves CommonJS-first builtin loading", async () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const require = createRequire(import.meta.url);
      const timers = require("node:timers/promises");
      const replacement = () => "required first";
      timers.setTimeout = replacement;
      syncBuiltinESMExports();
      const namespace = await import("node:timers/promises");
      assert.strictEqual(namespace.default, timers);
      assert.strictEqual(namespace.setTimeout, replacement);
      console.log(namespace.setTimeout());
    `;

    await using proc = Bun.spawn({
      cmd: [bunExe(), "--eval", source],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "required first\n", stderr: "", exitCode: 0 });
  });

  test("syncBuiltinESMExports handles node-prefixed builtin names", async () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      import sqliteDefault, { DatabaseSync as esmDatabaseSync } from "node:sqlite";
      const require = createRequire(import.meta.url);
      const sqlite = require("node:sqlite");
      const replacement = () => "prefixed";
      assert.strictEqual(sqliteDefault, sqlite);
      sqlite.DatabaseSync = replacement;
      syncBuiltinESMExports();
      assert.strictEqual(esmDatabaseSync, replacement);
      console.log(esmDatabaseSync());
    `;

    await using proc = Bun.spawn({
      cmd: [bunExe(), "--eval", source],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "prefixed\n", stderr: "", exitCode: 0 });
  });

  test("syncBuiltinESMExports snapshots getters before updating bindings", async () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      import { access as esmAccess } from "node:fs";
      const require = createRequire(import.meta.url);
      const fs = require("node:fs");
      const originalAccess = esmAccess;
      const appendFileDescriptor = Object.getOwnPropertyDescriptor(fs, "appendFile");
      const sentinel = new Error("sync getter");
      fs.access = () => "replacement";
      Object.defineProperty(fs, "appendFile", {
        configurable: true,
        enumerable: appendFileDescriptor.enumerable,
        get() {
          throw sentinel;
        },
      });
      assert.throws(() => syncBuiltinESMExports(), error => error === sentinel);
      assert.strictEqual(esmAccess, originalAccess);
      console.log("unchanged");
    `;

    await using proc = Bun.spawn({
      cmd: [bunExe(), "--eval", source],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "unchanged\n", stderr: "", exitCode: 0 });
  });

  test("syncBuiltinESMExports updates builtin bindings in workers", async () => {
    const source = String.raw`
      const { parentPort } = require("node:worker_threads");
      const { syncBuiltinESMExports } = require("node:module");
      const timers = require("node:timers/promises");
      import("node:timers/promises").then(namespace => {
        const replacement = () => "worker";
        timers.setTimeout = replacement;
        syncBuiltinESMExports();
        const same = namespace.setTimeout === replacement;
        parentPort.postMessage({ same, value: same ? namespace.setTimeout() : "stale" });
      }, error => {
        throw error;
      });
    `;
    const worker = new Worker(source, { eval: true });
    const message = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const exited = new Promise((resolve, reject) => {
      worker.once("exit", resolve);
      worker.once("error", reject);
    });

    const [workerMessage, exitCode] = await Promise.all([message, exited]);
    expect(workerMessage).toEqual({ same: true, value: "worker" });
    expect(exitCode).toBe(0);
  });

  test("module.globalPaths exists", () => {
    expect(Array.isArray(require("module").globalPaths)).toBe(true);
  });

  test("Module._findPath propagates an error thrown by an onResolve plugin", async () => {
    // Plugins are process-global; run in a child so the throwing resolver can't affect other tests.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `Bun.plugin({ name: "throws", setup(b) { b.onResolve({ filter: /\\.findpathprobe$/ }, () => { throw new Error("onResolve threw"); }); } });
        try {
          console.log("returned", require("module")._findPath("thing.findpathprobe", [process.cwd()]));
        } catch (e) {
          console.log("threw", e.message);
        }`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim()).toBe("threw onResolve threw");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("Module.prototype is not enumerable", async () => {
    const Module = require("module");
    const { value, ...descriptor } = Object.getOwnPropertyDescriptor(Module, "prototype");
    expect(descriptor).toEqual({ writable: true, enumerable: false, configurable: false });
    expect(value).toBe(Module.prototype);
    expect(Object.keys(Module)).not.toContain("prototype");
    // and so, as in Node, it is not a named export of the ES module either
    const ns = await import("node:module");
    expect(Object.keys(ns)).not.toContain("prototype");
    expect(ns.default.prototype).toBe(Module.prototype);
  });

  // jest-runtime builds the `Module` it hands to tests this way. Assigning a class's `prototype` throws, so this
  // needs `prototype` to be non-enumerable; and the copy goes through the inherited `wrapper` / `_resolveFilename`
  // / `runMain` setters with their current values, which must not count as overriding them (an overridden wrapper
  // re-wraps every CommonJS module from source and bypasses the --isolate SourceProvider cache).
  test("Module's enumerable statics can be copied onto a subclass without overriding the CJS wrapper", async () => {
    using dir = tempDir("module-statics-copy", {
      "dep.cjs": `module.exports = "dep";`,
      "dep2.cjs": `module.exports = "dep2";`,
      "copy.test.js": `
        const { test, expect } = require("bun:test");
        const { isolatedModuleCacheSourceType } = require("bun:internal-for-testing");
        const Module = require("node:module");
        test("copy statics", () => {
          class Sub extends Module.Module {}
          for (const [key, value] of Object.entries(Module.Module)) Sub[key] = value;
          expect(Sub.prototype).toBeInstanceOf(Module);
          expect(Sub._extensions).toBe(Module._extensions);
          expect(Sub.wrapper[0]).toBe(Module.wrapper[0]);

          expect(require("./dep.cjs")).toBe("dep");
          expect(isolatedModuleCacheSourceType(require.resolve("./dep.cjs"))).toBe("Program");

          // A real override still takes effect (and such modules are not cached).
          Module.wrapper = ["(function(exports,require,module,__filename,__dirname){module.wrapped = true;", "})"];
          expect(require("./dep2.cjs")).toBe("dep2");
          expect(require.cache[require.resolve("./dep2.cjs")].wrapped).toBe(true);
          expect(isolatedModuleCacheSourceType(require.resolve("./dep2.cjs"))).toBe(null);
        });
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--isolate", "./copy.test.js"],
      env: { ...bunEnv, BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1" },
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout + stderr).toContain("1 pass");
    expect(exitCode).toBe(0);
  });

  test("module.enableCompileCache validates its argument", () => {
    expect(Module.enableCompileCache.length).toBe(1);
    for (const invalid of [0, null, false, 1, NaN, true, Symbol(0)]) {
      expect(() => Module.enableCompileCache(invalid)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    }
    expect(() => Module.enableCompileCache({ directory: 1 })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    // A function is not treated as an options bag (typeof === "object" in node).
    expect(() => Module.enableCompileCache(function () {})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    // A throwing getter propagates unchanged.
    expect(() =>
      Module.enableCompileCache({
        get directory() {
          throw new RangeError("boom");
        },
      }),
    ).toThrow(RangeError);
    // Node destructures `directory` then `portable` before validating, so a throwing
    // `portable` getter propagates even when `directory` is already invalid.
    const order = [];
    expect(() =>
      Module.enableCompileCache({
        get directory() {
          order.push("directory");
          return 42;
        },
        get portable() {
          order.push("portable");
          throw new RangeError("portable boom");
        },
      }),
    ).toThrow(new RangeError("portable boom"));
    expect(order).toEqual(["directory", "portable"]);
  });

  test("module.enableCompileCache accepts valid shapes", async () => {
    // Run in a child so enabling the cache doesn't affect this test process.
    using dir = tempDir("compile-cache-shapes", {});
    const cacheDir = JSON.stringify(path.join(String(dir), "cc"));
    // Valid shapes: string | {directory?, portable?} | undefined. The first
    // call enables the cache; the rest report ALREADY_ENABLED.
    const code = `
      const Module = require("module");
      const { ENABLED, ALREADY_ENABLED } = Module.constants.compileCacheStatus;
      const shapes = [
        ${cacheDir},
        undefined,
        {},
        [],
        Object.create(null),
        { directory: ${cacheDir} },
        { directory: undefined },
      ];
      for (const shape of shapes) {
        const r = Module.enableCompileCache(shape);
        if (r.status !== ENABLED && r.status !== ALREADY_ENABLED) {
          console.error("unexpected status", r.status, JSON.stringify(r));
          process.exit(1);
        }
        if (typeof r.directory !== "string") {
          console.error("missing directory", JSON.stringify(r));
          process.exit(1);
        }
      }
      console.log("shapes-ok");
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", code],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim()).toBe("shapes-ok");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.skipIf(process.platform === "win32")(
    "compile cache persists modules loaded after a non-fatal self-kill",
    async () => {
      // A self-directed signal that proves non-fatal (SIGWINCH is ignored by
      // default) must not latch the exit-time persist: modules loaded after
      // the kill still reach the cache when the process really exits.
      using dir = tempDir("compile-cache-selfkill", {
        "late.js": "module.exports = 42;",
        "main.js": `process.kill(process.pid, "SIGWINCH");
console.log("survived", require("./late.js"));`,
      });
      const cacheDir = path.join(String(dir), "cc");
      await using proc = Bun.spawn({
        cmd: [bunExe(), "main.js"],
        env: { ...bunEnv, NODE_COMPILE_CACHE: cacheDir },
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout.trim()).toBe("survived 42");
      expect(exitCode).toBe(0);
      // Both main.js and late.js are cached; pre-fix only main.js was.
      const files = [...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })];
      expect(files.length).toBe(2);
    },
  );

  test.skipIf(!isWindows)("enableCompileCache default dir prefers TEMP over TMP like os.tmpdir", async () => {
    using dir = tempDir("compile-cache-tmporder", {});
    const temp = path.join(String(dir), "from-temp");
    const tmp = path.join(String(dir), "from-tmp");
    fs.mkdirSync(temp);
    fs.mkdirSync(tmp);
    const env = { ...bunEnv, TEMP: temp, TMP: tmp };
    delete env.NODE_COMPILE_CACHE;
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const r = require("module").enableCompileCache();
        console.log(JSON.stringify(r.directory));`,
      ],
      env,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toStartWith(path.join(temp, "node-compile-cache"));
    expect(exitCode).toBe(0);
  });

  test("compile cache entries are keyed by sha256 and accepted on re-run", async () => {
    using dir = tempDir("compile-cache-sha", {
      "main.js": `console.log(require("./dep.js"));`,
      "dep.js": "module.exports = 7;",
    });
    const cacheDir = path.join(String(dir), "cc");
    const env = { ...bunEnv, NODE_COMPILE_CACHE: cacheDir, NODE_DEBUG_NATIVE: "COMPILE_CACHE" };
    {
      await using proc = Bun.spawn({ cmd: [bunExe(), "main.js"], env, cwd: String(dir), stderr: "pipe" });
      const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
      expect(stdout.trim()).toBe("7");
      expect(exitCode).toBe(0);
    }
    // Entry names are the first 8 bytes of SHA256(type byte || path) in hex.
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })];
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(path.basename(f)).toMatch(/^[0-9a-f]{16}$/);
    }
    {
      await using proc = Bun.spawn({ cmd: [bunExe(), "main.js"], env, cwd: String(dir), stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout.trim()).toBe("7");
      // The second run accepts both entries from disk and rewrites nothing.
      expect(stderr).toContain("was accepted");
      expect(stderr).not.toContain("writing cache");
      expect(exitCode).toBe(0);
    }
  });

  test.skipIf(isWindows)("compile cache entries are created 0600 like Node", async () => {
    // Entries hold the module's post-transpile source, and the default cache
    // location is a world-readable tmpdir; Node creates entry files 0600.
    using dir = tempDir("compile-cache-mode", {
      "main.js": `process.umask(0o022); console.log(require("./dep.js"));`,
      "dep.js": "module.exports = 7;",
    });
    const cacheDir = path.join(String(dir), "cc");
    await using proc = Bun.spawn({
      cmd: [bunExe(), "main.js"],
      env: { ...bunEnv, NODE_COMPILE_CACHE: cacheDir },
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim()).toBe("7");
    expect(stderr).toBe("");
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })];
    expect(files.length).toBe(2);
    const modes = files.map(f => (fs.statSync(path.join(cacheDir, f)).mode & 0o777).toString(8));
    expect(modes).toEqual(["600", "600"]);
    expect(exitCode).toBe(0);
  });

  for (const mode of [
    "natural",
    "exit",
    ...(isWindows ? [] : ["SIGTERM", "SIGINT", "SIGHUP", "SIGUSR1", "SIGTERM-self", "SIGTERM-during-exit"]),
  ]) {
    test.serial(
      `compile cache persists correctly on ${mode} exit with uncached modules`,
      async () => {
        const signaled = mode.startsWith("SIG");
        const signalName = mode.split("-")[0];
        const selfSignal = mode === "SIGTERM-self";
        const duringExit = mode === "SIGTERM-during-exit";
        const bounded = ["SIGTERM", "SIGINT", "SIGHUP"].includes(signalName);
        const count = 2_000;
        const functions = Array.from({ length: 64 }, (_, i) => `function f${i}(x) { return x + ${i}; }`).join("\n");
        using dir = tempDir("compile-cache-exit-budget", {
          ...Object.fromEntries(
            Array.from({ length: count }, (_, i) => [`mod${i}.cjs`, `${functions}\nmodule.exports = f63(${i});`]),
          ),
          "main.cjs": `
          let sum = 0;
          for (let i = 0; i < ${count}; i++) sum += require("./mod" + i + ".cjs");
          if (sum !== ${((count - 1) * count) / 2 + count * 63}) throw new Error("wrong modules");
          const done = () => {
            require("node:fs").writeSync(1, Date.now() + "\\n");
            if (${JSON.stringify(mode)} !== "natural") process.exit(0);
          };
          if (${selfSignal}) {
            require("node:fs").writeSync(1, Date.now() + "\\n");
            process.kill(process.pid, "SIGTERM");
          } else if (${duringExit}) {
            process.on("SIGTERM", () => {});
            console.log("ready");
            done();
          } else if (${signaled}) {
            process.on(${JSON.stringify(signalName)}, () => setImmediate(done));
            setInterval(() => {}, 1000);
            console.log("ready");
          } else {
            done();
          }
        `,
        });
        const cacheDir = path.join(String(dir), "cc");
        await using proc = Bun.spawn({
          cmd: [bunExe(), "main.cjs"],
          cwd: String(dir),
          env: { ...bunEnv, NODE_COMPILE_CACHE: cacheDir, NODE_DISABLE_COMPILE_CACHE: undefined },
          stderr: "pipe",
        });
        let sentSignalAt;
        const stdoutPromise = (async () => {
          let text = "";
          for await (const chunk of proc.stdout) {
            text += Buffer.from(chunk).toString();
            if (signaled && !selfSignal && sentSignalAt === undefined && text.startsWith("ready\n")) {
              if (duringExit) {
                // No idle poll occurred: the first file proves the normal exit's persist began.
                const deadline = Date.now() + 5_000;
                while (![...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })].length) {
                  if (Date.now() >= deadline || proc.exitCode !== null) throw new Error("exit persistence never began");
                  await Bun.sleep(5);
                }
              }
              sentSignalAt = Date.now();
              proc.kill(signalName);
            }
          }
          return text;
        })();
        const [stdout, stderr, exitCode, exitedAt] = await Promise.all([
          stdoutPromise,
          proc.stderr.text(),
          proc.exited,
          proc.exited.then(() => Date.now()),
        ]);
        expect(stderr).toBe("");
        expect(stdout).toMatch(signaled && !selfSignal ? /^ready\n\d+\n$/ : /^\d+\n$/);
        const startedExit = Number(stdout.trim().split("\n").at(-1));
        // 250ms cache budget plus scheduler/ASAN/process-teardown slack; excludes module loading.
        if (bounded) expect(exitedAt - (sentSignalAt ?? startedExit)).toBeLessThan(1_500);
        expect(proc.signalCode).toBe(selfSignal ? "SIGTERM" : null);
        expect(exitCode).toBe(selfSignal ? 143 : 0);

        // Any published entry must be complete even if exit interrupted a generation/write.
        const files = [...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })].filter(f =>
          /^[0-9a-f]{16}$/.test(path.basename(f)),
        );
        expect(files.length).toBeGreaterThan(0);
        if (!bounded) expect(files.length).toBe(count + 1);
        const { createHash } = await import("node:crypto");
        for (const file of files) {
          const bytes = fs.readFileSync(path.join(cacheDir, file));
          expect(bytes.readUInt32LE(0)).toBe(0xb0bcace2);
          const sourceSize = bytes.readUInt32LE(4);
          const blobSize = bytes.readUInt32LE(8);
          const blobOffset = Math.ceil((76 + sourceSize) / 128) * 128;
          expect(bytes.length).toBe(blobOffset + blobSize);
          expect(
            createHash("sha256")
              .update(bytes.subarray(76, 76 + sourceSize))
              .digest(),
          ).toEqual(bytes.subarray(12, 44));
          expect(createHash("sha256").update(bytes.subarray(blobOffset)).digest()).toEqual(bytes.subarray(44, 76));
        }

        await using warm = Bun.spawn({
          cmd: [
            bunExe(),
            "-e",
            `
          for (let i = 0; i < ${count}; i++) require("./mod" + i + ".cjs");
          require("node:module").flushCompileCache();
          console.log("flushed");
        `,
          ],
          cwd: String(dir),
          env: {
            ...bunEnv,
            NODE_COMPILE_CACHE: cacheDir,
            NODE_DISABLE_COMPILE_CACHE: undefined,
            NODE_DEBUG_NATIVE: "COMPILE_CACHE",
          },
          stderr: "pipe",
        });
        const [warmOut, warmErr, warmExit] = await Promise.all([warm.stdout.text(), warm.stderr.text(), warm.exited]);
        expect(warmOut.trim()).toBe("flushed");
        expect(warmErr).toContain("was accepted");
        expect(warmExit).toBe(0);
        const complete = [...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })].filter(f =>
          /^[0-9a-f]{16}$/.test(path.basename(f)),
        );
        expect(complete.length).toBeGreaterThanOrEqual(count);
      },
      30_000,
    );
  }

  test.serial("compile cache waits for idle before background persistence", async () => {
    using dir = tempDir("compile-cache-background", { "dep.cjs": "module.exports = 42;" });
    const cacheDir = path.join(String(dir), "cc");
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        const fs = require("node:fs");
        const { getCompileCacheDir } = require("node:module");
        console.log(require("./dep.cjs"));
        // Simulate synchronous startup: background work must not start here.
        const busyUntil = Date.now() + 500;
        while (Date.now() < busyUntil) {}
        if (fs.readdirSync(getCompileCacheDir()).some(name => /^[0-9a-f]{16}$/.test(name))) {
          throw new Error("persisted during synchronous startup");
        }
        const deadline = Date.now() + 3000;
        const poll = setInterval(() => {
          if (fs.readdirSync(getCompileCacheDir()).some(name => /^[0-9a-f]{16}$/.test(name))) {
            clearInterval(poll);
            console.log("persisted while running");
          } else if (Date.now() > deadline) {
            process.exit(1);
          }
        }, 20);
      `,
      ],
      cwd: String(dir),
      env: { ...bunEnv, NODE_COMPILE_CACHE: cacheDir, NODE_DISABLE_COMPILE_CACHE: undefined },
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim()).toBe("42\npersisted while running");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.serial(
    "compile cache wakes an idle loop for deferred modules",
    async () => {
      const count = 2_000;
      const functions = Array.from({ length: 64 }, (_, i) => `function f${i}(x) { return x + ${i}; }`).join("\n");
      using dir = tempDir("compile-cache-deferred-idle", {
        ...Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`mod${i}.cjs`, `${functions}\nmodule.exports = f63(${i});`]),
        ),
        "late.cjs": "module.exports = 42;",
        "main.cjs": `
        for (let i = 0; i < ${count}; i++) require("./mod" + i + ".cjs");
        const timer = setInterval(() => {}, 1100);
        process.stdin.on("data", data => {
          if (data.toString().trim() === "late") {
            clearInterval(timer);
            if (require("./late.cjs") !== 42) throw new Error("late module");
            console.log("late");
          } else {
            console.log("complete");
            process.exit(0);
          }
        });
        console.log("ready");
      `,
      });
      const cacheDir = path.join(String(dir), "cc");
      const proc = Bun.spawn({
        cmd: [bunExe(), "main.cjs"],
        cwd: String(dir),
        env: {
          ...bunEnv,
          NODE_COMPILE_CACHE: cacheDir,
          NODE_DISABLE_COMPILE_CACHE: undefined,
          BUN_GC_TIMER_DISABLE: "1",
          BUN_IDLE_GC_SECONDS: "0",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const waitForPhase = async (promise, phase) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`compile cache ${phase} stalled (exitCode: ${proc.exitCode})`));
              }, 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        const ready = Promise.withResolvers();
        const stdoutPromise = (async () => {
          let text = "";
          for await (const chunk of proc.stdout) {
            text += Buffer.from(chunk).toString();
            if (text.startsWith("ready\n")) ready.resolve();
          }
          return text;
        })();
        const stderrPromise = proc.stderr.text();
        await waitForPhase(
          Promise.race([
            ready.promise,
            proc.exited.then(() => {
              throw new Error("exited before ready");
            }),
          ]),
          "module loading",
        );
        const files = () =>
          [...new Bun.Glob("**/*").scanSync({ cwd: cacheDir, onlyFiles: true })].filter(f =>
            /^[0-9a-f]{16}$/.test(path.basename(f)),
          ).length;
        const waitForFiles = async minimum => {
          let deadline = Date.now() + 10_000;
          let previous = 0;
          while (true) {
            const current = files();
            if (current >= minimum) return;
            // Detect stranded work without timing out slow, low-priority compilation.
            if (current > previous) {
              previous = current;
              deadline = Date.now() + 10_000;
            }
            if (Date.now() >= deadline || proc.exitCode !== null) {
              throw new Error(`idle persistence stalled at ${current}/${minimum} entries (exitCode: ${proc.exitCode})`);
            }
            await Bun.sleep(10);
          }
        };
        await waitForFiles(1);
        expect(files()).toBeLessThan(count + 1);
        proc.stdin.write("late\n");
        await waitForPhase(proc.stdin.flush(), "late-module request");
        // The child now has no JS timers. The new module must wake/resume deferred persistence.
        await waitForFiles(count + 2);
        proc.stdin.write("stop\n");
        await waitForPhase(proc.stdin.flush(), "stop request");
        const [stdout, stderr, exitCode] = await waitForPhase(
          Promise.all([stdoutPromise, stderrPromise, proc.exited]),
          "child exit",
        );
        expect(stdout.trim()).toBe("ready\nlate\ncomplete");
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
      } finally {
        await waitForPhase(proc[Symbol.asyncDispose](), "child cleanup");
      }
    },
    // Each awaited phase is bounded above; steady persistence is independent of runner speed.
    0,
  );

  const compileCacheEnv = { ...bunEnv };
  delete compileCacheEnv.NODE_COMPILE_CACHE;
  delete compileCacheEnv.NODE_COMPILE_CACHE_PORTABLE;
  delete compileCacheEnv.NODE_DISABLE_COMPILE_CACHE;

  let compileCacheTagPromise;
  function compileCacheTag() {
    return (compileCacheTagPromise ??= (async () => {
      using dir = tempDir("compile-cache-tag", {});
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `const m = require("module");
           m.enableCompileCache({ directory: ${JSON.stringify(String(dir))} });
           process.stdout.write(require("path").basename(m.getCompileCacheDir()));`,
        ],
        env: compileCacheEnv,
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout, stderr).toMatch(/^v/);
      expect(exitCode).toBe(0);
      return stdout;
    })());
  }

  test.skipIf(isWindows)(
    "enableCompileCache only uses a cache directory owned by the current user and not writable by others",
    async () => {
      using dir = tempDir("compile-cache-owner", {});
      const base = path.join(String(dir), "cc");
      const leaf = path.join(base, await compileCacheTag());
      fs.mkdirSync(leaf, { recursive: true });
      fs.chmodSync(leaf, 0o777);
      const code = `
        const fs = require("fs");
        const Module = require("module");
        const first = Module.enableCompileCache({ directory: ${JSON.stringify(base)} });
        fs.chmodSync(${JSON.stringify(leaf)}, 0o755);
        const second = Module.enableCompileCache({ directory: ${JSON.stringify(base)} });
        process.stdout.write(JSON.stringify({ first, second, dir: Module.getCompileCacheDir() }));
      `;
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", code],
        env: compileCacheEnv,
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout, stderr).toStartWith("{");
      const { FAILED, ENABLED } = Module.constants.compileCacheStatus;
      expect(JSON.parse(stdout)).toEqual({
        first: {
          status: FAILED,
          message:
            "Cannot use cache directory: it must be owned by the current user and not be group- or world-writable",
        },
        second: { status: ENABLED, directory: base },
        dir: leaf,
      });
      expect(exitCode).toBe(0);
    },
  );

  test.skipIf(isWindows)("enableCompileCache does not follow a symlink at the cache directory leaf", async () => {
    using dir = tempDir("compile-cache-symlink-leaf", {});
    const base = path.join(String(dir), "cc");
    const target = path.join(String(dir), "elsewhere");
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.chmodSync(target, 0o755);
    const leaf = path.join(base, await compileCacheTag());
    fs.symlinkSync(target, leaf);
    const code = `
      const Module = require("module");
      const result = Module.enableCompileCache({ directory: ${JSON.stringify(base)} });
      process.stdout.write(JSON.stringify({ result, dir: String(Module.getCompileCacheDir()) }));
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", code],
      env: compileCacheEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout, stderr).toStartWith("{");
    const { FAILED } = Module.constants.compileCacheStatus;
    expect(JSON.parse(stdout)).toEqual({
      result: {
        status: FAILED,
        message: expect.stringMatching(/^Cannot create cache directory: (ENOTDIR|ELOOP)$/),
      },
      dir: "undefined",
    });
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("native module functions are not constructors", () => {
    // Constructing these used to crash instead of throwing.
    const compile = new Module("not-a-constructor-test")._compile;
    expect(typeof compile).toBe("function");
    expect(() => new compile()).toThrow(TypeError);
    expect(() => Reflect.construct(compile, [])).toThrow(TypeError);
    expect(() => new Module.runMain()).toThrow(TypeError);
    expect(() => Reflect.construct(Module.runMain, [])).toThrow(TypeError);
    expect(() => new Module._resolveFilename("fs")).toThrow(TypeError);
    expect(() => Reflect.construct(Module._resolveFilename, ["fs"])).toThrow(TypeError);
    // Calling still works.
    expect(Module._resolveFilename("fs")).toBe("fs");
  });

  test("Module.runMain propagates an error from stringifying its argument", () => {
    const boom = new Error("boom");
    expect(() =>
      Module.runMain({
        toString() {
          throw boom;
        },
      }),
    ).toThrow(boom);
  });

  test("module.filename/id/path setters propagate a failed string conversion", () => {
    const m = new Module("x");
    for (const key of ["filename", "id", "path"]) {
      expect(() => {
        m[key] = Symbol("s");
      }).toThrow(TypeError);
    }
  });

  test("Module._resolveFilename accepts an options object without paths", () => {
    // An options object without .paths used to segfault on the isArray() check.
    expect(Module._resolveFilename("fs", null, false, {})).toBe("fs");
    expect(Module._resolveFilename("fs", null, false, Object.create(null))).toBe("fs");
    expect(Module._resolveFilename("fs", null, false, [])).toBe("fs");
    expect(Module._resolveFilename("fs", null, false, { paths: undefined })).toBe("fs");
    expect(Module._resolveFilename("fs", null, false, { paths: null })).toBe("fs");
  });

  test("createRequire trailing slash", () => {
    const req = createRequire(import.meta.dir + "/");
    expect(req.resolve("./node-module-module.test.js")).toBe(
      ospath(path.resolve(import.meta.dir, "./node-module-module.test.js")),
    );
  });

  test("createRequire trailing slash file url", () => {
    const req = createRequire(Bun.pathToFileURL(import.meta.dir + "/"));
    expect(req.resolve("./node-module-module.test.js")).toBe(
      ospath(path.resolve(import.meta.dir, "./node-module-module.test.js")),
    );
  });

  test("Module exists", () => {
    expect(Module).toBeDefined();
  });

  test("module.Module works", () => {
    expect(Module.Module === Module).toBeTrue();

    const m = new Module("asdf");
    expect(m.exports).toEqual({});
  });

  test("_nodeModulePaths() works", () => {
    const root = path.resolve("/");
    expect(() => {
      _nodeModulePaths();
    }).toThrow();
    expect(_nodeModulePaths(".").length).toBeGreaterThan(0);
    expect(_nodeModulePaths(".").pop()).toBe(root + "node_modules");
    expect(_nodeModulePaths("")).toEqual(_nodeModulePaths("."));
    expect(_nodeModulePaths("/")).toEqual([root + "node_modules"]);
    expect(_nodeModulePaths("/a/b/c/d")).toEqual([
      ospath(root + "a/b/c/d/node_modules"),
      ospath(root + "a/b/c/node_modules"),
      ospath(root + "a/b/node_modules"),
      ospath(root + "a/node_modules"),
      ospath(root + "node_modules"),
    ]);
    expect(_nodeModulePaths("/a/b/../d")).toEqual([
      ospath(root + "a/d/node_modules"),
      ospath(root + "a/node_modules"),
      ospath(root + "node_modules"),
    ]);
    // Node resolves `from` through `path.resolve`, so a trailing separator is
    // dropped rather than producing an extra ".../<sep>/node_modules" entry.
    expect(_nodeModulePaths("/a/b/c/d/")).toEqual(_nodeModulePaths("/a/b/c/d"));
    expect(_nodeModulePaths(ospath("/a/b/c/d") + path.sep)).toEqual(_nodeModulePaths("/a/b/c/d"));
  });

  test("_nodeModulePaths() is stable across process.chdir()", async () => {
    // process.chdir() re-seeds the resolver's cached top-level dir with a
    // trailing separator; _nodeModulePaths("") then used to emit a duplicate
    // `<cwd>//node_modules` entry, which surfaced as a `--parallel` flake when
    // an earlier test file in the same worker had chdir'd.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const m = require("module");
         const before = m._nodeModulePaths("");
         const here = process.cwd();
         process.chdir(require("os").tmpdir());
         process.chdir(here);
         process.stdout.write(JSON.stringify({
           before,
           empty: m._nodeModulePaths(""),
           dot: m._nodeModulePaths("."),
         }));`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    const { before, empty, dot } = JSON.parse(stdout);
    expect(empty).toEqual(before);
    expect(empty).toEqual(dot);
    for (const p of empty) expect(p).not.toMatch(/[/\\]{2}node_modules$/);
    expect(exitCode).toBe(0);
  });

  test("_nodeModulePaths() does not leak the input string", async () => {
    // 20 components keeps the joined path well under macOS PATH_MAX (1024)
    // while generating 21 result strings per call, so the leak signal
    // dominates RSS noise within a few thousand iterations.
    const code = /* js */ `
        const m = require("module");
        const rss = process.memoryUsage.rss;
        const comp = Buffer.alloc(30, "a").toString();
        const base = "/" + Array(20).fill(comp).join("/");
        for (let i = 0; i < 200; i++) m._nodeModulePaths(base + i);
        Bun.gc(true); Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 5000; i++) m._nodeModulePaths(base + i);
        Bun.gc(true); Bun.gc(true); Bun.gc(true);
        process.stdout.write(String((rss() - before) / 1024 / 1024));
      `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--smol", "-e", code],
      env: {
        ...bunEnv,
        // Disable ASAN's free-quarantine so the RSS delta reflects live
        // allocations only; harmless on non-ASAN builds.
        ASAN_OPTIONS: [bunEnv.ASAN_OPTIONS, "quarantine_size_mb=0"].filter(Boolean).join(":"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const growthMB = Number(stdout.trim());
    if (!Number.isFinite(growthMB)) {
      throw new Error(`subprocess did not report growth\nstdout: ${stdout}\nstderr: ${stderr}\nexit: ${exitCode}`);
    }
    expect(growthMB).toBeLessThan(25);
    expect(exitCode).toBe(0);
  }, 20_000);

  test("Module.wrap", () => {
    var mod = { exports: {} };
    expect(eval(wrap("exports.foo = 1; return 42"))(mod.exports, mod)).toBe(42);
    expect(mod.exports.foo).toBe(1);
    expect(wrap()).toBe("(function (exports, require, module, __filename, __dirname) { undefined\n});");
  });

  test("Overwriting _resolveFilename", async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", path.join(import.meta.dir, "resolveFilenameOverwrite.cjs")],
      env: bunEnv,
      stderr: "inherit",
      stdout: "pipe",
    });

    const stdout = await proc.stdout.text();
    expect(stdout.trim().endsWith("--pass--")).toBe(true);
    expect(await proc.exited).toBe(0);
  });

  test("Overridden _resolveFilename receives Node-compatible arguments from a CJS entry", async () => {
    using dir = tempDir("resolve-filename-args-cjs", {
      "real.cjs": "module.exports = 'REAL';",
      "lvl2.cjs": "module.exports = require('./real.cjs');",
      "main.cjs": `
        const path = require("node:path");
        const { Module } = require("node:module");
        const oR = Module._resolveFilename;
        const rows = [];
        Module._resolveFilename = function (request, parent, isMain, options) {
          if (request.startsWith("./")) {
            rows.push({
              request,
              parentType: typeof parent,
              parentFilename: path.basename(String(parent && parent.filename)),
              isMain,
              options,
              argc: arguments.length,
              thisIsModule: this === Module,
            });
          }
          return oR.apply(this, arguments);
        };
        require("./lvl2.cjs");
        require.resolve("./real.cjs");
        const userOptions = { paths: [__dirname], conditions: ["custom"], extra: 1 };
        require.resolve("./real.cjs", userOptions);
        rows[rows.length - 1].optionsIsUserObject = rows[rows.length - 1].options === userOptions;
        rows[rows.length - 1].options = Object.keys(userOptions);
        console.log(JSON.stringify(rows));
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), path.join(String(dir), "main.cjs")],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([
      {
        request: "./lvl2.cjs",
        parentType: "object",
        parentFilename: "main.cjs",
        isMain: false,
        argc: 4,
        thisIsModule: true,
      },
      {
        request: "./real.cjs",
        parentType: "object",
        parentFilename: "lvl2.cjs",
        isMain: false,
        argc: 4,
        thisIsModule: true,
      },
      {
        request: "./real.cjs",
        parentType: "object",
        parentFilename: "main.cjs",
        isMain: false,
        options: {},
        argc: 4,
        thisIsModule: true,
      },
      {
        request: "./real.cjs",
        parentType: "object",
        parentFilename: "main.cjs",
        isMain: false,
        options: ["paths", "conditions", "extra"],
        optionsIsUserObject: true,
        argc: 4,
        thisIsModule: true,
      },
    ]);
    expect(exitCode).toBe(0);
  });

  test("Overridden _resolveFilename receives a parent Module for createRequire from ESM", async () => {
    using dir = tempDir("resolve-filename-args-esm", {
      "real.cjs": "module.exports = 'REAL';",
      "main.mjs": `
        import path from "node:path";
        import { Module, createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        const oR = Module._resolveFilename;
        const rows = [];
        const parents = [];
        Module._resolveFilename = function (request, parent, isMain, options) {
          if (request.endsWith("real.cjs")) {
            parents.push(parent);
            rows.push({
              parentType: typeof parent,
              parentFilename: path.basename(String(parent && parent.filename)),
              isMain,
              options,
              argc: arguments.length,
              thisIsModule: this === Module,
            });
          }
          return oR.apply(this, arguments);
        };
        req("./real.cjs");
        req.resolve("./real.cjs");
        req.resolve("./real.cjs");
        Module._resolveFilename = oR;
        console.log(JSON.stringify({
          rows,
          sameParentAcrossRequireAndResolve: parents[0] === parents[1] && parents[1] === parents[2],
        }));
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), path.join(String(dir), "main.mjs")],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      rows: [
        { parentType: "object", parentFilename: "main.mjs", isMain: false, argc: 4, thisIsModule: true },
        { parentType: "object", parentFilename: "main.mjs", isMain: false, options: {}, argc: 4, thisIsModule: true },
        { parentType: "object", parentFilename: "main.mjs", isMain: false, options: {}, argc: 4, thisIsModule: true },
      ],
      sameParentAcrossRequireAndResolve: true,
    });
    expect(exitCode).toBe(0);
  });

  test("require and require.resolve inside new Module(id)._compile() both resolve from cwd", async () => {
    using dir = tempDir("resolve-filename-compile", {
      "sib.cjs": "module.exports = 'ROOT';",
      "sub/sib.cjs": "module.exports = 'SUB';",
      "main.cjs": `
        const path = require("node:path");
        const { Module } = require("node:module");
        function run() {
          const m = new Module(path.join(__dirname, "sub", "a.cjs"));
          m._compile(
            'module.exports = { req: require("./sib.cjs"), res: require.resolve("./sib.cjs") };',
            path.join(__dirname, "sub", "a.cjs"),
          );
          return { req: m.exports.req, res: path.relative(__dirname, m.exports.res) };
        }
        const noHook = run();
        const oR = Module._resolveFilename;
        Module._resolveFilename = function () {
          return oR.apply(this, arguments);
        };
        const withHook = run();
        Module._resolveFilename = oR;
        console.log(JSON.stringify({ noHook, withHook }));
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "main.cjs"],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      noHook: { req: "ROOT", res: "sib.cjs" },
      withHook: { req: "ROOT", res: "sib.cjs" },
    });
    expect(exitCode).toBe(0);
  });

  test("Overwriting _resolveFilename with a non-callable makes require() throw like Node", async () => {
    // Node keeps _resolveFilename as a plain data property: any value can be
    // assigned and reads back, and require() throws when it goes to call it.
    using dir = tempDir("resolve-filename-non-callable", {
      "dep.cjs": `module.exports = "dep";`,
      "main.cjs": `
        const Module = require("module");
        const original = Module._resolveFilename;
        const attempt = fn => {
          try {
            return "returned " + String(fn());
          } catch (e) {
            return e.constructor.name + ": " + e.message;
          }
        };
        const results = {};
        for (const [label, value] of [
          ["object", {}],
          ["string", "not a function"],
          ["undefined", undefined],
          ["null", null],
          ["number", 42],
          ["symbol", Symbol("s")],
        ]) {
          Module._resolveFilename = value;
          results[label] = {
            readsBack: Object.is(Module._resolveFilename, value),
            require: attempt(() => require("./dep.cjs")),
            requireResolve: attempt(() => require.resolve("./dep.cjs")),
            createRequire: attempt(() => Module.createRequire(__filename)("./dep.cjs")),
          };
        }
        // Callable objects other than plain functions are still honored.
        Module._resolveFilename = new Proxy(original, {});
        results.callableProxy = attempt(() => require("./dep.cjs"));
        Module._resolveFilename = original;
        results.restored = {
          readsBack: Module._resolveFilename === original,
          require: attempt(() => require("./dep.cjs")),
        };
        console.log(JSON.stringify(results));
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), path.join(String(dir), "main.cjs")],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    const notAFunction = {
      readsBack: true,
      require: "TypeError: Module._resolveFilename is not a function",
      requireResolve: "TypeError: Module._resolveFilename is not a function",
      createRequire: "TypeError: Module._resolveFilename is not a function",
    };
    expect(JSON.parse(stdout)).toEqual({
      object: notAFunction,
      string: notAFunction,
      undefined: notAFunction,
      null: notAFunction,
      number: notAFunction,
      symbol: notAFunction,
      callableProxy: "returned dep",
      restored: { readsBack: true, require: "returned dep" },
    });
    expect(exitCode).toBe(0);
  });

  describe.concurrent(
    "Module._resolveFilename gives an ES module by a path the resolver would spell differently",
    () => {
      test.each([
        ["a . segment", `__dirname + "/./esm.mjs"`],
        ["a .. segment", `__dirname + "/sub/../esm.mjs"`],
        ["a doubled separator", `__dirname + "//esm.mjs"`],
        ["relative to the working directory", `"./esm.mjs"`],
        ["a symlink to the file", `__dirname + "/link.mjs"`],
        ["a symlink to its directory", `__dirname + "/linked/esm.mjs"`],
      ])("%s", async (_, filename) => {
        using dir = tempDir("resolve-filename-other-spelling", {
          "esm.mjs": `import { dep } from "./dep.mjs"; export const who = "esm, " + dep;`,
          "dep.mjs": `export const dep = "dep";`,
          "sub/empty.txt": "",
          "main.cjs": `
          const Module = require("node:module");
          Module._resolveFilename = () => ${filename};
          console.log(require("anything").who, require("anything") === require("something else"));
        `,
        });
        fs.symlinkSync("esm.mjs", path.join(String(dir), "link.mjs"), "file");
        fs.symlinkSync(".", path.join(String(dir), "linked"), "dir");
        await using proc = Bun.spawn({
          cmd: [bunExe(), "main.cjs"],
          env: bunEnv,
          cwd: String(dir),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect({ stdout, stderr, exitCode }).toEqual({ stdout: "esm, dep true\n", stderr: "", exitCode: 0 });
      });
    },
  );

  test("Overwriting Module.prototype.require", async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", path.join(import.meta.dir, "modulePrototypeOverwrite.cjs")],
      env: bunEnv,
      stderr: "inherit",
      stdout: "pipe",
    });

    const stdout = await proc.stdout.text();
    expect(stdout.trim().endsWith("--pass--")).toBe(true);
    expect(await proc.exited).toBe(0);
  });

  test.each([
    "/file/name/goes/here.js",
    "file/here.js",
    "file\\here.js",
    "/file\\here.js",
    "\\file\\here.js",
    "\\file/here.js",
  ])("Module.prototype._compile", filename => {
    const module = new Module("module id goes here");
    const starting_exports = module.exports;
    const r = module._compile("module.exports = { module, exports, require, __filename, __dirname }", filename);
    expect(r).toBe(undefined);
    expect(module.exports).not.toBe(starting_exports);
    const { module: m, exports: e, require: req, __filename: fn, __dirname: dn } = module.exports;
    expect(m).toBe(module);
    expect(e).toBe(starting_exports);
    expect(req).toBe(module.require);
    expect(fn).toBe(filename);
    expect(dn).toBe(path.dirname(filename));
  });

  test("Module._extensions", () => {
    expect(".js" in Module._extensions).toBeTrue();
    expect(".json" in Module._extensions).toBeTrue();
    expect(".node" in Module._extensions).toBeTrue();
    expect(require.extensions).toBe(Module._extensions);
  });

  test("Module._resolveLookupPaths", () => {
    expect(Module._resolveLookupPaths("foo")).toEqual([]);
    expect(Module._resolveLookupPaths("./bar", { id: "1", filename: "/baz/abc" })).toEqual(["/baz"]);
    const literal = path.join(process.cwd(), "literal?dir", "parent.cjs");
    expect(Module._resolveLookupPaths("./bar", { id: "parent", filename: literal })).toEqual([path.dirname(literal)]);
    expect(Module._resolveLookupPaths("./bar", {})).toEqual(["."]);
    expect(Module._resolveLookupPaths("./bar", { paths: ["a"] })).toEqual(["."]);
    expect(Module._resolveLookupPaths("bar", { paths: ["a"] })).toEqual(["a"]);
  });

  test("Module.findSourceMap doesn't throw", () => {
    expect(Module.findSourceMap("foo")).toEqual(undefined);
  });

  test("require cache relative specifier", () => {
    require.cache["./bar.cjs"] = { exports: { default: "bar" } };
    expect(() => require("./bar.cjs")).toThrow("Cannot find module");
  });
  test("builtin resolution", () => {
    expect(require.resolve("fs")).toBe("fs");
    expect(require.resolve("node:fs")).toBe("node:fs");
  });
  test("require cache node builtins specifier", () => {
    // as js builtin
    try {
      const fake = { default: "bar" };
      const real = require("fs");
      expect(require.cache["fs"]).toBe(undefined);
      require.cache["fs"] = { exports: fake };
      expect(require("fs")).toBe(fake);
      expect(require("node:fs")).toBe(real);
    } finally {
      delete require.cache["fs"];
    }

    // as native module
    try {
      const fake = { default: "bar" };
      const real = require("util/types");
      expect(require.cache["util/types"]).toBe(undefined);
      require.cache["util/types"] = { exports: fake };
      expect(require("util/types")).toBe(fake);
      expect(require("node:util/types")).toBe(real);
    } finally {
      delete require.cache["util/types"];
    }
  });
  // https://github.com/oven-sh/bun/issues/40551
  test("require.cache does not expose builtins from the ESM registry", () => {
    // `fs` and `bun:sqlite` are ESM-imported at the top of this file, so the
    // ESM registry holds "node:fs" and "bun:sqlite". Node.js never puts
    // builtins in require.cache; serving the frozen module namespace object
    // here breaks require-in-the-middle consumers (dd-trace, OpenTelemetry)
    // that patch cached exports.
    expect(require.cache["node:fs"]).toBeUndefined();
    expect("node:fs" in require.cache).toBe(false);
    expect(Object.getOwnPropertyDescriptor(require.cache, "node:fs")).toBeUndefined();
    expect(Object.keys(require.cache).filter(k => k.startsWith("node:"))).toEqual([]);
    // bun:* builtins have the same frozen-namespace hazard. Other bun: keys
    // can legitimately be in require.cache via require() (for example the
    // harness requires "bun:jsc"), so only assert on the ESM-only import.
    expect(require.cache["bun:sqlite"]).toBeUndefined();
    expect("bun:sqlite" in require.cache).toBe(false);
    expect(Object.getOwnPropertyDescriptor(require.cache, "bun:sqlite")).toBeUndefined();
    expect(Object.keys(require.cache)).not.toContain("bun:sqlite");
  });
  test("require a cjs file uses the 'module.exports' export", () => {
    expect(require("./esm_to_cjs_interop.mjs")).toEqual(Symbol.for("meow"));
  });

  test("Module.runMain", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "--require",
        path.join(import.meta.dir, "overwrite-module-run-main-1.cjs"),
        path.join(import.meta.dir, "overwrite-module-run-main-2.cjs"),
      ],
      env: bunEnv,
      stderr: "inherit",
      stdout: "pipe",
    });

    const stdout = await proc.stdout.text();
    expect(stdout.trim()).toBe("pass");
    expect(await proc.exited).toBe(0);
  });
  test("Module.runMain 2", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "--require",
        path.join(import.meta.dir, "overwrite-module-run-main-3.cjs"),
        path.join(import.meta.dir, "overwrite-module-run-main-2.cjs"),
      ],
      env: bunEnv,
      stderr: "inherit",
      stdout: "pipe",
    });

    const stdout = await proc.stdout.text();
    expect(stdout.trim()).toBe("pass");
    expect(await proc.exited).toBe(0);
  });
  describe.concurrent("Module.runMain resolves its argument from the working directory", () => {
    test.each([
      ["a relative path", "./server.js", "server.js"],
      ["no extension", "./server", "server.js"],
      ["a directory", "./dir", "dir/index.js"],
      ["a . segment", "./dir/./index.js", "dir/index.js"],
      ["a symlink", "./link.js", "server.js"],
      ["a file that is missing", "./missing", "ResolveMessage"],
    ])("%s", async (_, argument, expected) => {
      const file = `console.log(require("node:path").relative(process.cwd(), __filename).replaceAll("\\\\", "/"));`;
      using dir = tempDir("run-main-argument", {
        "server.js": file,
        "dir/index.js": file,
        "main.cjs": `
          try {
            require("node:module").runMain(${JSON.stringify(argument)});
          } catch (error) {
            console.log(error.name);
          }
        `,
      });
      fs.symlinkSync("server.js", path.join(String(dir), "link.js"), "file");
      await using proc = Bun.spawn({
        cmd: [bunExe(), "main.cjs"],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: expected + "\n", stderr: "", exitCode: 0 });
    });
  });

  describe.concurrent("Module.runMain set by a preload", () => {
    const handlers = `
      process.on("uncaughtException", error => console.log("uncaughtException: " + error.message));
      process.on("unhandledRejection", error => console.log("unhandledRejection: " + error.message));
    `;
    async function run(preload, inWorker = false, main = `console.log("main ran");`) {
      using dir = tempDir("module-run-main", {
        "preload.cjs": preload,
        "main.cjs": main,
        "worker.mjs": `new Worker(import.meta.dir + "/main.cjs", { preload: [import.meta.dir + "/preload.cjs"] });`,
      });
      await using proc = Bun.spawn({
        cmd: inWorker ? [bunExe(), "./worker.mjs"] : [bunExe(), "--require", "./preload.cjs", "./main.cjs"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
        stdout: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr: normalizeBunSnapshot(stderr, dir), exitCode };
    }

    test.each([
      ["{}", "Object"],
      ["[]", "Array"],
      [`"a string"`, `"a string"`],
      [`Symbol("s")`, "Symbol(s)"],
      ["10n", "10"],
    ])("to %s, which is not a function", async (value, described) => {
      expect(await run(`require("module").runMain = ${value};`)).toEqual({
        stdout: "",
        stderr: `TypeError: ${described} is not a function\n\nBun v<bun-version>`,
        exitCode: 1,
      });
    });

    test("to a function that throws", async () => {
      const { stdout, stderr, exitCode } = await run(
        `require("module").runMain = () => {\n  throw new RangeError("from the override");\n};`,
      );
      expect(stderr).toMatchInlineSnapshot(`
        "1 | require("module").runMain = () => {
        2 |   throw new RangeError("from the override");
                    ^
        RangeError: from the override
            at <anonymous> (file:NN:NN)

        Bun v<bun-version>"
      `);
      expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 1 });
    });

    test("to a function that calls the original and throws", async () => {
      const preload = `
        const Module = require("module");
        const runMain = Module.runMain;
        Module.runMain = (...args) => {
          runMain(...args);
          throw new Error("after the original");
        };
      `;
      expect(await run(preload)).toMatchObject({ stdout: "main ran\n", exitCode: 1 });
      expect(await run(handlers + preload)).toEqual({
        stdout: "main ran\nunhandledRejection: after the original\n",
        stderr: "",
        exitCode: 0,
      });
      // What the main file throws is not lost for it.
      expect(await run(handlers + preload, false, `throw new Error("from main");`)).toEqual({
        stdout: "unhandledRejection: after the original\nuncaughtException: from main\n",
        stderr: "",
        exitCode: 0,
      });
    });

    test.each([
      ["is not a function", "{}", "Object is not a function"],
      ["throws", `() => { throw new Error("thrown"); }`, "thrown"],
    ])("one that %s is reported once", async (_, value, message) => {
      const expected = { stdout: `uncaughtException: ${message}\n`, stderr: "", exitCode: 0 };
      expect(await run(`${handlers} require("module").runMain = ${value};`)).toEqual(expected);
      expect(await run(`${handlers} require("module").runMain = ${value};`, true)).toEqual(expected);
    });
  });
  test.each(["no args", "--access-early"])("children, %s", async arg => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), path.join(import.meta.dir, "children-fixture/a.cjs"), arg],
      env: bunEnv,
      stderr: "inherit",
      stdout: "pipe",
    });

    const stdout = await proc.stdout.text();
    expect(stdout.trim()).toBe(`. (./a.cjs)
 ./b.cjs
  . (./a.cjs) (seen)
  ./b.cjs (seen)
  ./c.cjs
   ./d.cjs
    ./d.cjs (seen)
 ./d.cjs (seen)
 ./f.cjs
  ./d.cjs (seen)
 ./g.cjs
  ./b.cjs (seen)
  . (./a.cjs) (seen)
  ./h.cjs
   ./i.cjs
    ./j.cjs
     ./i.cjs (seen)
     ./j.cjs (seen)
     ./k.cjs
      ./j.cjs (seen)
   ./j.cjs (seen)
   ./k.cjs (seen)`);
    expect(await proc.exited).toBe(0);
  });

  test("new Module().exports survives object spread", async () => {
    // exports was built with inline capacity 0, so spreading it hit JSC's
    // tryCreateObjectViaCloning hasInlineStorage() debug assert. Run in a
    // subprocess so a regressing assert shows up as missing stdout rather than
    // killing the test runner.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const Module = require("node:module");
         const m = new Module("x");
         m.exports.a = 1;
         console.log(JSON.stringify({ ...m.exports }));`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim()).toBe('{"a":1}');
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

test("registerHooks resolves, loads, chains, and deregisters synchronous hooks", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      const assert = require("node:assert/strict");
      const { registerHooks } = require("node:module");
      const calls = [];
      const first = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "virtual-module-hooks") {
            calls.push("resolve");
            return { url: "test://module-hooks.cjs", shortCircuit: true };
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url === "test://module-hooks.cjs") {
            calls.push("load");
            return { format: "commonjs", source: Buffer.from("module.exports = 42"), shortCircuit: true };
          }
          return nextLoad(url, context);
        }
      });
      const second = registerHooks({
        resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); },
        load(url, context, nextLoad) { return nextLoad(url, context); }
      });
      assert.equal(require("virtual-module-hooks"), 42);
      assert.deepEqual(calls, ["resolve", "load"]);
      second.deregister();
      first.deregister();
      assert.throws(() => require("other-virtual-module-hooks"), { code: "MODULE_NOT_FOUND" });
      console.log("hooks passed");
    `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stdout.trim()).toBe("hooks passed");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

describe("stripTypeScriptTypes", () => {
  test("exports the same function through both module entry points", () => {
    expect(stripTypeScriptTypes).toBe(Module.stripTypeScriptTypes);
    expect(stripTypeScriptTypes).toBe(require("node:module").stripTypeScriptTypes);
    expect(stripTypeScriptTypes.name).toBe("stripTypeScriptTypes");
    expect(stripTypeScriptTypes.length).toBe(1);
  });

  test("preserves JavaScript exports and erases only TypeScript exports", () => {
    expect(stripTypeScriptTypes("export const old = 1;")).toBe("export const old = 1;");
    expect(stripTypeScriptTypes("export const old: number = 1;")).toBe("export const old         = 1;");
    expect(stripTypeScriptTypes("export type T = string; export const value: number = 1;")).toBe(
      "                        export const value         = 1;",
    );
  });

  test("normalizes lone surrogates before stripping", () => {
    expect(stripTypeScriptTypes('const x: string = "\ud800";')).toBe('const x         = "\ufffd";');
  });
  test("strips types in place, preserving positions", () => {
    expect(stripTypeScriptTypes("const x: number = 1;")).toBe("const x         = 1;");
    expect(stripTypeScriptTypes("let x: string = 1 as any;")).toBe("let x         = 1       ;");
    expect(stripTypeScriptTypes("let x: Ту = 1;")).toBe("let x  \u00a0\u00a0 = 1;");
  });

  test("mode: 'strip' explicit", () => {
    expect(stripTypeScriptTypes("const x: number = 1;", { mode: "strip" })).toBe("const x         = 1;");
  });

  test("erased statements", () => {
    expect(stripTypeScriptTypes("interface A { x: string }\nlet y = 1;")).toBe("                         \nlet y = 1;");
    expect(stripTypeScriptTypes("type A = string;\nlet y = 1;")).toBe("                \nlet y = 1;");
    expect(stripTypeScriptTypes("declare function f(): void;\nlet y = 1;")).toBe(
      "                           \nlet y = 1;",
    );
    expect(stripTypeScriptTypes("export type { A };")).toBe("                  ");
    expect(stripTypeScriptTypes("declare enum E { A }")).toBe("                    ");
    expect(stripTypeScriptTypes("declare namespace N { const x: number }")).toBe(
      "                                       ",
    );
    expect(stripTypeScriptTypes('declare module "m" { const x: number }')).toBe(
      "                                      ",
    );
    expect(stripTypeScriptTypes("function f(): void;\nfunction f() {}")).toBe("                   \nfunction f() {}");
  });

  test("strips declaration-heavy generated source", () => {
    const declarations = Array.from({ length: 50_000 }, (_, i) => `type T${i} = number;`).join("\n");
    expect(stripTypeScriptTypes(declarations)).toBe(declarations.replace(/[^\n]/g, " "));
  });

  test("import/export type specifiers", () => {
    expect(stripTypeScriptTypes('import type { A } from "x";\nlet y = 1;')).toBe(
      "                           \nlet y = 1;",
    );
    expect(stripTypeScriptTypes('import { type A, B } from "x";')).toBe('import {         B } from "x";');
    // A specifier list that erases to nothing keeps the side-effect import.
    expect(stripTypeScriptTypes('import { type A } from "x";')).toBe('import {        } from "x";');
    expect(stripTypeScriptTypes("export { type A, B };")).toBe("export {         B };");
    expect(stripTypeScriptTypes("export { type A };")).toBe("export {        };");
    // `type` used as a real import name is kept.
    expect(stripTypeScriptTypes('import { type as xxx } from "m";')).toBe('import { type as xxx } from "m";');
  });

  test("functions and classes", () => {
    expect(stripTypeScriptTypes("function f<T>(a: T, b?: number): T { return a; }")).toBe(
      "function f   (a   , b         )    { return a; }",
    );
    expect(stripTypeScriptTypes("function f(this: void, a: number) {}")).toBe("function f(            a        ) {}");
    expect(stripTypeScriptTypes("class C<T> extends B<T> {}")).toBe("class C    extends B    {}");
    expect(stripTypeScriptTypes("class C extends B implements I, J {}")).toBe("class C extends B                 {}");
    expect(stripTypeScriptTypes("abstract class C { abstract foo(): void }")).toBe(
      "         class C {                      }",
    );
    expect(stripTypeScriptTypes("class C { declare x: number }")).toBe("class C {                   }");
    expect(stripTypeScriptTypes("class C { private readonly x: number = 1 }")).toBe(
      "class C {                  x         = 1 }",
    );
    expect(stripTypeScriptTypes("class C { x!: number }")).toBe("class C { x          }");
    expect(stripTypeScriptTypes("class C { m?(): void {} }")).toBe("class C { m ()       {} }");
    expect(stripTypeScriptTypes("class C { [k: string]: any }")).toBe("class C {                  }");
    // A modifier keyword used as a member name is not a modifier.
    expect(stripTypeScriptTypes("class C { public public() {} }")).toBe("class C {        public() {} }");
  });

  test("expressions", () => {
    expect(stripTypeScriptTypes("let a = x!;")).toBe("let a = x ;");
    expect(stripTypeScriptTypes("f<number>(1);")).toBe("f        (1);");
    expect(stripTypeScriptTypes("new C<number>();")).toBe("new C        ();");
    expect(stripTypeScriptTypes("let v = f<T>;")).toBe("let v = f   ;");
    expect(stripTypeScriptTypes("let x = a satisfies number;")).toBe("let x = a                 ;");
    expect(stripTypeScriptTypes("x as const;")).toBe("x         ;");
    expect(stripTypeScriptTypes("let x = `a${1 as number}b`;")).toBe("let x = `a${1          }b`;");
  });

  test("preserves parenthesized calls with TypeScript suffixes", () => {
    expect(stripTypeScriptTypes("(f)!<number>(1);")).toBe("(f)         (1);");
    expect(stripTypeScriptTypes("(f)<<T>() => T>(g);")).toBe("(f)            (g);");
    expect(stripTypeScriptTypes("(f!)<Array<number>>(1);")).toBe("(f )               (1);");
  });

  test("ASI protection", () => {
    // Removing an erased span must not fuse the next line onto the previous
    // statement; amaro writes a `;` into the blank.
    expect(stripTypeScriptTypes("let a = b as any\n(c);")).toBe("let a = b ;     \n(c);");
    expect(stripTypeScriptTypes("let a = b as any\n[c];")).toBe("let a = b ;     \n[c];");
    expect(stripTypeScriptTypes("let a = b as any\nc;")).toBe("let a = b       \nc;");
    expect(stripTypeScriptTypes("let x = 1\ntype A = string\n(f)()")).toBe("let x = 1\n;              \n(f)()");
    expect(stripTypeScriptTypes("let x = 1\ntype A = string\nlet y = 2")).toBe("let x = 1\n               \nlet y = 2");
    expect(stripTypeScriptTypes("type A=1;type B=2;let c=3;")).toBe("                  let c=3;");
  });

  test("preserves a regex statement beginning with /=", () => {
    const output = stripTypeScriptTypes('let x = 1\ntype T = number\n/=/.test("=");');
    expect(output).toBe('let x = 1\n;              \n/=/.test("=");');
    expect(Function(`${output}\nreturn x;`)()).toBe(1);
  });

  test("generic arrows", () => {
    expect(stripTypeScriptTypes("const f = (x?: number) => x;")).toBe("const f = (x         ) => x;");
    expect(stripTypeScriptTypes("const f = (x?) => x;")).toBe("const f = (x ) => x;");
    expect(stripTypeScriptTypes("let f = <T>(v: T) => v;")).toBe("let f =    (v   ) => v;");
    expect(stripTypeScriptTypes("const x = async <\nT\n>(value);")).toBe("const x = async  \n \n (value);");
    expect(() => stripTypeScriptTypes("const x = <T>(value);")).toThrow(
      expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
    );
    expect(() => stripTypeScriptTypes("const x = <T>(() => 1);")).toThrow(
      expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
    );
    expect(stripTypeScriptTypes("let f = async <T>(v: T) => v;")).toBe("let f = async    (v   ) => v;");
    // Newline inside async generics: `<` is rewritten to `(`.
    expect(stripTypeScriptTypes("let f = async <\nT\n>(v: T) => v;")).toBe("let f = async (\n \n  v   ) => v;");
    expect(stripTypeScriptTypes("function g() { return <T>\n(v: T) => v; }")).toBe(
      "function g() { return (  \n v   ) => v; }",
    );
    expect(stripTypeScriptTypes("function f() { return <\nT\n>(x: T) => x; }")).toBe(
      "function f() { return (\n \n  x   ) => x; }",
    );
    // Node 24 preserves this newline even though the resulting JavaScript is invalid.
    expect(stripTypeScriptTypes("const f = async <T>\n(x: T) => x;")).toBe("const f = async    \n(x   ) => x;");
    // Return type spanning a newline: `)` is moved down to stay on the `=>` line.
    expect(stripTypeScriptTypes("let f = ()\n: any =>\n    1;")).toBe("let f = ( \n    ) =>\n    1;");
  });

  test("keeps an empty statement for erased control-flow bodies", () => {
    expect(stripTypeScriptTypes("if (x) type T = number;\nf();")).toBe("if (x) ;               \nf();");
    expect(stripTypeScriptTypes("if (x) type T = number; else f();")).toBe("if (x) ;                else f();");
    expect(stripTypeScriptTypes("while(x) interface T {}\nf();")).toBe("while(x) ;             \nf();");
    expect(stripTypeScriptTypes("for(;;) type T = number;\nf();")).toBe("for(;;) ;               \nf();");
    expect(stripTypeScriptTypes("do type T=number; while(x);")).toBe("do ;              while(x);");
    expect(stripTypeScriptTypes("label: type T = number;\nf();")).toBe("label:                 \nf();");
    expect(stripTypeScriptTypes("if (x) { type T = number; }\nf();")).toBe("if (x) {                  }\nf();");
  });

  test("erases decorators with declared class fields", () => {
    expect(stripTypeScriptTypes("abstract class C { @dec abstract x: number }")).toBe(
      "         class C {                         }",
    );
    expect(stripTypeScriptTypes("abstract class C { @dec(()\n: any => 0) abstract x: number }")).toBe(
      "         class C {        \n                               }",
    );
    expect(stripTypeScriptTypes("class C { @dec declare x: number }")).toBe("class C {                        }");
    expect(stripTypeScriptTypes("class C { @dec declare x: number\n y=1 }")).toBe(
      "class C {                       \n y=1 }",
    );
    expect(stripTypeScriptTypes("class C { @dec(()\n: any => 0) declare x: number }")).toBe(
      "class C {        \n                              }",
    );
    expect(stripTypeScriptTypes("declare namespace N { let x = a as any\n(b); }")).toBe(
      "                                      \n      ",
    );
  });

  test("comments and hashbang survive", () => {
    expect(stripTypeScriptTypes("let x: number /*keep*/ = 1;")).toBe("let x         /*keep*/ = 1;");
    expect(stripTypeScriptTypes("let x: /*in*/ number = 1;")).toBe("let x                = 1;");
    expect(stripTypeScriptTypes("#!/usr/bin/env node\nlet x: number = 1;")).toBe(
      "#!/usr/bin/env node\nlet x         = 1;",
    );
  });

  test("sourceUrl appends a sourceURL comment", () => {
    expect(stripTypeScriptTypes("const x: number = 1;", { mode: "strip", sourceUrl: "foo.ts" })).toBe(
      "const x         = 1;\n\n//# sourceURL=foo.ts",
    );
    expect(stripTypeScriptTypes("", { sourceUrl: "foo.ts" })).toBe("\n\n//# sourceURL=foo.ts");
  });

  test("argument validation", () => {
    expect(() => stripTypeScriptTypes({})).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => stripTypeScriptTypes("const x: number = 1;", { mode: "invalid" })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    // This API currently implements strip mode only.
    expect(() => stripTypeScriptTypes("const x: number = 1;", { mode: "transform" })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => stripTypeScriptTypes("const x: number = 1;", { mode: "strip", sourceMap: true })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => stripTypeScriptTypes("x", { sourceUrl: 1 })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    // sourceMap: undefined is explicitly allowed.
    expect(stripTypeScriptTypes("let x: number;", { sourceMap: undefined })).toBe("let x        ;");
  });

  test("unsupported syntax throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", () => {
    const cases = [
      ["enum E { A }", "TypeScript enum is not supported in strip-only mode"],
      ["const enum E { A }", "TypeScript enum is not supported in strip-only mode"],
      ["namespace N { export const x = 1 }", "TypeScript namespace declaration is not supported in strip-only mode"],
      ["module N { }", "`module` keyword is not supported. Use `namespace` instead."],
      ['import x = require("x");', "TypeScript import equals declaration is not supported in strip-only mode"],
      ["export = 1;", "TypeScript export assignment is not supported in strip-only mode"],
      [
        "class C { constructor(private a: number) {} }",
        "TypeScript parameter property is not supported in strip-only mode",
      ],
      ["class C { constructor(readonly a) {} }", "TypeScript parameter property is not supported in strip-only mode"],
      [
        "let b = <string>y;",
        "The angle-bracket syntax for type assertions, `<T>expr`, is not supported in type strip mode. Instead, use the 'as' syntax: `expr as T`.",
      ],
    ];
    for (const [code, message] of cases) {
      expect(() => stripTypeScriptTypes(code)).toThrow(
        expect.objectContaining({
          code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
          name: "SyntaxError",
          message,
        }),
      );
    }
    // Ambient contexts suppress the error (the whole construct is erased).
    expect(stripTypeScriptTypes("declare namespace O { enum E {} }")).toBe("                                 ");
    // Type stripping preserves the source expression grouping.
    expect(() => stripTypeScriptTypes("let x = 1 + 2 as any * 3;")).toThrow(
      expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
    );
    expect(() => stripTypeScriptTypes("let x = 1 + 2 as const * 3;")).toThrow(
      expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
    );
    expect(() => stripTypeScriptTypes("let x = 1 + 2 satisfies any * 3;")).toThrow(
      expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
    );
    expect(() => stripTypeScriptTypes("let x = 1 + 2 as A as B * 3;")).toThrow(
      expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
    );
    expect(stripTypeScriptTypes("let x = 1 + 2 as any + 3;")).toBe("let x = 1 + 2        + 3;");
    expect(stripTypeScriptTypes("let x = (1 + 2) as any * 3;")).toBe("let x = (1 + 2)        * 3;");
  });

  test("invalid syntax throws ERR_INVALID_TYPESCRIPT_SYNTAX", () => {
    expect(() => stripTypeScriptTypes("let x: = 1;")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_TYPESCRIPT_SYNTAX", name: "SyntaxError" }),
    );
    expect(() => stripTypeScriptTypes("let x?: number;")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_TYPESCRIPT_SYNTAX" }),
    );
  });

  test("emits ExperimentalWarning once", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const { stripTypeScriptTypes } = require('node:module');
         stripTypeScriptTypes('let a: number = 1;');
         stripTypeScriptTypes('let b: number = 2;');`,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    const warnings = stderr
      .split("\n")
      .filter(l => l.includes("stripTypeScriptTypes is an experimental feature and might change at any time"));
    expect(warnings).toHaveLength(1);
    expect(exitCode).toBe(0);
  });
});
