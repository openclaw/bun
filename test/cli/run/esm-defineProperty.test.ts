import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import * as CJSArrayLike from "./cjs-defineProperty-arraylike.cjs";
import * as CJS from "./cjs-defineProperty-fixture.cjs";
import * as Self from "./esm-defineProperty.test.ts";

describe.each([false, true])("nonenumerable CJS exports, __esModule = %s", marker => {
  describe.each([false, true])("with accessor = %s", accessor => {
    test.concurrent.each(["cjs", "js"])("static and dynamic imports from %s", async extension => {
      using dir = tempDir("cjs-hidden-export", {
        "package.json": '{"type":"module"}',
        "nested/package.json": '{"type":"commonjs"}',
        [`nested/dep.${extension}`]: `
          ${marker ? 'Object.defineProperty(exports, "__esModule", { value: true });' : ""}
          exports.default = { answer: 0 };
          exports.answer = 42;
          Object.defineProperty(exports, "hidden", { value: 17 });
          ${
            accessor
              ? `
            Object.defineProperty(exports, "broken", { enumerable: true, get() { throw new Error("getter"); } });
            Object.defineProperty(exports, "invisible", { get() { throw new Error("must not run"); } });
          `
              : ""
          }
        `,
        "entry.mjs": `
          import assert from "node:assert/strict";
          import { hidden, answer } from "./nested/dep.${extension}";
          const namespace = await import("./nested/dep.${extension}");
          assert.equal(hidden, 17);
          assert.equal(answer, 42);
          assert.equal(namespace.hidden, 17);
          assert.equal("invisible" in namespace, false);
          console.log("ok");
        `,
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "entry.mjs"],
        cwd: String(dir),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    });
  });
});

// https://github.com/oven-sh/bun/issues/4432
test("defineProperty", () => {
  expect(CJS.a).toBe(1);
  expect(CJS.b).toBe(2);
  // non-enumerable getter/setter are not copied, matching node.js
  expect(CJS.c).toBe(undefined);

  expect(Bun.inspect(CJS.default)).toBe(`{\n  a: 1,\n  b: 2,\n  c: [Getter],\n}`);
});
export const __esModule = true;
test("shows __esModule if it was exported", () => {
  expect(Bun.inspect(Self)).toBe(`Module {
  __esModule: true,
}`);
  expect(Object.getOwnPropertyNames(Self)).toContain("__esModule");
});

test("arraylike", () => {
  expect(CJSArrayLike[0]).toBe(0);
  expect(CJSArrayLike[1]).toBe(1);
  expect(CJSArrayLike[2]).toBe(3);
  expect(CJSArrayLike[3]).toBe(4);
  expect(CJSArrayLike[4]).toBe(undefined);
  expect(CJSArrayLike).toHaveProperty("4");
  expect(Object.getOwnPropertyNames(CJSArrayLike)).not.toContain("__esModule");
  expect(Object.getOwnPropertyNames(CJSArrayLike.default)).not.toContain("__esModule");
  expect(Bun.inspect(CJSArrayLike)).toBe(`Module {
  "0": 0,
  "1": 1,
  "2": 3,
  "3": 4,
  "4": undefined,
  default: {
    "0": 0,
    "1": 1,
    "2": [Getter],
    "3": 4,
    "4": [Getter],
  },
}`);
});
