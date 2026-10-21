// Everything that JavaScript lets anybody do to an object, done to every kind of object that typed code makes: the cases of
// ./generated/python/external-sources-of-typed-objects.py, 120 to a program. Most cases print what plain Bun prints. Of those that do not,
// ./generated/external-sources-of-typed-objects.json says how they depart:
//
//   "TypeError"  --aot throws a TypeError that plain Bun does not throw: the case does what --aot does not allow
//   "differs"    it prints something else
//
// A verdict that changes fails the test, for better or for worse. AOT_PROGRAMS_UPDATE=1 rewrites the file.
import { spawnSync } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { join } from "path";
import { built, slot, spawned, unsupported, wanted } from "./run-programs";

const recorded = join(import.meta.dir, "generated", "external-sources-of-typed-objects.json");
const verdicts: Record<string, string> = JSON.parse(readFileSync(recorded, "utf8"));
const updates = !!process.env.AOT_PROGRAMS_UPDATE;
const python = Bun.which("python3");
if (!python) console.error("SKIPPED: test/aot/external-sources-of-typed-objects.test.ts: python3 is not installed");
const root = String(tempDir("aot-doors", {}));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (updates) writeFileSync(recorded, JSON.stringify(verdicts, null, 1) + "\n");
});

/** `<case>: <answer>` is what a case prints, and `#<case>: <error>` stands behind it for each error that was caught on the way. */
function read(stdout: string) {
  const answers = new Map<string, string>();
  const errors = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(": ");
    if (at < 0) continue;
    if (line.startsWith("#")) errors.set(line.slice(1, at), [...(errors.get(line.slice(1, at)) ?? []), line.slice(at + 2)]);
    else answers.set(line.slice(0, at), line.slice(at + 2));
  }
  return { answers, errors };
}

describe.concurrent("compile/aot/doors to typed objects", () => {
  if (unsupported) return void test.skip(unsupported, () => {});
  if (!python) return void test.skip("python3 is not installed", () => {});
  for (let part = 1; part <= 17; part++) {
    if (wanted === "quick" && part > 2) continue;
    test(
      `part ${part}`,
      () =>
        slot(async () => {
          const folder = join(root, String(part));
          mkdirSync(folder, { recursive: true });
          const written = spawnSync({ cmd: [python, "-B", join(import.meta.dir, "generated", "python", "external-sources-of-typed-objects.py"), String(part)], stderr: "pipe" });
          if (written.exitCode !== 0) throw new Error(String(written.stderr));
          writeFileSync(join(folder, "main.ts"), written.stdout);
          const executable = join(folder, isWindows ? "program.exe" : "program");
          try {
            built(await spawned([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable], folder, bunEnv));
            const compiled = await spawned([executable], folder, bunEnv);
            const plain = await spawned([bunExe(), "run", "main.ts"], folder, bunEnv);
            expect({ signal: plain.signal, exitCode: plain.exitCode }).toEqual({ signal: null, exitCode: 0 });
            expect({ signal: compiled.signal, exitCode: compiled.exitCode }).toEqual({ signal: null, exitCode: 0 });
            const [ours, theirs] = [read(compiled.stdout), read(plain.stdout)];
            const found: Record<string, string> = {};
            const expected: Record<string, string> = {};
            for (const [name, answer] of theirs.answers) {
              if (verdicts[name]) expected[name] = verdicts[name];
              if (ours.answers.get(name) === answer) continue;
              const isRefused = ours.errors.get(name)?.some(error => error.startsWith("TypeError") && !theirs.errors.get(name)?.includes(error));
              found[name] = isRefused ? "TypeError" : "differs";
            }
            if (updates) {
              for (const name of theirs.answers.keys()) delete verdicts[name];
              Object.assign(verdicts, found);
            } else expect(found).toEqual(expected);
          } finally {
            rmSync(executable, { force: true });
          }
        }),
      600_000,
    );
  }
});

describe.concurrent("compile/aot/typed views of global host properties", () => {
  if (unsupported) return void test.skip(unsupported, () => {});
  const runtimeBuffer = `
    interface RuntimeBuffer {
      byteLength(content: string, encoding: "utf8"): number;
      from(content: string, encoding: "utf16le"): { toString(encoding: "utf16le"): string };
    }
  `;
  const readBuffer = `console.log(value === Buffer, value.byteLength("abc", "utf8"), value.from("abc", "utf16le").toString("utf16le"));`;
  const cases = {
    "an asserted optional Buffer property": {
      source: runtimeBuffer + `const value = (globalThis as { Buffer?: RuntimeBuffer }).Buffer!;` + readBuffer,
      stdout: "true 3 abc\n",
    },
    "an assigned optional Buffer property": {
      source:
        runtimeBuffer + `const host: { Buffer?: RuntimeBuffer } = globalThis; const value = host.Buffer!;` + readBuffer,
      stdout: "true 3 abc\n",
    },
    "an assigned optional Array property": {
      source: `interface ArrayFactory { from(content: string): unknown[]; }
        const host: { Array?: ArrayFactory } = globalThis;
        const value = host.Array!;
        console.log(value === Array, value.from("abc").join(""));`,
      stdout: "true abc\n",
    },
    "a direct Buffer assignment": {
      source: runtimeBuffer + `const value: RuntimeBuffer = Buffer;` + readBuffer,
      stdout: "true 3 abc\n",
    },
    "missing and non-callable methods after a valid host assignment": {
      source:
        runtimeBuffer +
        `
        const real: RuntimeBuffer = Buffer;
        console.log("real", real.byteLength("abc", "utf8"));
        function consume(value: RuntimeBuffer) { return value.from("abc", "utf16le").toString("utf16le"); }
        const missing: any = function () {};
        const wrong: any = Object.assign(function () {}, { from: 0 });
        for (const [label, value] of [["missing", missing], ["wrong", wrong]] as const) {
          try { console.log(label, consume(value)); }
          catch (error) { console.log(label, error instanceof TypeError ? "TypeError" : "unexpected"); }
        }`,
      stdout: "real 3\nmissing TypeError\nwrong TypeError\n",
    },
  };
  for (const mode of ["run", "compile"]) {
    for (const [name, fixture] of Object.entries(cases)) {
      test(
        `${mode}: ${name}`,
        () =>
          slot(async () => {
            using dir = tempDir("aot-global-host-fields", {
              "tsconfig.json": JSON.stringify({
                compilerOptions: {
                  strict: true,
                  target: "ESNext",
                  module: "Preserve",
                  moduleResolution: "Bundler",
                  types: [],
                  noEmit: true,
                },
              }),
              "globals.d.ts": `
              declare var Buffer: BufferConstructor;
              interface BufferConstructor {
                (content: string): { toString(encoding: "utf16le"): string };
                byteLength(content: string, encoding: "utf8"): number;
                from(content: string, encoding: "utf16le"): { toString(encoding: "utf16le"): string };
              }
              declare module "node:path" {}
            `,
              "main.ts": `import "node:path";\n` + fixture.source,
            });
            const folder = String(dir);
            let result;
            if (mode === "compile") {
              const executable = join(folder, isWindows ? "program.exe" : "program");
              built(
                await spawned(
                  [bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable],
                  folder,
                  bunEnv,
                ),
              );
              result = await spawned([executable], folder, bunEnv);
            } else {
              result = await spawned([bunExe(), "run", "--aot", "main.ts"], folder, bunEnv);
            }
            expect(result).toEqual({ stdout: fixture.stdout, stderr: "", exitCode: 0, signal: null });
          }),
        60_000,
      );
    }
  }
});
