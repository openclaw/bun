// moduleLoaderResolve short-circuits keys whose "ns:" prefix matches a
// registered onLoad namespace so the C++ loader doesn't re-resolve a key the
// plugin already produced. A single-letter prefix like "C:" is a Windows
// drive, never a plugin namespace; resolving "C:\\..." with a one-letter
// namespace registered must still reach the filesystem resolver.
import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

test("single-letter plugin namespace does not capture Windows drive paths", async () => {
  using dir = tempDir("plugin-ns-drive-letter", {
    "preload.ts": `
      Bun.plugin({
        name: "single-letter-ns",
        setup(b) {
          for (const ns of ["c", "C"]) {
            b.onLoad({ filter: /.*/, namespace: ns }, () => ({
              contents: "export default 'from-plugin'",
              loader: "js",
            }));
          }
        },
      });
    `,
    // Static import of a non-existent absolute Windows path. moduleLoaderResolve
    // sees the literal "C:\\..." key; the short-circuit must not treat the
    // single-letter "C" prefix as the registered plugin namespace.
    "uses-drive.mjs": `
      import x from "C:\\\\__definitely_missing__\\\\x.js";
      export default x;
    `,
    "entry.mjs": `
      try {
        await import("./uses-drive.mjs");
        console.log("imported");
      } catch (e) {
        console.log("rejected:" + (e && e.constructor && e.constructor.name));
      }
    `,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), "--preload", "./preload.ts", "entry.mjs"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  // Must NOT have produced "imported".
  expect(stdout.trim().startsWith("rejected:")).toBe(true);
  expect(stdout).not.toContain("imported");
  expect(exitCode).toBe(0);
  void stderr;
});

test("onResolve accepts extensionless files and package subpaths", async () => {
  using dir = tempDir("plugin-extensionless-resolve", {
    "real.cjs": `exports.value = 42;`,
    "dependency.mjs": `export { value } from "uninstalled-package/sdk";`,
    "entry.mjs": String.raw`
      import { join } from "node:path";
      const target = join(import.meta.dir, "real.cjs");
      Bun.plugin({
        name: "extensionless-alias",
        setup(build) {
          build.onResolve({ filter: /^(extensionless|uninstalled-package\/sdk)$/ }, () => ({ path: target }));
          build.onResolve({ filter: /^with-extension\.js$/ }, () => ({ path: target, namespace: "file" }));
          build.onResolve({ filter: /^value$/, namespace: "alias" }, args => ({ path: args.path, namespace: "virtual" }));
          build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ exports: { value: 43 }, loader: "object" }));
        },
      });
      console.log(
        (await import("extensionless")).value,
        (await import("./dependency.mjs")).value,
        (await import("with-extension.js")).value,
        (await import("alias:value")).value,
      );
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "--no-install", "entry.mjs"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr }).toEqual({ stdout: "42 42 42 43\n", stderr: "" });
  expect(exitCode).toBe(0);
});
