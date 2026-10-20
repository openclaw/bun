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

describe.skipIf(!!unsupported)("compile/aot/flow-redefined-meet", () => {
  for (const redefined of [true, false]) {
    test(`a generated meet ${redefined ? "with" : "without"} property redefinition runs natively`, () =>
      slot(async () => {
        const files = fixture("flow-redefined-meet");
        if (!redefined) {
          files["redefine.ts"] = files["redefine.ts"].replace(
            'Object.defineProperty(value, "a", { configurable: true, get() { return "x"; } });',
            "void value;",
          );
        }
        using directory = tempDir("aot-flow-redefined-meet", files);
        const cwd = String(directory);
        const executable = join(cwd, "program");
        const result = await spawned([
          bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
          "--format=esm", "main.ts", "--outfile", executable,
        ], cwd, bunEnv);
        built(result);
        expect(result.signal).toBeNull();
        if (redefined) {
          expect(result.stderr).toContain("a generated Flow record may be redefined");
          expect(result.stderr).toContain("compiled untyped");
        } else {
          expect(result.stderr).not.toContain("compiled untyped");
        }
        for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
        const ran = await spawned([executable], cwd, {
          ...bunEnv,
          BUN_JSC_useJIT: "0",
          BUN_JSC_crashIfInterpreterIsUsed: "1",
        });
        expect(ran.stdout).toBe("3 x\n");
        expect(ran.stderr).toBe("");
        expect(ran.signal).toBeNull();
        expect(ran.exitCode).toBe(0);
      }), 60_000);
  }

  test("a type error in a redefined meet contributor remains fatal", () =>
    slot(async () => {
      const files = fixture("flow-redefined-meet");
      files["left.ts"] = files["left.ts"].replace("saved.n += 1;", 'saved.n = "wrong";');
      using directory = tempDir("aot-flow-redefined-meet-error", files);
      const cwd = String(directory);
      const executable = join(cwd, "must-not-exist");
      const result = await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv);
      expect(result.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(1);
      expect(existsSync(executable)).toBe(false);
    }), 60_000);
});

describe.skipIf(!!unsupported)("compile/aot/flow-nested-meet", () => {
  test("checked execution does not require native record layouts", () =>
    slot(async () => {
      using directory = tempDir("aot-flow-nested-meet-checked", fixture("flow-nested-meet"));
      const result = await spawned([
        bunExe(), "run", "--aot", "--aot-type-errors=throw", "main.ts",
      ], String(directory), bunEnv);
      expect(result.stdout).toBe("true true 3 3 1 2\n");
      expect(result.stderr).toBe("");
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(0);
    }), 60_000);

  for (const depth of [5, 6]) {
    test(`a generated meet with ${depth} nested applications preserves aliases`, () =>
      slot(async () => {
        const files = fixture("flow-nested-meet");
        if (depth === 5) {
          files["types.ts"] = files["types.ts"]
            .replace("A<A<A<A<A<A<number>>>>>>", "A<A<A<A<A<number>>>>>")
            .replace("B<B<B<B<B<B<number>>>>>>", "B<B<B<B<B<number>>>>>");
          files["main.ts"] = files["main.ts"]
            .replace("{ child: { child: 1 } }", "{ child: 1 }")
            .replace("{ child: { child: 2 } }", "{ child: 2 }")
            .replaceAll(".child.child.child.child.child.child", ".child.child.child.child.child");
        }
        using directory = tempDir("aot-flow-nested-meet", files);
        const cwd = String(directory);
        const executable = join(cwd, "program");
        const result = await spawned([
          bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
          "--format=esm", "main.ts", "--outfile", executable,
        ], cwd, bunEnv);
        built(result);
        expect(result.signal).toBeNull();
        if (depth === 6) {
          expect(result.stderr).toContain("a generated Flow record exceeds the nesting limit");
          expect(result.stderr).toContain("compiled untyped");
        } else {
          expect(result.stderr).not.toContain("compiled untyped");
        }
        for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
        const ran = await spawned([executable], cwd, {
          ...bunEnv,
          BUN_JSC_useJIT: "0",
          BUN_JSC_crashIfInterpreterIsUsed: "1",
        });
        expect(ran.stdout).toBe("true true 3 3 1 2\n");
        expect(ran.stderr).toBe("");
        expect(ran.signal).toBeNull();
        expect(ran.exitCode).toBe(0);
      }), 60_000);
  }

  test("a type error in a nested meet contributor remains fatal", () =>
    slot(async () => {
      const files = fixture("flow-nested-meet");
      files["left.ts"] = files["left.ts"].replace("saved.n += 1;", 'saved.n = "wrong";');
      using directory = tempDir("aot-flow-nested-meet-error", files);
      const cwd = String(directory);
      const executable = join(cwd, "must-not-exist");
      const result = await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv);
      expect(result.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(1);
      expect(existsSync(executable)).toBe(false);
      const checked = await spawned([
        bunExe(), "run", "--aot", "--aot-type-errors=throw", "main.ts",
      ], cwd, bunEnv);
      expect(checked.stderr).toMatch(/Type 'string' is not assignable to type 'number'/);
      expect(checked.signal).toBeNull();
      expect(checked.exitCode).toBe(1);
    }), 60_000);
});


describe.skipIf(!!unsupported)("compile/aot/spread-discriminant", () => {
  for (const variant of ["spread", "explicit-key", "absent-optional", "override"] as const) {
    test(`${variant} preserves the selected union arm`, () =>
      slot(async () => {
        const files = fixture("spread-discriminant");
        if (variant === "explicit-key") {
          files["caller.ts"] = files["caller.ts"].replace(
            '{ ...request, projection: "sharing" }',
            '{ ...request, sessionKeys: request.sessionKeys, projection: "sharing" }',
          );
        } else if (variant === "absent-optional") {
          files["main.ts"] = 'import { read } from "./reader.ts";\n' +
            'const result = await read({ agentId: "a", storePath: "s", sessionKeys: ["selected"], projection: "sharing" });\n' +
            'console.log(result.entries[0]?.sessionKey);\n';
        } else if (variant === "override") {
          files["main.ts"] = 'import { read } from "./reader.ts";\n' +
            'const previous = { agentId: "a", storePath: "s", sessionKeys: ["stale"] };\n' +
            'const result = await read({ ...previous, sessionKeys: undefined, selection: { kind: "session-id", sessionId: "selected" }, projection: "sharing" });\n' +
            'console.log(result.entries[0]?.sessionKey);\n';
        }
        const expected = variant === "spread" || variant === "explicit-key" ? "ok sharing\n" : "selected\n";
        using directory = tempDir("aot-spread-discriminant", files);
        const cwd = String(directory);
        for (const flags of [[], ["--aot", "--aot-type-errors=throw"]]) {
          const result = await spawned([bunExe(), "run", ...flags, "main.ts"], cwd, bunEnv);
          expect(result.signal).toBeNull();
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toBe(expected);
          expect(result.stderr).toBe("");
        }
        const executable = join(cwd, "program");
        built(await spawned([
          bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
          "--format=esm", "main.ts", "--outfile", executable,
        ], cwd, bunEnv));
        for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
        const native = await spawned([executable], cwd, {
          ...bunEnv, BUN_JSC_useJIT: "0", BUN_JSC_crashIfInterpreterIsUsed: "1",
        });
        expect(native.signal).toBeNull();
        expect(native.exitCode).toBe(0);
        expect(native.stdout).toBe(expected);
        expect(native.stderr).toBe("");
      }), 60_000);
  }

});

describe.skipIf(!!unsupported)("compile/aot/logical-fallback", () => {
  test("fallbacks keep their own fields and contextually inferred callback types", () =>
    slot(async () => {
      const files = fixture("logical-fallback");
      using directory = tempDir("aot-logical-fallback", files);
      const cwd = String(directory);
      const expected = '[null,null]\n[null,null]\n2.0\nfallback 2.00\n[["session"],["default"]]\n[["session"],["default"]]\n2\npresent 2\n';
      for (const flags of [[], ["--aot", "--aot-type-errors=throw"]]) {
        const result = await spawned([bunExe(), "run", ...flags, "main.ts"], cwd, bunEnv);
        expect(result.stdout).toBe(expected);
        expect(result.stderr).toBe("");
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(0);
      }
      const executable = join(cwd, "program");
      built(await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv));
      for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
      const native = await spawned([executable], cwd, {
        ...bunEnv, BUN_JSC_useJIT: "0", BUN_JSC_crashIfInterpreterIsUsed: "1",
      });
      expect(native.stdout).toBe(expected);
      expect(native.stderr).toBe("");
      expect(native.signal).toBeNull();
      expect(native.exitCode).toBe(0);
    }), 60_000);

  test("an annotated fallback still rejects missing required fields", () =>
    slot(async () => {
      const files = fixture("logical-fallback");
      files["main.ts"] = 'import { readProjection, type Result } from "./producer.ts";\n' +
        'const result: Result = (await readProjection(false)) ?? {};\n' +
        'console.log(result);\n';
      using directory = tempDir("aot-logical-fallback-error", files);
      const cwd = String(directory);
      const checked = await spawned([bunExe(), "run", "--aot", "--aot-type-errors=throw", "main.ts"], cwd, bunEnv);
      expect(checked.stderr).toContain("TS2322");
      expect(checked.signal).toBeNull();
      expect(checked.exitCode).toBe(1);
      const executable = join(cwd, "must-not-exist");
      const compiled = await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv);
      expect(compiled.stderr).toContain("TS2322");
      expect(compiled.signal).toBeNull();
      expect(compiled.exitCode).toBe(1);
      expect(existsSync(executable)).toBe(false);
    }), 60_000);

  test("an explicit cast around a fallback still enforces required fields", () =>
    slot(async () => {
      const files = fixture("logical-fallback");
      files["main.ts"] = 'import { readProjection, type Result } from "./producer.ts";\n' +
        'declare const console: { log(...values: unknown[]): void };\n' +
        'function unwrap(data: unknown): Result { return (data ?? {}) as Result; }\n' +
        'console.log((await readProjection(true))?.sessionModelCatalog[0]);\n' +
        'console.log(unwrap(JSON.parse("null")).sessionModelCatalog);\n';
      using directory = tempDir("aot-logical-fallback-cast", files);
      const cwd = String(directory);
      const ordinary = await spawned([bunExe(), "run", "main.ts"], cwd, bunEnv);
      expect(ordinary.stdout).toBe("session\nundefined\n");
      expect(ordinary.stderr).toBe("");
      expect(ordinary.signal).toBeNull();
      expect(ordinary.exitCode).toBe(0);
      const checked = await spawned([bunExe(), "run", "--aot", "--aot-type-errors=throw", "main.ts"], cwd, bunEnv);
      expect(checked.stdout).toBe("session\n");
      expect(checked.stderr).toContain("property 'sessionModelCatalog' is missing");
      expect(checked.signal).toBeNull();
      expect(checked.exitCode).toBe(1);
      const executable = join(cwd, "program");
      built(await spawned([
        bunExe(), "build", "--compile", "--aot", "--aot-type-errors=throw",
        "--format=esm", "main.ts", "--outfile", executable,
      ], cwd, bunEnv));
      for (const name of Object.keys(files)) unlinkSync(join(cwd, name));
      const native = await spawned([executable], cwd, {
        ...bunEnv, BUN_JSC_useJIT: "0", BUN_JSC_crashIfInterpreterIsUsed: "1",
      });
      expect(native.stdout).toBe("session\n");
      expect(native.stderr).toContain("property 'sessionModelCatalog' is missing");
      expect(native.signal).toBeNull();
      expect(native.exitCode).toBe(1);
    }), 60_000);
});
