import { expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, tempDir } from "harness";
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";

test("chunk hashes cover transitive cycles without changing disconnected entries", async () => {
  using directory = tempDir("chunk-hash-cycle", {
    "entry1.js": 'export { a as value } from "./a.js";',
    "entry2.js": 'export { b as value } from "./b.js";',
    "isolated.js": 'export const value = "isolated";',
    "a.js":
      'import { b } from "./b.js"; import { leaf } from "./leaf.js"; export function a(x) { return x ? b(false) : leaf; }',
    "b.js": 'import { a } from "./a.js"; export function b(x) { return x ? a(false) : "b"; }',
    "leaf.js": 'export const leaf = "before";',
  });
  const root = String(directory);
  const options = {
    entrypoints: ["entry1.js", "entry2.js", "isolated.js"].map(name => join(root, name)),
    target: "bun" as const,
    splitting: true,
    naming: "[name]-[hash].js",
  };
  const before = await Bun.build({ ...options, outdir: join(root, "before") });
  expect(before.success).toBe(true);
  writeFileSync(join(root, "leaf.js"), 'export const leaf = "after";');
  const after = await Bun.build({ ...options, outdir: join(root, "after") });
  expect(after.success).toBe(true);
  for (const entry of ["entry1", "entry2", "isolated"]) {
    const first = before.outputs.find(output => basename(output.path).startsWith(entry + "-"))!;
    const second = after.outputs.find(output => basename(output.path).startsWith(entry + "-"))!;
    expect(typeof first.hash).toBe("string");
    if (entry === "isolated") expect(second.hash).toBe(first.hash);
    else expect(second.hash).not.toBe(first.hash);
  }
  const beforeEntry = before.outputs.find(output => basename(output.path).startsWith("entry1-"))!;
  const afterEntry = after.outputs.find(output => basename(output.path).startsWith("entry1-"))!;
  expect((await import(beforeEntry.path)).value(false)).toBe("before");
  expect((await import(afterEntry.path)).value(false)).toBe("after");
});

const budget = isASAN || isDebug ? 60_000 : 10_000;
test(
  "chunk hashing finishes a long shared dependency chain within its budget",
  async () => {
    using directory = tempDir("chunk-hash-chain", {});
    const root = String(directory);
    const count = 1024;
    for (let i = 0; i < count; i++) {
      writeFileSync(
        join(root, `m${i}.js`),
        i + 1 < count
          ? `import { value as next } from "./m${i + 1}.js"; export const value = next + 1;`
          : "export const value = 0;",
      );
    }
    writeFileSync(
      join(root, "build.mjs"),
      `const result = await Bun.build({
      entrypoints: Array.from({ length: ${count} }, (_, i) => import.meta.dir + "/m" + i + ".js"),
      target: "bun", splitting: true, outdir: import.meta.dir + "/out"
    });
    console.log(result.success, result.outputs.filter(output => output.kind === "entry-point").length);
    `,
    );
    await using child = Bun.spawn({
      cmd: [bunExe(), join(root, "build.mjs")],
      cwd: root,
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout: budget,
      killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    expect({ exitCode, signal: child.signalCode, stdout, stderr }).toEqual({
      exitCode: 0,
      signal: null,
      stdout: `true ${count}\n`,
      stderr: "",
    });
  },
  budget + 5000,
);
