import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { bunEnv, bunExe, tempDir } from "harness";
import { built, programs, slot, spawned, unsupported } from "./run-programs";

programs("typed-objects", 1, 3);

function fixture(name: string): Record<string, string> {
  const directory = join(import.meta.dir, "fixtures", name);
  const files: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".ts")) files[name] = readFileSync(join(directory, name), "utf8");
  }
  files["tsconfig.json"] = JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "Preserve",
      moduleResolution: "Bundler",
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [join(import.meta.dir, "..", "..", "packages")],
      types: ["bun-types"],
    },
    include: ["*.ts"],
  });
  return files;
}

describe.skipIf(!!unsupported)("compile/aot/flow-family-fallback", () => {
  for (const count of [9, 11] as const) {
    test(`${count} refinements preserve old aliases in source-free native execution`, () =>
      slot(async () => {
        const files = fixture(`flow-family-fallback/shared-${count}`);
        using directory = tempDir("aot-flow-family", files);
        const cwd = String(directory);
        const executable = join(cwd, "program");
        const result = await spawned([
          bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
          "--format=esm", "main.ts", "--outfile", executable,
        ], cwd, bunEnv);
        built(result);
        expect(result.signal).toBeNull();
        if (count === 11) {
          expect(result.stderr).toContain("Flow family");
          expect(result.stderr).toContain("compiled untyped");
        } else {
          expect(result.stderr).not.toContain("compiled untyped");
        }
        for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
        const ran = await spawned([executable], cwd, {
          ...bunEnv,
          BUN_JSC_useJIT: "0",
          BUN_JSC_crashIfInterpreterIsUsed: "1",
          BUN_AOT_VERBOSE: "1",
        });
        expect(ran.signal).toBeNull();
        expect(ran.exitCode).toBe(0);
        expect(ran.stdout).toBe(count === 11 ? "forward:66,reverse:66\n" : "forward:45,reverse:45\n");
        expect(ran.stderr).toContain("[aot] module: ");
        expect(ran.stderr.replace(/^\[aot\] .*\n/gm, "")).toBe("");
      }), 60_000);
  }

  for (const placement of ["contributor", "unrelated"] as const) {
    test(`real TypeScript error in ${placement} remains fatal`, () =>
      slot(async () => {
        const files = fixture("flow-family-fallback/shared-11");
        if (placement === "contributor") {
          files["narrow-1.ts"] = files["narrow-1.ts"].replace("alias.value += 1;", 'alias.value = "wrong";');
        } else {
          files["unrelated.ts"] = 'export function unrelated(): number { return "wrong"; }\n';
          files["main.ts"] = 'import { unrelated } from "./unrelated.ts";\n' + files["main.ts"] + '\nconsole.log(unrelated());\n';
        }
        using directory = tempDir("aot-flow-family-error", files);
        const cwd = String(directory);
        const result = await spawned([
          bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
          "--format=esm", "main.ts", "--outfile", join(cwd, "must-not-exist"),
        ], cwd, bunEnv);
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
        expect(existsSync(join(cwd, "must-not-exist"))).toBe(false);
      }), 60_000);
  }
});


describe.skipIf(!!unsupported)("compile/aot/flow-task-owner-fallback", () => {
  test("unresolved native intersections preserve source-free execution", () =>
    slot(async () => {
      const files = fixture("flow-task-owner-fallback");
      const expected = readFileSync(join(import.meta.dir, "fixtures", "flow-task-owner-fallback", "expected.txt"), "utf8");
      using directory = tempDir("aot-flow-task-owner", files);
      const cwd = String(directory);
      const executable = join(cwd, "program");
      const result = await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv);
      built(result);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain("compiled untyped");
      for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
      const ran = await spawned([executable], cwd, {
        ...bunEnv,
        BUN_JSC_useJIT: "0",
        BUN_JSC_crashIfInterpreterIsUsed: "1",
        BUN_AOT_VERBOSE: "1",
      });
      expect(ran.signal).toBeNull();
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toBe(expected);
      expect(ran.stderr).toContain("[aot] module: ");
      expect(ran.stderr.replace(/^\[aot\] .*\n/gm, "")).toBe("");
    }), 60_000);

  test("real TypeScript errors in a native task owner remain fatal", () =>
    slot(async () => {
      const files = fixture("flow-task-owner-fallback");
      files["left.ts"] = files["left.ts"].replace("saved.value += 1;", 'saved.value = "wrong";');
      using directory = tempDir("aot-flow-task-owner-error", files);
      const cwd = String(directory);
      const executable = join(cwd, "must-not-exist");
      const result = await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv);
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
      expect(existsSync(executable)).toBe(false);
    }), 60_000);
});
