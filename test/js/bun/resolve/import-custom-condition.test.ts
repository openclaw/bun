import { beforeAll, expect, it } from "bun:test";
import { writeFileSync } from "fs";
import { bunEnv, bunExe, tempDir, tempDirWithFiles } from "harness";

function moduleSyncFiles() {
  const selection = { "module-sync": "./sync.mjs", import: "./other.mjs", require: "./other.cjs" };
  return {
    "package.json": JSON.stringify({
      name: "condition-owner",
      type: "commonjs",
      imports: { "#selected": selection },
      exports: {
        "./selected": selection,
        "./commonjs": { "module-sync": "./commonjs.js", default: "./other.cjs" },
        "./nested": { node: selection, default: "./other.mjs" },
        "./ordered": { import: "./other.mjs", require: "./other.cjs", "module-sync": "./sync.mjs" },
        "./custom": { custom: "./custom.mjs", "module-sync": "./sync.mjs", default: "./other.mjs" },
        "./bun-first": { bun: "./bun.mjs", "module-sync": "./sync.mjs", default: "./other.mjs" },
        "./async": { "module-sync": "./async.mjs", default: "./other.mjs" },
        "./bundle": { "module-sync": "./sync.mjs", default: "./other.mjs" },
      },
    }),
    "sync.mjs": 'export const value = "sync";',
    "other.mjs": 'export const value = "other";',
    "other.cjs": 'exports.value = "other";',
    "commonjs.js": 'module.exports = { value: "commonjs" };',
    "custom.mjs": 'export const value = "custom";',
    "bun.mjs": 'export const value = "bun";',
    "async.mjs": 'await new Promise(() => {}); export const value = "async";',
    "bundle.mjs": 'import { value } from "condition-owner/bundle"; console.log(value);',
    "entry.mjs": `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { value as staticValue } from "condition-owner/selected";
      const require = createRequire(import.meta.url);
      assert.equal(staticValue, "sync");
      for (const specifier of ["#selected", "condition-owner/selected", "condition-owner/nested"]) {
        assert.equal(require(specifier).value, "sync");
        assert.equal((await import(specifier)).value, "sync");
      }
      assert.equal(require("condition-owner/commonjs").value, "commonjs");
      assert.equal((await import("condition-owner/commonjs")).default.value, "commonjs");
      assert.equal(require("condition-owner/ordered").value, "other");
      assert.equal((await import("condition-owner/ordered")).value, "other");
      assert.equal(require("condition-owner/custom").value, process.argv[2]);
      assert.equal((await import("condition-owner/custom")).value, process.argv[2]);
      assert.equal(require("condition-owner/bun-first").value, process.argv[3]);
      assert.equal((await import("condition-owner/bun-first")).value, process.argv[3]);
      assert.throws(() => require("condition-owner/async"), /require[(][)].*import[(][)]/);
      console.log("module-sync runtime selection passed");
    `,
  };
}

it.concurrent.each([false, true])(
  "module-sync default condition preserves import/require selection (custom=%s)",
  async custom => {
    using fixture = tempDir("module-sync-condition", moduleSyncFiles());
    await using proc = Bun.spawn({
      cmd: [bunExe(), ...(custom ? ["--conditions=custom"] : []), "entry.mjs", custom ? "custom" : "sync", "bun"],
      cwd: String(fixture),
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "module-sync runtime selection passed\n",
      stderr: "",
      exitCode: 0,
    });
  },
);

it.concurrent.each(["bun", "node", "browser"] as const)(
  "module-sync default condition follows the %s build target",
  async target => {
    using fixture = tempDir("module-sync-build", moduleSyncFiles());
    const result = await Bun.build({ entrypoints: [`${fixture}/bundle.mjs`], target });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", await result.outputs[0].text()],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: target === "browser" ? "other\n" : "sync\n",
      stderr: "",
      exitCode: 0,
    });
  },
);

let dir: string;

beforeAll(() => {
  dir = tempDirWithFiles("customcondition", {
    "./node_modules/custom/index.js": "export const foo = 1;",
    "./node_modules/custom/browser.js": "export const foo = 2;",
    "./node_modules/custom/not_allow.js": "throw new Error('should not be imported')",
    "./node_modules/custom/package.json": JSON.stringify({
      name: "custom",
      exports: {
        "./test": {
          first: "./index.js",
          browser: "./browser.js",
          default: "./not_allow.js",
        },
      },
    }),

    "./node_modules/custom2/index.cjs": "module.exports.foo = 5;",
    "./node_modules/custom2/index.mjs": "export const foo = 1;",
    "./node_modules/custom2/not_allow.js": "throw new Error('should not be imported')",
    "./node_modules/custom2/package.json": JSON.stringify({
      name: "custom2",
      exports: {
        "./test": {
          first: {
            import: "./index.mjs",
            require: "./index.cjs",
            default: "./index.mjs",
          },
          default: "./not_allow.js",
        },
        "./test2": {
          second: {
            import: "./index.mjs",
            require: "./index.cjs",
            default: "./index.mjs",
          },
          default: "./not_allow.js",
        },
        "./test3": {
          third: {
            import: "./index.mjs",
            require: "./index.cjs",
            default: "./index.mjs",
          },
          default: "./not_allow.js",
        },
      },
      type: "module",
    }),
  });

  writeFileSync(`${dir}/test.js`, `import {foo} from 'custom/test';\nconsole.log(foo);`);
  writeFileSync(`${dir}/test.test.js`, `import {foo} from 'custom/test';\nconsole.log(foo);`);
  writeFileSync(`${dir}/test.cjs`, `const {foo} = require("custom2/test");\nconsole.log(foo);`);
  writeFileSync(
    `${dir}/multiple-conditions.js`,
    `const pkg1 = require("custom2/test");\nconst pkg2 = require("custom2/test2");\nconst pkg3 = require("custom2/test3");\nconsole.log(pkg1.foo, pkg2.foo, pkg3.foo);`,
  );

  writeFileSync(
    `${dir}/package.json`,
    JSON.stringify(
      {
        name: "hello",
        imports: {
          custom: "custom",
          custom2: "custom2",
        },
      },
      null,
      2,
    ),
  );
});

it("custom condition 'import' in package.json resolves", async () => {
  const { exitCode, stdout } = Bun.spawnSync({
    cmd: [bunExe(), "--conditions=first", `${dir}/test.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(0);
  expect(stdout.toString("utf8")).toBe("1\n");
});

it("custom condition 'import' in package.json resolves with browser condition", async () => {
  const { exitCode, stdout } = Bun.spawnSync({
    cmd: [bunExe(), "--conditions=browser", `${dir}/test.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(0);
  expect(stdout.toString("utf8")).toBe("2\n");
});

it("custom condition 'import' in package.json resolves in bun test", async () => {
  const { exitCode, stdout } = Bun.spawnSync({
    cmd: [bunExe(), "test", "--conditions=first", `${dir}/test.test.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(0);
  expect(stdout.toString("utf8")).toBe(`bun test ${Bun.version_with_sha}\n1\n`);
});

it("custom condition 'import' in package.json resolves in bun test with browser condition", async () => {
  const { exitCode, stdout } = Bun.spawnSync({
    cmd: [bunExe(), "test", "--conditions=browser", `${dir}/test.test.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(0);
  expect(stdout.toString("utf8")).toBe(`bun test ${Bun.version_with_sha}\n2\n`);
});

it("custom condition 'require' in package.json resolves", async () => {
  const { exitCode, stdout } = Bun.spawnSync({
    cmd: [bunExe(), "--conditions=first", `${dir}/test.cjs`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(0);
  expect(stdout.toString("utf8")).toBe("5\n");
});

it("multiple conditions in package.json resolves", async () => {
  const { exitCode, stdout } = Bun.spawnSync({
    cmd: [bunExe(), "--conditions=first", "--conditions=second", "--conditions=third", `${dir}/multiple-conditions.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(0);
  expect(stdout.toString("utf8")).toBe("5 5 5\n");
});

it("multiple conditions when some not specified should resolves to fallback", async () => {
  const { exitCode, stderr } = Bun.spawnSync({
    cmd: [bunExe(), "--conditions=first", "--conditions=second", `${dir}/multiple-conditions.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(1);

  // not_allow.js is the fallback for third condition, so it should be in stderr
  expect(stderr.toString("utf8")).toMatch("new Error('should not be imported')");
});

it("custom condition when don't match condition should resolves to default", async () => {
  const { exitCode } = Bun.spawnSync({
    cmd: [bunExe(), "--conditions=first1", `${dir}/test.js`],
    env: bunEnv,
    cwd: import.meta.dir,
  });

  expect(exitCode).toBe(1);
});
