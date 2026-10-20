import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { createHash } from "node:crypto";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "path";
import { built, slot, spawned, unsupported } from "./run-programs";

describe.skipIf(!!unsupported)("compile/aot/native-source-trace", () => {
  test("native modes share the source sink without changing source event identity", () =>
    slot(async () => {
      using folder = tempDir("aot-native-source-trace", {
        "tsconfig.json": JSON.stringify({ compilerOptions: {
          strict: true, target: "ESNext", module: "Preserve", moduleResolution: "Bundler",
          typeRoots: [join(import.meta.dir, "..", "..", "packages")], types: ["bun-types"],
        } }),
        "main.ts": readFileSync(join(import.meta.dir, "programs", "typed-objects", "inline-nested-record-flow-eight.ts"), "utf8"),
      });
      const cwd = String(folder);
      for (const [mode, maxBytes] of [["0", undefined], ["functions", undefined], ["queries", undefined], ["functions", "1"]] as const) {
        const name = maxBytes === undefined ? mode : `${mode}-${maxBytes}`;
        const trace = join(cwd, `${name}.jsonl`);
        const result = await spawned(
          [bunExe(), "check", "--aot", "--threads=1", "--no-builtin-modules", `--aot-out=${join(cwd, `${name}.bin`)}`, "main.ts"],
          cwd,
          { ...bunEnv, BUN_AOT_SOURCE_TRACE: trace, BUN_AOT_SOURCE_TRACE_MAX_BYTES: maxBytes, BUN_AOT_NATIVE_TRACE: mode, BUN_AOT_NATIVE_TRACE_FILTER: "main.ts" },
        );
        built(result);
        expect(result.signal).toBeNull();
        const raw = readFileSync(trace, "utf8");
        if (maxBytes !== undefined) {
          expect(raw).toBe('{"event":"trace_limit","complete":false}\n');
          continue;
        }
        expect(raw.endsWith("\n")).toBe(true);
        const events: { event: string; domain?: string; phase?: string; span?: number; body_span?: number; closure_span?: number; file?: number; function?: number; ir_function?: number; pairs?: number; scanned?: number; comparisons?: number }[] = raw
          .trim()
          .split("\n")
          .map(line => JSON.parse(line));
        expect(events.some(event => event.event === "trace_limit")).toBe(false);
        const source = events.filter(event => event.domain === undefined);
        expect(source.some(event => event.phase === "source_search" && event.event === "end")).toBe(true);
        const native = events.filter(event => event.domain === "native_ir");
        const closure = events.filter(event => event.domain === "link_flow_layouts");
        if (mode === "0") {
          expect(native).toEqual([]);
          expect(closure).toEqual([]);
          continue;
        }
        expect(native.some(event => event.phase === "native_function" && event.event === "start")).toBe(true);
        const queries = native.filter(event => event.phase !== "native_function");
        if (mode === "functions") {
          expect(queries).toEqual([]);
          expect(closure).toEqual([]);
        } else {
          expect(closure.some(event => event.phase === "intersection_for_flow_cast")).toBe(true);
          const closureStarts = closure.filter(event => event.event === "start");
          const closureEnds = closure.filter(event => event.event === "end");
          expect(closureEnds.map(event => event.span).sort()).toEqual(closureStarts.map(event => event.span).sort());
          const owners = new Set(closureStarts.filter(event => event.phase === "flow_layout_closure").map(event => event.span));
          expect(closure.every(event => owners.has(event.closure_span))).toBe(true);
          expect(closure.every(event => event.body_span === undefined && event.file === undefined && event.function === undefined && event.ir_function === undefined)).toBe(true);
          const finished = closureEnds.filter(event => event.phase === "flow_layout_closure");
          expect(finished.length).toBeGreaterThan(0);
          expect(finished.every(event => event.scanned === event.pairs && event.comparisons === event.pairs)).toBe(true);
        }
        const starts = native.filter(event => event.event === "start");
        const ends = native.filter(event => event.event === "end");
        expect(ends.map(event => event.span).sort()).toEqual(starts.map(event => event.span).sort());
        const bodies = new Set(starts.filter(event => event.phase === "native_function").map(event => event.body_span));
        expect(native.every(event => bodies.has(event.body_span))).toBe(true);
      }
    }), 30_000);
});

describe.skipIf(!!unsupported)("compile/aot/native-ir-export", () => {
  function receipt(directory: string) {
    const names = readdirSync(directory).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const value = JSON.parse(readFileSync(join(directory, names[0]), "utf8"));
    expect(value.version).toBe(1);
    expect(value.phase).toBe("before-optimize");
    expect(value.complete).toBe(true);
    expect(names[0]).toBe(`${value.pid}-${value.sequence}.json`);
    for (const [extension, entry] of [["ir", value.ir], ["replacements", value.replacements]] as const) {
      expect(entry.file).toBe(`${value.pid}-${value.sequence}.${extension}`);
      const bytes = readFileSync(join(directory, entry.file));
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
    const ir = readFileSync(join(directory, value.ir.file));
    expect(ir.readUInt32LE(0)).toBe(0x52495442);
    expect(ir.readUInt32LE(4)).toBe(38);
    return { ir, replacements: readFileSync(join(directory, value.replacements.file)) };
  }

  test("exports exact engine inputs for early and imported IR, with no files when unset", () =>
    slot(async () => {
      using folder = tempDir("aot-native-ir-export", {
        "main.ts": `function twice(value: number): number { return value * 2; }\nconsole.log(twice(21));\n`,
        "early/.keep": "", "direct/.keep": "",
      });
      const cwd = String(folder);
      const compile = [bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", "program"];
      built(await spawned(compile, cwd, { ...bunEnv, BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "early") }));
      const early = receipt(join(cwd, "early"));
      expect(early.replacements).toEqual(Buffer.alloc(0));
      const irPath = join(cwd, "early", readdirSync(join(cwd, "early")).find(name => name.endsWith(".ir"))!);
      built(await spawned(compile, cwd, {
        ...bunEnv, BUN_AOT_TYPED_FILE: irPath, BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "direct"),
      }));
      const direct = receipt(join(cwd, "direct"));
      expect(direct.ir).toEqual(early.ir);
      expect(direct.replacements).toEqual(early.replacements);
      const run = await spawned([join(cwd, "program")], cwd, bunEnv);
      expect({ stdout: run.stdout, exitCode: run.exitCode }).toEqual({ stdout: "42\n", exitCode: 0 });
      const before = readdirSync(cwd).sort();
      built(await spawned(compile, cwd, { ...bunEnv, BUN_AOT_NATIVE_IR_EXPORT: undefined }));
      expect(readdirSync(cwd).sort()).toEqual(before);
    }), 30_000);

  test("exports the ordered final asset replacements used by the executable", () =>
    slot(async () => {
      using folder = tempDir("aot-native-ir-assets", {
        "captures/.keep": "",
        "assets.d.ts": `declare module "*.bin" { const path: string; export default path; }\n`,
        "first.bin": "first", "second.bin": "second",
        "main.ts": `/// <reference path="./assets.d.ts" />\nimport first from "./first.bin" with { type: "file" };\nimport second from "./second.bin" with { type: "file" };\nconsole.log(JSON.stringify([first, second]));\nconsole.log(await Bun.file(first).text(), await Bun.file(second).text());\n`,
      });
      const cwd = String(folder);
      built(await spawned([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", "program"], cwd, {
        ...bunEnv, BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "captures"),
      }));
      const captured = receipt(join(cwd, "captures"));
      const pairs: string[][] = [];
      let offset = 0;
      while (offset < captured.replacements.length) {
        const pair: string[] = [];
        for (let index = 0; index < 2; index++) {
          const size = captured.replacements.readUInt32LE(offset);
          offset += 4;
          expect(offset + size).toBeLessThanOrEqual(captured.replacements.length);
          pair.push(captured.replacements.subarray(offset, offset + size).toString());
          offset += size;
        }
        pairs.push(pair);
      }
      expect(pairs).toHaveLength(2);
      expect(pairs.every(([from]) => captured.ir.includes(Buffer.from(from)))).toBe(true);
      const run = await spawned([join(cwd, "program")], cwd, bunEnv);
      expect(run.stdout).toBe(`${JSON.stringify(pairs.map(([, to]) => to))}\nfirst second\n`);
      expect(run.exitCode).toBe(0);
    }), 30_000);

  test.each(["", "relative", "missing", "file"])("rejects invalid export directory %j", value =>
    slot(async () => {
      using folder = tempDir("aot-native-ir-invalid", { "main.ts": `console.log(42);\n`, "file": "sentinel" });
      const cwd = String(folder);
      const path = value === "missing" || value === "file" ? join(cwd, value) : value;
      const build = await spawned([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", "program"], cwd, {
        ...bunEnv, BUN_AOT_NATIVE_IR_EXPORT: path,
      });
      expect(build.stderr).toContain("BUN_AOT_NATIVE_IR_EXPORT");
      expect(existsSync(join(cwd, "program"))).toBe(false);
      expect(build.exitCode).not.toBe(0);
    }), 30_000);

  test.each(["ir", "replacements", "json"])("does not overwrite an existing %s capture and fails the build", extension =>
    slot(async () => {
      using folder = tempDir("aot-native-ir-exclusive", {
        "captures/.keep": "", "main.ts": `console.log(42);\n`,
        "build.ts": `import { writeFileSync, readFileSync } from "node:fs";\nconst path = import.meta.dir + "/captures/" + process.pid + "-1.${extension}";\nwriteFileSync(path, "sentinel");\nconst result = await Bun.build({ entrypoints: [import.meta.dir + "/main.ts"], compile: { aot: true, outfile: import.meta.dir + "/program" }, throw: false });\nconsole.log(readFileSync(path, "utf8"));\nconsole.error(result.logs.join("\\n"));\nprocess.exit(result.success ? 0 : 1);\n`,
      });
      const cwd = String(folder);
      const build = await spawned([bunExe(), "build.ts"], cwd, { ...bunEnv, BUN_AOT_NATIVE_IR_EXPORT: join(cwd, "captures") });
      expect(build.stdout).toBe("sentinel\n");
      expect(build.stderr).toContain("BUN_AOT_NATIVE_IR_EXPORT");
      expect(existsSync(join(cwd, "program"))).toBe(false);
      expect(build.exitCode).toBe(1);
    }), 30_000);
});
