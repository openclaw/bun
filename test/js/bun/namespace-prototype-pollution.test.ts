import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

test("namespace imports should not inherit from Object.prototype", async () => {
  await using dir = tempDir("namespace-pollution", {
    "mod.mjs": `export const value = "original";`,
    "test.mjs": `
      import * as mod from './mod.mjs';

      Object.prototype.maliciousFunction = function() {
        return 'POLLUTION_SUCCESS';
      };

      // This should throw - namespace shouldn't inherit from Object.prototype
      try {
        mod.maliciousFunction();
        console.log("FAIL: prototype pollution succeeded");
      } catch {
        console.log("PASS: prototype pollution prevented");
      }

      console.log("Null prototype:", Object.getPrototypeOf(mod) === null);
      console.log("__esModule absent:", !("__esModule" in mod));
      console.log("__esModule immutable:", !Reflect.set(mod, "__esModule", true));

      // Original exports should work
      console.log("Original export:", mod.value);
    `,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), "test.mjs"],
    env: bunEnv,
    cwd: dir,
    stdout: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("PASS: prototype pollution prevented");
  expect(stdout).toContain("Null prototype: true");
  expect(stdout).toContain("__esModule absent: true");
  expect(stdout).toContain("__esModule immutable: true");
  expect(stdout).toContain("Original export: original");
});
