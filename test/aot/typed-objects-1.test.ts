import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { bunEnv, bunExe, tempDir } from "harness";
import { built, programs, slot, spawned, unsupported } from "./run-programs";

programs("typed-objects", 1, 3);

function fixture(name: string): Record<string, string> {
  const directory = join(import.meta.dir, "fixtures", name);
  return Object.fromEntries(readdirSync(directory).map(file => [file, readFileSync(join(directory, file), "utf8")]));
}

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
