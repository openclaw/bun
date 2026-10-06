// Use bun:test in Bun, or node:test in Node.js
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import Module from "module";
import { tmpdir } from "os";
import { dirname, join, resolve, toNamespacedPath } from "path";

// Detect runtime and import appropriate test framework
const isBun = typeof Bun !== "undefined";
let test, expect;

if (isBun) {
  ({ test, expect } = await import("bun:test"));
} else {
  // Node.js
  const { createRequire } = await import("module");
  const nodeTest = await import("node:test");
  const assert = await import("node:assert/strict");

  // In Node.js ES modules, require is not available, so create it
  globalThis.require = createRequire(import.meta.url);

  test = nodeTest.test;
  // Create Bun-compatible expect from Node assert
  expect = value => ({
    toBe: expected => assert.strictEqual(value, expected),
    toEqual: expected => assert.deepStrictEqual(value, expected),
    toBeDefined: () => assert.notStrictEqual(value, undefined),
    toThrow: () => {
      // This is used with expect(() => ...)
      assert.throws(value);
    },
  });
}

// Helper to create temp directory - works in both Bun and Node
function createTempDir(prefix, files) {
  // Use realpathSync to resolve symlinks (handles /tmp -> /private/tmp on macOS)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix + "-")));

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    const dirPath = dirname(fullPath);

    // Create parent directories if needed
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  return {
    path: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("Module._resolveFilename respects options.paths for package resolution", () => {
  const { path: dir, cleanup } = createTempDir("module-resolve-paths", {
    "node_modules/test-package/package.json": JSON.stringify({ name: "test-package", main: "index.js" }),
    "node_modules/test-package/index.js": "module.exports = 'test-package';",
  });

  try {
    // Create a fake parent module in a different directory
    const fakeParent = new Module("/some/other/directory/file.js");
    fakeParent.filename = "/some/other/directory/file.js";
    fakeParent.paths = Module._nodeModulePaths("/some/other/directory");

    // Without paths option, this should fail
    expect(() => {
      Module._resolveFilename("test-package", fakeParent);
    }).toThrow();

    // With paths option, this should succeed
    const resolved = Module._resolveFilename("test-package", fakeParent, false, {
      paths: [dir],
    });

    expect(resolved).toBe(resolve(dir, "node_modules/test-package/index.js"));
  } finally {
    cleanup();
  }
});

test("Module._resolveFilename respects options.paths for relative paths", () => {
  const { path: dir, cleanup } = createTempDir("module-resolve-relative", {
    "target.js": "module.exports = 'target';",
  });

  try {
    const fakeParent = new Module("/some/other/directory/file.js");
    fakeParent.filename = "/some/other/directory/file.js";
    fakeParent.paths = Module._nodeModulePaths("/some/other/directory");

    // With paths option pointing to dir, should resolve relative to that dir
    const resolved = Module._resolveFilename("./target.js", fakeParent, false, {
      paths: [dir],
    });

    expect(resolved).toBe(resolve(dir, "target.js"));
  } finally {
    cleanup();
  }
});

test("Module._resolveFilename with overridden function receives options.paths", () => {
  const originalResolveFilename = Module._resolveFilename;
  let capturedOptions;

  try {
    // Override _resolveFilename to capture the options
    Module._resolveFilename = function (request, parent, isMain, options) {
      capturedOptions = options;
      return originalResolveFilename.call(this, request, parent, isMain, options);
    };

    const { path: dir, cleanup } = createTempDir("module-resolve-override", {
      "node_modules/test-pkg/package.json": JSON.stringify({ name: "test-pkg", main: "index.js" }),
      "node_modules/test-pkg/index.js": "module.exports = 'test';",
    });

    try {
      const fakeParent = new Module("/some/other/directory/file.js");
      fakeParent.filename = "/some/other/directory/file.js";
      fakeParent.paths = Module._nodeModulePaths("/some/other/directory");

      const testPaths = [dir];

      // Call _resolveFilename with paths option
      Module._resolveFilename("test-pkg", fakeParent, false, {
        paths: testPaths,
      });

      // Verify the override function received the options with paths
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.paths).toEqual(testPaths);
    } finally {
      cleanup();
    }
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }
});

test("require.resolve respects options.paths for package resolution", () => {
  const { path: dir, cleanup } = createTempDir("require-resolve-paths", {
    "node_modules/resolve-test-pkg/package.json": JSON.stringify({
      name: "resolve-test-pkg",
      main: "index.js",
    }),
    "node_modules/resolve-test-pkg/index.js": "module.exports = 'resolve-test';",
  });

  try {
    // require.resolve should work with paths option
    const resolved = require.resolve("resolve-test-pkg", {
      paths: [dir],
    });

    expect(resolved).toBe(resolve(dir, "node_modules/resolve-test-pkg/index.js"));
  } finally {
    cleanup();
  }
});

test("require.resolve with relative path and options.paths (Next.js use case)", () => {
  // This reproduces the Next.js babel-plugin-react-compiler resolution issue
  const { path: dir, cleanup } = createTempDir("nextjs-style-resolve", {
    "node_modules/babel-plugin-react-compiler/package.json": JSON.stringify({
      name: "babel-plugin-react-compiler",
      main: "dist/index.js",
    }),
    "node_modules/babel-plugin-react-compiler/dist/index.js": "module.exports = {};",
  });

  try {
    // Simulate what Next.js does: resolve a relative path with explicit paths
    const resolved = require.resolve("./node_modules/babel-plugin-react-compiler", {
      paths: [dir],
    });

    expect(resolved).toBe(resolve(dir, "node_modules/babel-plugin-react-compiler/dist/index.js"));
  } finally {
    cleanup();
  }
});

test("Module._resolveFilename throws ERR_INVALID_ARG_TYPE if options.paths is not an array", () => {
  // Test with string (which is iterable but not an array)
  expect(() => {
    Module._resolveFilename("path", __filename, false, { paths: "/some/path" });
  }).toThrow();

  // Test with Set (which is iterable but not an array)
  expect(() => {
    Module._resolveFilename("path", __filename, false, { paths: new Set(["/some/path"]) });
  }).toThrow();

  // Test with object (not iterable)
  expect(() => {
    Module._resolveFilename("path", __filename, false, { paths: { 0: "/some/path" } });
  }).toThrow();
});

(process.platform === "win32" ? test : test.skip)("Windows namespaced paths retain distinct module keys", () => {
  const { path: dir, cleanup } = createTempDir("namespaced-module", {
    "parent.cjs": `module.exports = {
      filename: __filename,
      dirname: __dirname,
      child: require("./child.cjs"),
      resolvedChild: require.resolve("./child.cjs"),
    };`,
    "child.cjs": "module.exports = { value: 42 };",
  });
  try {
    const plain = join(dir, "parent.cjs");
    const namespaced = toNamespacedPath(plain);
    expect(require.resolve(namespaced)).toBe(namespaced);
    const ordinary = require(plain);
    const loaded = require(namespaced);
    expect(loaded === ordinary).toBe(false);
    expect(require(namespaced)).toBe(loaded);
    expect(require.cache[namespaced].exports).toBe(loaded);
    expect(loaded.filename).toBe(namespaced);
    expect(loaded.dirname).toBe(dirname(namespaced));
    expect(loaded.resolvedChild).toBe(toNamespacedPath(join(dir, "child.cjs")));
    expect(loaded.child).toEqual({ value: 42 });
    const fromNamespace = Module.createRequire(namespaced);
    expect(fromNamespace.resolve("./child.cjs")).toBe(loaded.resolvedChild);
    expect(fromNamespace("./child.cjs")).toBe(loaded.child);
  } finally {
    cleanup();
  }
});

(process.platform === "win32" ? test : test.skip)("Windows namespaced native addon keys are not queries", () => {
  const { path: dir, cleanup } = createTempDir("namespaced-addon", { "addon.node": "native addon fixture" });
  const original = process.dlopen;
  try {
    const namespaced = toNamespacedPath(join(dir, "addon.node"));
    let calls = 0;
    process.dlopen = (module, filename) => {
      calls++;
      expect(filename).toBe(namespaced);
      expect(module.id).toBe(namespaced);
      module.exports.loaded = true;
    };
    const loaded = require(namespaced);
    expect(loaded).toEqual({ loaded: true });
    expect(require(namespaced)).toBe(loaded);
    expect(require.cache[namespaced].exports).toBe(loaded);
    expect(calls).toBe(1);
  } finally {
    process.dlopen = original;
    cleanup();
  }
});

for (const spelling of ["backslash", "forward", "mixed"]) {
  (process.platform === "win32" ? test : test.skip)(
    "Windows namespaced addon overrides preserve " + spelling + " cache keys",
    () => {
      const { path: dir, cleanup } = createTempDir("namespaced-addon-override", {
        "addon.node": "native addon fixture",
      });
      const namespaced = toNamespacedPath(join(dir, "addon.node"));
      const key =
        spelling === "forward"
          ? namespaced.replaceAll("\\", "/")
          : spelling === "mixed"
            ? "\\/?/" + namespaced.slice(4)
            : namespaced;
      const alias = "namespaced-addon-override-" + spelling;
      const originalResolve = Module._resolveFilename;
      const originalDlopen = process.dlopen;
      try {
        Module._resolveFilename = function (specifier, ...args) {
          return specifier === alias ? key : Reflect.apply(originalResolve, this, [specifier, ...args]);
        };
        let calls = 0;
        process.dlopen = (module, filename) => {
          calls++;
          expect(module.id).toBe(key);
          expect(toNamespacedPath(filename)).toBe(namespaced);
          module.exports = { loaded: true };
        };
        expect(require.resolve(alias)).toBe(key);
        const loaded = require(alias);
        expect(loaded).toEqual({ loaded: true });
        expect(require(alias)).toBe(loaded);
        expect(require.cache[key].exports).toBe(loaded);
        expect(calls).toBe(1);
      } finally {
        Module._resolveFilename = originalResolve;
        process.dlopen = originalDlopen;
        delete require.cache[key];
        cleanup();
      }
    },
  );
}
