import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
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
