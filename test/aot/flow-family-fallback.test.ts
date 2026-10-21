import { expect } from "bun:test";
import { describe, test, unsupported } from "./supported";
import { bunEnv, bunExe, isWindows, tempDirWithBunTypes as tempDir } from "harness";
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { built, slot, spawned } from "./run-programs";

function fixture(name: string): Record<string, string> {
  const dir = join(import.meta.dir, "fixtures", name);
  return Object.fromEntries(
    readdirSync(dir)
      .filter(name => name.endsWith(".ts"))
      .map(name => [`source/${name}`, readFileSync(join(dir, name), "utf8")]),
  );
}
async function run(cwd: string, args: string[], native = false) {
  await using child = Bun.spawn({
    cmd: args,
    cwd,
    env: { ...bunEnv, ...(native ? { BUN_JSC_useJIT: "0", BUN_JSC_crashIfInterpreterIsUsed: "1" } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  return { stdout, stderr, exitCode };
}
async function compileAndRun(files: Record<string, string>, flags: string[] = []) {
  using dir = tempDir("native-flow-fallback", files);
  const cwd = String(dir);
  const name = isWindows ? "app.exe" : "app";
  const built = await run(join(cwd, "source"), [
    bunExe(),
    "build",
    "--compile",
    "--aot",
    "--compile-function-source",
    "--aot-explain=json",
    ...flags,
    "main.ts",
    "--outfile",
    `../${name}`,
  ]);
  if (built.exitCode) return { built, ran: null };
  renameSync(join(cwd, "source"), join(cwd, "hidden-source"));
  const ran = await run(cwd, [join(cwd, name)], true);
  return { built, ran };
}
const cap = () => fixture("flow-family-fallback/shared-11");

test("a real Flow family cap uses untyped native code and explains the original reason", async () => {
  const { built, ran } = await compileAndRun(cap());
  expect(built.exitCode).toBe(0);
  expect(built.stderr).toContain("TS100107");
  expect(built.stderr).toContain("1024");
  expect(built.stdout).toContain('"code":"flow-layout"');
  expect(built.stdout).toContain("1024");
  expect(ran).toEqual({ exitCode: 0, stdout: "forward:66,reverse:66\n", stderr: "" });
}, 120_000);

test("Flow fallback obeys untyped-file deny", async () => {
  const { built, ran } = await compileAndRun(cap(), ["--aot-deny=untyped-file"]);
  expect(built.exitCode).toBe(1);
  expect(built.stderr).toContain("TS100107");
  expect(built.stderr).toContain("[untyped-file]");
  expect(ran).toBeNull();
}, 120_000);

test("allow suppresses the fallback warning but retains its explanation", async () => {
  const { built, ran } = await compileAndRun(cap(), ["--aot-allow=untyped-file"]);
  expect(built.exitCode).toBe(0);
  expect(built.stderr).not.toContain("TS100107");
  expect(built.stdout).toContain('"code":"flow-layout"');
  expect(ran?.exitCode).toBe(0);
}, 120_000);

test("checked execution refuses a Flow family cap instead of losing type checks", async () => {
  using dir = tempDir("checked-flow-cap", cap());
  const ran = await run(join(String(dir), "source"), [bunExe(), "run", "--aot", "main.ts"]);
  expect(ran.exitCode).toBe(1);
  expect(ran.stderr).toContain("Flow");
}, 120_000);

test("a genuine source type error remains fatal", async () => {
  const files = cap();
  files["source/main.ts"] += '\nconst wrong: number = "not a number"; console.log(wrong);\n';
  const { built, ran } = await compileAndRun(files, ["--aot-deny=untyped-file"]);
  expect(built.exitCode).toBe(1);
  expect(built.stderr).toContain("TS2322");
  expect(ran).toBeNull();
}, 120_000);

test("method intersections use bounded fallback instead of missing a required Flow transition", async () => {
  const { built, ran } = await compileAndRun(fixture("flow-method-intersection"));
  expect(built.exitCode).toBe(0);
  expect(built.stderr).toContain("no supported data-field representation");
  expect(built.stdout).toContain('"code":"flow-layout"');
  expect(ran).toEqual({ exitCode: 0, stdout: "b 7\nc 7\n", stderr: "" });
}, 120_000);

test("package fallback retains the Flow reason for every demoted module", async () => {
  const files = Object.fromEntries(
    Object.entries(cap()).map(([path, text]) => [path.replace("source/", "source/node_modules/capped/"), text]),
  );
  files["source/node_modules/capped/package.json"] = JSON.stringify({
    name: "capped",
    type: "module",
    exports: "./main.ts",
  });
  files["source/main.ts"] = 'import "capped";';
  const { built, ran } = await compileAndRun(files);
  expect(built.exitCode).toBe(0);
  expect(built.stdout).toMatch(/"code":"flow-layout"[^\n]*"inDependency":true/);
  expect(ran).toEqual({ exitCode: 0, stdout: "forward:66,reverse:66\n", stderr: "" });
}, 120_000);

test("explicit typed parsing survives a native Flow fallback", async () => {
  const files = cap();
  files["source/main.ts"] += `
const parsed = Bun.parse<{ value: number }>('{"value":42}');
console.log(parsed.value);
let rejectedInvalidJson = false;
try { Bun.parse<{ value: number }>('{"value":"wrong"}'); } catch { rejectedInvalidJson = true; }
if (!rejectedInvalidJson) throw new Error("invalid JSON value accepted");
console.log("rejected");
`;
  const { built, ran } = await compileAndRun(files);
  expect(built.exitCode).toBe(0);
  expect(built.stderr).toContain("TS100107");
  expect(built.stdout).toContain('"code":"flow-layout"');
  expect(ran).toEqual({
    exitCode: 0,
    stdout: "forward:66,reverse:66\n42\nrejected\n",
    stderr: "",
  });
}, 120_000);

describe.skipIf(!!unsupported)("compile/aot/flow-nested-meet", () => {
  test(
    "checked execution does not require native record layouts",
    () =>
      slot(async () => {
        using directory = tempDir("aot-flow-nested-meet-checked", fixture("flow-nested-meet"));
        const result = await spawned(
          [bunExe(), "run", "--aot", "--aot-type-errors=throw", "main.ts"],
          join(String(directory), "source"),
          bunEnv,
        );
        expect(result.stdout).toBe("true true 3 3 1 2\n");
        expect(result.stderr).toBe("");
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(0);
      }),
    60_000,
  );

  for (const depth of [5, 6]) {
    test(
      `a generated meet with ${depth} nested applications preserves aliases`,
      () =>
        slot(async () => {
          const files = fixture("flow-nested-meet");
          if (depth === 5) {
            files["source/types.ts"] = files["source/types.ts"]
              .replace("A<A<A<A<A<A<number>>>>>>", "A<A<A<A<A<number>>>>>")
              .replace("B<B<B<B<B<B<number>>>>>>", "B<B<B<B<B<number>>>>>");
            files["source/main.ts"] = files["source/main.ts"]
              .replace("{ child: { child: 1 } }", "{ child: 1 }")
              .replace("{ child: { child: 2 } }", "{ child: 2 }")
              .replaceAll(".child.child.child.child.child.child", ".child.child.child.child.child");
          }
          using directory = tempDir("aot-flow-nested-meet", files);
          const cwd = join(String(directory), "source");
          const executable = join(String(directory), isWindows ? "program.exe" : "program");
          const result = await spawned(
            [
              bunExe(),
              "build",
              "--compile",
              "--aot",
              "--aot-type-errors=throw",
              "--format=esm",
              "main.ts",
              "--outfile",
              executable,
            ],
            cwd,
            bunEnv,
          );
          built(result);
          expect(result.signal).toBeNull();
          if (depth === 6) {
            expect(result.stderr).toContain("a generated Flow record exceeds the nesting limit");
            expect(result.stderr).toContain("compiled untyped");
          } else {
            expect(result.stderr).not.toContain("compiled untyped");
          }
          for (const name of Object.keys(files)) unlinkSync(join(String(directory), name));
          const ran = await spawned([executable], String(directory), {
            ...bunEnv,
            BUN_JSC_useJIT: "0",
            BUN_JSC_crashIfInterpreterIsUsed: "1",
          });
          expect(ran.stdout).toBe("true true 3 3 1 2\n");
          expect(ran.stderr).toBe("");
          expect(ran.signal).toBeNull();
          expect(ran.exitCode).toBe(0);
        }),
      60_000,
    );
  }

  test(
    "a type error in a nested meet contributor remains fatal",
    () =>
      slot(async () => {
        const files = fixture("flow-nested-meet");
        files["source/left.ts"] = files["source/left.ts"].replace("saved.n += 1;", 'saved.n = "wrong";');
        using directory = tempDir("aot-flow-nested-meet-error", files);
        const cwd = join(String(directory), "source");
        const executable = join(String(directory), isWindows ? "must-not-exist.exe" : "must-not-exist");
        const result = await spawned(
          [
            bunExe(),
            "build",
            "--compile",
            "--aot",
            "--aot-type-errors=throw",
            "--format=esm",
            "main.ts",
            "--outfile",
            executable,
          ],
          cwd,
          bunEnv,
        );
        expect(result.stderr).toContain("TS2322");
        expect(result.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(1);
        expect(existsSync(executable)).toBe(false);
        const checked = await spawned([bunExe(), "run", "--aot", "--aot-type-errors=throw", "main.ts"], cwd, bunEnv);
        expect(checked.stderr).toContain("TS2322");
        expect(checked.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
        expect(checked.signal).toBeNull();
        expect(checked.exitCode).toBe(1);
      }),
    60_000,
  );
});

test("safe validation results keep their union at a native fallback join", async () => {
  const files = fixture("flow-method-intersection");
  files["source/main.ts"] += `
const accepted = Bun.safeValidate<{ value: number }>({ value: 42 });
const refused = Bun.safeValidate<{ value: number }>({ value: "wrong" });
if (!accepted.success || accepted.data.value !== 42 || refused.success || refused.issues.length === 0) {
  throw new Error("safe validation changed after native fallback");
}
console.log("safe", accepted.success, refused.success);
`;
  const { built, ran } = await compileAndRun(files, ["--aot-type-errors=throw"]);
  expect(built.exitCode).toBe(0);
  expect(built.stderr).toContain("no supported data-field representation");
  expect(built.stdout).toContain('"code":"flow-layout"');
  expect(ran).toEqual({ exitCode: 0, stdout: "b 7\nc 7\nsafe true false\n", stderr: "" });
}, 60_000);
