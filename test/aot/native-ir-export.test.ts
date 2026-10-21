import { expect } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { built, slot, spawned } from "./run-programs";
import { beforeAll, describe, test } from "./supported";

const main = `function twice(value: number): number { return value * 2; }\nconsole.log(twice(21));\n`;
const executable = isWindows ? "program.exe" : "program";
const compile = [bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable];
const env = { ...bunEnv, BUN_AOT_NATIVE_IR_EXPORT: undefined, BUN_AOT_TYPED_FILE: undefined };
let typed: Buffer;

beforeAll(
  () =>
    slot(async () => {
      using folder = tempDir("aot-native-ir-input", { "main.ts": main });
      const cwd = String(folder);
      built(await spawned([bunExe(), "check", "--aot", "--aot-out=program.typed", "main.ts"], cwd, env));
      typed = readFileSync(join(cwd, "program.typed"));
    }),
  120_000,
);

function capture(directory: string) {
  const names = readdirSync(directory).filter(name => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  const value = JSON.parse(readFileSync(join(directory, names[0]), "utf8"));
  expect(value.version).toBe(1);
  expect(value.phase).toBe("before-optimize");
  expect(value.complete).toBe(true);
  expect(names[0]).toBe(`${value.pid}-${value.sequence}.json`);
  for (const [extension, entry] of [
    ["ir", value.ir],
    ["replacements", value.replacements],
  ] as const) {
    expect(entry.file).toBe(`${value.pid}-${value.sequence}.${extension}`);
    const bytes = readFileSync(join(directory, entry.file));
    expect(bytes.length).toBe(entry.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
  }
  if (!isWindows) {
    for (const name of [names[0], value.ir.file, value.replacements.file]) {
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
  }
  const ir = readFileSync(join(directory, value.ir.file));
  expect(ir.readUInt32LE(0)).toBe(0x52495442);
  expect(ir.readUInt32LE(4)).toBe(39);
  expect(ir.readBigUInt64LE(8)).toBe(BigInt(ir.length));
  expect(ir.readBigUInt64LE(28)).toBe(324n);
  return {
    path: join(directory, value.ir.file),
    ir,
    replacements: readFileSync(join(directory, value.replacements.file)),
  };
}

describe("compile/aot/native-ir-export", () => {
  test(
    "exports exact early and imported inputs without assets, with no captures when unset",
    () =>
      slot(async () => {
        using folder = tempDir("aot-native-ir-input-roundtrip", {
          "early/.keep": "",
          "imported/.keep": "",
          "main.ts": main,
        });
        const cwd = String(folder);
        const earlyBuild = await spawned(compile, cwd, { ...env, BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "early") });
        built(earlyBuild);
        expect(earlyBuild.stderr).not.toContain("BUN_AOT_NATIVE_IR_EXPORT is set and has no effect");
        const early = capture(join(cwd, "early"));
        expect(early.replacements).toEqual(Buffer.alloc(0));
        const importedBuild = await spawned(compile, cwd, {
          ...env,
          BUN_AOT_TYPED_FILE: early.path,
          BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "imported"),
        });
        built(importedBuild);
        expect(importedBuild.stderr).not.toContain("BUN_AOT_NATIVE_IR_EXPORT is set and has no effect");
        const imported = capture(join(cwd, "imported"));
        expect(imported.ir).toEqual(early.ir);
        expect(imported.replacements).toEqual(early.replacements);
        const run = await spawned([join(cwd, executable)], cwd, env);
        expect({ stdout: run.stdout, exitCode: run.exitCode, signal: run.signal }).toEqual({
          stdout: "42\n",
          exitCode: 0,
          signal: null,
        });
        const captureInventory = () =>
          [cwd, join(cwd, "early"), join(cwd, "imported")].map((path, index) =>
            readdirSync(path)
              .filter(name => index !== 0 || /^[0-9]+-[0-9]+\.(ir|json|replacements)$/.test(name))
              .sort(),
          );
        const before = captureInventory();
        built(await spawned(compile, cwd, env));
        expect(captureInventory()).toEqual(before);
      }),
    120_000,
  );

  test(
    "exports the ordered final asset replacements used by the executable",
    () =>
      slot(async () => {
        using folder = tempDir("aot-native-ir-assets", {
          "early/.keep": "",
          "assets.d.ts": `declare module "*.bin" { const path: string; export default path; }\n`,
          "first.bin": "first",
          "second.bin": "second",
          "main.ts": `/// <reference path="./assets.d.ts" />\nimport first from "./first.bin" with { type: "file" };\nimport second from "./second.bin" with { type: "file" };\nconsole.log(JSON.stringify([first, second]));\nconsole.log(await Bun.file(first).text(), await Bun.file(second).text());\n`,
        });
        const cwd = String(folder);
        const earlyBuild = await spawned(compile, cwd, { ...env, BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "early") });
        built(earlyBuild);
        expect(earlyBuild.stderr).not.toContain("BUN_AOT_NATIVE_IR_EXPORT is set and has no effect");
        const early = capture(join(cwd, "early"));
        const pairs: string[][] = [];
        let offset = 0;
        while (offset < early.replacements.length) {
          const pair: string[] = [];
          for (let index = 0; index < 2; index++) {
            expect(offset + 4).toBeLessThanOrEqual(early.replacements.length);
            const size = early.replacements.readUInt32LE(offset);
            offset += 4;
            expect(offset + size).toBeLessThanOrEqual(early.replacements.length);
            pair.push(early.replacements.subarray(offset, offset + size).toString());
            offset += size;
          }
          pairs.push(pair);
        }
        expect(pairs).toHaveLength(2);
        expect(pairs.every(([from]) => early.ir.includes(Buffer.from(from)))).toBe(true);
        const run = await spawned([join(cwd, executable)], cwd, env);
        const lines = run.stdout.trimEnd().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).sort()).toEqual(pairs.map(([, to]) => to).sort());
        expect(lines[1]).toBe("first second");
        expect({ exitCode: run.exitCode, signal: run.signal }).toEqual({ exitCode: 0, signal: null });
      }),
    120_000,
  );

  test.each(["", "relative", "missing", "file"])(
    "rejects invalid export directory %j",
    value =>
      slot(async () => {
        using folder = tempDir("aot-native-ir-invalid", { "main.ts": main, "file": "sentinel" });
        const cwd = String(folder);
        const path = value === "missing" || value === "file" ? join(cwd, value) : value;
        const build = await spawned(compile, cwd, { ...env, BUN_AOT_NATIVE_IR_EXPORT: path });
        expect(build.stderr).toContain("BUN_AOT_NATIVE_IR_EXPORT");
        expect({ exitCode: build.exitCode, signal: build.signal }).toEqual({ exitCode: 1, signal: null });
        expect(existsSync(join(cwd, executable))).toBe(false);
      }),
    120_000,
  );

  // The fresh build joins the early engine thread; importing IR uses the synchronous encoder.
  for (const route of ["early", "imported"] as const) {
    test.each(["ir", "replacements", "json"])(
      `${route} capture does not overwrite an existing %s and fails the build`,
      extension =>
        slot(async () => {
          using folder = tempDir("aot-native-ir-exclusive", {
            "captures/.keep": "",
            "main.ts": main,
            "program.typed": typed,
            "build.ts": `import { writeFileSync, readFileSync } from "node:fs";\nconst path = import.meta.dir + "/captures/" + process.pid + "-1.${extension}";\nwriteFileSync(path, "sentinel");\nconst result = await Bun.build({ entrypoints: [import.meta.dir + "/main.ts"], compile: { aot: true, outfile: import.meta.dir + "/${executable}" }, throw: false });\nconsole.log(readFileSync(path, "utf8"));\nconsole.error(result.logs.join("\\n"));\nprocess.exit(result.success ? 0 : 1);\n`,
          });
          const cwd = String(folder);
          const build = await spawned([bunExe(), "build.ts"], cwd, {
            ...env,
            BUN_AOT_TYPED_FILE: route === "imported" ? join(cwd, "program.typed") : undefined,
            BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "captures"),
          });
          expect(build.stdout).toBe("sentinel\n");
          expect(build.stderr).toContain("BUN_AOT_NATIVE_IR_EXPORT");
          expect(build.stderr).toContain(`-1.${extension}`);
          expect({ exitCode: build.exitCode, signal: build.signal }).toEqual({ exitCode: 1, signal: null });
          expect(existsSync(join(cwd, executable))).toBe(false);
          if (extension !== "json")
            expect(readdirSync(join(cwd, "captures")).some(name => name.endsWith(".json"))).toBe(false);
        }),
      120_000,
    );
  }
});
