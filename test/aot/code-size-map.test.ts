import { expect } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDirWithBunTypes as tempDir } from "harness";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseCounts, parseMap } from "./harness/counted-run";
import { built, slot, spawned } from "./harness/commands";
import { describe, test } from "./supported";

const source = `function half(n: number): number {
  return n / 2;
}

function fill(count: number): number[] {
  const list = [1];
  for (let i = 0; i < count; i++) list.push(half(i));
  return list;
}

const count = Number(process.argv[2] ?? 4);
console.log(fill(count).join(), { count, name: "count" });
`;
const files = { "app.ts": source, mapped: {}, unmapped: {} };

interface CodeRange {
  label: string;
  value: string;
  operandRepresentation: string;
  offset: number;
  size: number;
}

interface Literal {
  value: string;
  kind: string;
  computedOperands: number;
  names: string[];
}

interface CompiledFunction {
  size: number;
  totals: [label: string, bytes: number][];
  ranges: CodeRange[];
  literals: Literal[];
}

interface CountedBranch {
  trueSide: number;
  falseSide: number;
  position: number;
  path: string;
}

const env = { ...bunEnv, NO_COLOR: "1" };
const labelPattern = /^[A-Z][A-Za-z0-9]*(\.[A-Za-z0-9_]+\/\d+)?\+?\*?$/;
const representations = [
  "Unchosen",
  "Void",
  "Boolean",
  "Int32",
  "Int64",
  "Double",
  "OptionalInt64",
  "OptionalDouble",
  "Cell",
  "Cell32",
  "JSValue",
  "LiteralString",
  "RawWord",
];
const largestTrapSize = 4;
const largestFinalJumpSize = 5;
const digits = expect.stringMatching(/^\d+$/);

const sum = (numbers: number[]) => numbers.reduce((total, number) => total + number, 0);

async function build(folder: string, output: string, flags: string[], map?: string) {
  const executable = join(folder, output, isWindows ? "app.exe" : "app");
  built(
    await spawned(
      [bunExe(), "build", "--compile", "--aot", ...flags, "app.ts", "--outfile", executable],
      folder,
      map ? { ...env, BUN_JSC_aotMapFilePath: map } : env,
    ),
  );
  return executable;
}

function groups(fields: string[], width: number) {
  expect(fields.length % width).toBe(0);
  return Array.from({ length: fields.length / width }, (_, index) => fields.slice(index * width, (index + 1) * width));
}

function readMap(path: string) {
  const functions: CompiledFunction[] = [];
  const branches: CountedBranch[] = [];
  let isOutlined = false;
  let last = { position: "", size: 0 };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [letter, ...fields] = line.split("\t");
    switch (letter) {
      case "F":
        last = { position: fields[0], size: Number(fields[2]) };
        break;
      case "O":
        expect(fields[0]).toBe(last.position);
        functions.push({
          size: last.size,
          totals: groups(fields.slice(1), 2).map(([label, bytes]): [string, number] => [label, Number(bytes)]),
          ranges: [],
          literals: [],
        });
        break;
      case "S":
        functions.at(-1)!.ranges = groups(fields, 5).map(([label, value, operandRepresentation, offset, size]) => ({
          label,
          value,
          operandRepresentation,
          offset: Number(offset),
          size: Number(size),
        }));
        break;
      case "V":
        functions.at(-1)!.literals = groups(fields, 4).map(([value, kind, computedOperands, names]) => ({
          value,
          kind,
          computedOperands: Number(computedOperands),
          names: names === "-" ? [] : names.split(","),
        }));
        break;
      case "Q":
        expect(fields.length).toBe(5);
        branches.push({
          trueSide: Number(fields[0]),
          falseSide: Number(fields[1]),
          position: Number(fields[3]),
          path: fields[4],
        });
        break;
      case "Y":
        isOutlined = true;
        break;
    }
  }
  return { functions, branches, isOutlined };
}

describe.concurrent("the code size map", () => {
  test(
    "Bun.build counter options match CLI instrumentation and preserve runtime behavior",
    () =>
      slot(async () => {
        using dir = tempDir("aot-api-counter-options", {
          "app.ts": `
            function sum(record: Record<string, number>, key: string, rounds: number): number {
              let total = 0;
              for (let i = 0; i < rounds; i++) {
                if (i & 1) total += record[key];
                else total += record[key] * 2;
              }
              return total;
            }
            console.log(sum(JSON.parse('{"value":7}'), process.argv[2], Number(process.argv[3])));
          `,
          "build.ts": `
            const result = await Bun.build({
              entrypoints: ["./app.ts"],
              compile: { aot: true, outfile: process.argv[2], ...JSON.parse(process.argv[3]) },
            });
            if (!result.success) throw new AggregateError(result.logs);
          `,
        });
        const folder = String(dir);
        for (const mode of ["api-default", "api-disabled", "api-enabled", "cli-enabled"]) {
          const enabled = mode.endsWith("-enabled");
          const executable = join(folder, mode + (isWindows ? ".exe" : ""));
          const mapFile = join(folder, mode + ".map");
          const countsFile = join(folder, mode + ".counts");
          const command =
            mode === "cli-enabled"
              ? [
                  bunExe(),
                  "build",
                  "--compile",
                  "--aot",
                  "--aot-count-branches",
                  "--aot-count-arrivals",
                  "app.ts",
                  "--outfile",
                  executable,
                ]
              : [
                  bunExe(),
                  "build.ts",
                  executable,
                  JSON.stringify(
                    mode === "api-default" ? {} : { aotCountBranches: enabled, aotCountArrivals: enabled },
                  ),
                ];
          built(await spawned(command, folder, { ...env, BUN_JSC_aotMapFilePath: mapFile }));
          expect(
            await spawned([executable, "value", "10"], folder, {
              ...env,
              BUN_DESTRUCT_VM_ON_EXIT: "1",
              BUN_JSC_aotCountsPath: countsFile,
            }),
          ).toMatchObject({ stdout: "105\n", stderr: "", exitCode: 0, signal: null });
          const map = parseMap(readFileSync(mapFile, "utf8"));
          const counts = parseCounts(readFileSync(countsFile, "utf8"));
          if (enabled) {
            const branches = map.branches.filter(branch => branch.path.endsWith("app.ts"));
            expect(branches.length).toBeGreaterThan(0);
            expect(
              branches.some(
                branch =>
                  (counts.byCounter.get(branch.whenTrue) ?? 0) + (counts.byCounter.get(branch.whenFalse) ?? 0) > 0,
              ),
            ).toBe(true);
            expect(map.entries.some(entry => (counts.byCounter.get(entry.counter) ?? 0) > 0)).toBe(true);
            const mappedCounters = new Set(
              readFileSync(mapFile, "utf8")
                .split("\n")
                .flatMap(line => {
                  const [kind, first, second] = line.split("\t");
                  return kind === "QE" ? [Number(first)] : kind === "Q" ? [Number(first), Number(second)] : [];
                }),
            );
            expect(
              [...counts.byCounter].filter(([counter, amount]) => amount > 0 && !mappedCounters.has(counter)),
            ).toEqual([]);
            expect(counts.accessesByName).toBeGreaterThan(0);
          } else {
            expect(map.branches).toEqual([]);
            expect(map.entries).toEqual([]);
            expect(counts.byCounter.size).toBe(0);
            expect(counts.accessesByName).toBe(0);
          }
        }
      }),
    300_000,
  );

  test(
    "generated helper entry counters are mapped without a source attribution",
    () =>
      slot(async () => {
        using dir = tempDir("aot-generated-entry-counters", {
          "app.ts": `
            function copy(values: Iterable<number>): number[] { return [...values]; }
            const values: Iterable<number> = JSON.parse(process.argv[2] ?? '[1,2,3]');
            console.log(copy(values).join(','));
          `,
          mapped: {},
        });
        const folder = String(dir);
        const mapFile = join(folder, "generated.map");
        const countsFile = join(folder, "generated.counts");
        const executable = await build(folder, "mapped", ["--aot-count-branches"], mapFile);
        expect(
          await spawned([executable], folder, {
            ...env,
            BUN_DESTRUCT_VM_ON_EXIT: "1",
            BUN_JSC_aotCountsPath: countsFile,
          }),
        ).toMatchObject({ stdout: "1,2,3\n", stderr: "", exitCode: 0, signal: null });
        const mappedCounters = new Set<number>();
        const generatedEntries: number[] = [];
        let current: string[] = [];
        let generatedBodies = 0;
        for (const line of readFileSync(mapFile, "utf8").split("\n")) {
          const fields = line.split("\t");
          if (fields[0] === "F") {
            current = fields;
            if (current[4] === "0") generatedBodies++;
          } else if (fields[0] === "QE") {
            const counter = Number(fields[1]);
            mappedCounters.add(counter);
            if (current[4] === "0") {
              expect(fields.slice(2)).toEqual(["-", current[11], ""]);
              expect(current[10]).toBe("");
              expect(["typed", "untyped"]).not.toContain(current[8]);
              generatedEntries.push(counter);
            }
          } else if (fields[0] === "Q") {
            mappedCounters.add(Number(fields[1]));
            mappedCounters.add(Number(fields[2]));
          }
        }
        const counts = parseCounts(readFileSync(countsFile, "utf8"));
        expect([...counts.byCounter].filter(([counter, amount]) => amount > 0 && !mappedCounters.has(counter))).toEqual(
          [],
        );
        expect(generatedBodies).toBeGreaterThan(0);
        expect(generatedEntries).toHaveLength(generatedBodies);
        expect(generatedEntries.some(counter => (counts.byCounter.get(counter) ?? 0) > 0)).toBe(true);
      }),
    300_000,
  );

  test(
    "every byte of a function is in one range, and the totals by label agree with the ranges",
    () =>
      slot(async () => {
        using dir = tempDir("aot-code-size-map", files);
        const map = join(String(dir), "app.map");
        await build(String(dir), "mapped", [], map);
        const { functions, branches, isOutlined } = readMap(map);
        expect(functions.length).toBeGreaterThan(0);
        expect(branches).toEqual([]);

        for (const { size, totals, ranges } of functions) {
          const total = sum(totals.map(([, bytes]) => bytes));
          expect(
            ranges.filter(
              (range, index) =>
                range.size <= 0 || range.offset !== (index ? ranges[index - 1].offset + ranges[index - 1].size : 0),
            ),
          ).toEqual([]);
          expect(sum(ranges.map(range => range.size))).toBe(total);
          // The image drops the trap after the last instruction and the final jump of a function that falls into the next one, and can append entry points that only jump to another function.
          if (!isOutlined) expect(size).toBeGreaterThanOrEqual(total - largestTrapSize - largestFinalJumpSize);

          const bytesByLabel = new Map<string, number>();
          for (const range of ranges) {
            const label = range.label.replace("*", "");
            bytesByLabel.set(label, (bytesByLabel.get(label) ?? 0) + range.size);
          }
          expect([...bytesByLabel].sort()).toEqual([...totals].sort());
          expect(totals.findIndex(([label]) => label === "-")).toBeLessThanOrEqual(0);
          expect(ranges.filter(range => (range.label === "-") !== (range.value === "-"))).toEqual([]);
          expect(
            ranges.filter(
              range => range.operandRepresentation !== "-" && !representations.includes(range.operandRepresentation),
            ),
          ).toEqual([]);
          expect(ranges.filter(range => range.value === "-" && range.operandRepresentation !== "-")).toEqual([]);
        }

        const labels = functions.flatMap(({ ranges }) => ranges.map(range => range.label));
        expect(labels.filter(label => label !== "-" && !labelPattern.test(label))).toEqual([]);
        expect(labels.some(label => label.includes("+"))).toBe(true);
        expect(labels.some(label => label.endsWith("*"))).toBe(true);
        expect(labels.some(label => /^Call(Builtin|Inline)\.ArrayPrototypePush\/\d+/.test(label))).toBe(true);
        expect(functions.some(({ ranges }) => ranges.some(range => range.operandRepresentation !== "-"))).toBe(true);

        const literals = functions.flatMap(({ literals }) => literals);
        expect(literals.flatMap(({ names }) => names).filter(name => name !== "?" && !/^\d+$/.test(name))).toEqual([]);
        expect(literals).toContainEqual({ value: digits, kind: "o", computedOperands: 1, names: [digits, digits] });
        const hasLiteralWithCode = ({ ranges, literals }: CompiledFunction) =>
          literals.some(literal =>
            ranges.some(range => range.value === literal.value && range.label.startsWith("NewObject")),
          );
        expect(functions.some(hasLiteralWithCode)).toBe(true);
      }),
    300_000,
  );

  test(
    "a TN row has the offset of a stub that never returns",
    () =>
      slot(async () => {
        using dir = tempDir("aot-code-size-map-stubs", files);
        const map = join(String(dir), "app.map");
        await build(String(dir), "mapped", [], map);
        const rows = readFileSync(map, "utf8")
          .split("\n")
          .map(line => line.split("\t"));
        const stubs = rows.filter(([letter]) => letter === "T");
        const neverReturning = rows.filter(([letter]) => letter === "TN");
        expect(neverReturning.filter(fields => fields.length !== 2)).toEqual([]);

        const offsets = new Set(neverReturning.map(([, offset]) => offset));
        expect([...offsets].filter(offset => !stubs.some(stub => stub[1] === offset))).toEqual([]);
        const names = stubs.filter(([, offset]) => offsets.has(offset)).map(([, , name]) => name);
        expect(names).toContain("HandleException");
        expect(names.filter(name => name.startsWith("PollAtPrologue"))).toEqual([]);
        expect(names.length).toBeLessThan(stubs.length);
      }),
    300_000,
  );

  test(
    "the map is written only on request, and writing it does not change the executable",
    () =>
      slot(async () => {
        using dir = tempDir("aot-code-size-map-unchanged", files);
        const map = join(String(dir), "app.map");
        const unmapped = await build(String(dir), "unmapped", []);
        expect(readdirSync(join(String(dir), "unmapped"))).toEqual([basename(unmapped)]);
        expect(existsSync(map)).toBe(false);

        const mapped = await build(String(dir), "mapped", [], map);
        expect(existsSync(map)).toBe(true);
        expect(readFileSync(mapped).equals(readFileSync(unmapped))).toBe(true);
      }),
    300_000,
  );

  test(
    "--aot-count-branches gives each side of each counted branch a counter of its own",
    () =>
      slot(async () => {
        using dir = tempDir("aot-code-size-map-counters", files);
        const map = join(String(dir), "app.map");
        await build(String(dir), "mapped", ["--aot-count-branches"], map);
        const { branches } = readMap(map);
        const counters = branches.flatMap(({ trueSide, falseSide }) => [trueSide, falseSide]);
        expect(counters.filter(counter => !Number.isInteger(counter))).toEqual([]);
        expect(branches.filter(({ trueSide, falseSide }) => trueSide === falseSide)).toEqual([]);
        expect(new Set(counters).size).toBe(counters.length);
        expect(
          branches.filter(({ path, position }) => path.endsWith("app.ts") && position < source.length).length,
        ).toBeGreaterThan(0);
      }),
    300_000,
  );
});
