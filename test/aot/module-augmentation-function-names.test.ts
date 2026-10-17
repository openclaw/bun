import { expect } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "node:path";
import { test } from "./supported";

test.concurrent.each(["run", "compile"])(
  "%s keeps function names in augmented modules",
  async mode => {
    using dir = tempDir("aot-augmented-module-names", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, target: "ESNext", module: "Preserve", moduleResolution: "Bundler" },
      }),
      "library.ts": `
      export interface Options { value: string; }
      export const guard = (value: unknown): value is string => typeof value === "string";
      export const anonymous = function (value: string) { return value; };
      export const named = function original(value: string) { return value; };
      export let mutable = (value: string) => value;
      export function change() { mutable = (value: string) => value; }
    `,
      "augmentation.ts": `
      import "./library";
      declare module "./library" { interface Options { extra?: string; } }
    `,
      "consumer.ts": `
      import { guard } from "./library";
      export function read(value: unknown) { return guard(value); }
    `,
      "main.ts": `
      import "./augmentation";
      import { anonymous, change, guard, mutable, named } from "./library";
      import { read } from "./consumer";
      namespace Local {
        export const arrow = (value: string) => value;
        export const anonymous = function (value: string) { return value; };
        export const named = function original(value: string) { return value; };
        export let mutable = (value: string) => value;
        export function change() { mutable = (value: string) => value; }
      }
      console.log(JSON.stringify([guard.name, anonymous.name, named.name, mutable.name]));
      change();
      console.log(mutable.name, read("yes"), read(1), anonymous("a"), named("b"), mutable("c"));
      console.log(JSON.stringify([Local.arrow.name, Local.anonymous.name, Local.named.name, Local.mutable.name]));
      Local.change();
      console.log(JSON.stringify([Local.mutable.name]), Local.arrow("d"), Local.anonymous("e"), Local.named("f"), Local.mutable("g"));
    `,
    });
    async function run(cmd: string[]) {
      await using proc = Bun.spawn({
        cmd,
        cwd: String(dir),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode };
    }
    let result;
    if (mode === "compile") {
      const executable = join(String(dir), "compiled");
      const built = await run([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable]);
      expect({ stderr: built.stderr, exitCode: built.exitCode }).toEqual({ stderr: "", exitCode: 0 });
      result = await run([executable]);
    } else {
      result = await run([bunExe(), "run", "--aot", "main.ts"]);
    }
    expect(result).toEqual({
      stdout:
        '["guard","anonymous","original","mutable"]\nmutable true false a b c\n["","","original",""]\n[""] d e f g\n',
      stderr: "",
      exitCode: 0,
    });
  },
  60_000,
);
