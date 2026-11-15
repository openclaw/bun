// `IncomingMessage` and `ServerResponse` declarations identify the native layouts made by node:http.
// Guards name those layouts even when individual accesses retain fallback paths.
import { expect } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDirWithBunTypes as tempDir } from "harness";
import { basename, join } from "node:path";
import { canTrim } from "../bundler/compile-trim-features";
import { built, slot, spawned } from "./harness/commands";
import { compileCommand } from "./harness/flags";
import { describe, test } from "./supported";

const program = `import type { IncomingMessage, ServerResponse } from "node:http";
import { exercise } from "exercise";

function answer(req: IncomingMessage, res: ServerResponse) {
  return res.end(req.url);
}
exercise(answer);
`;

const exercise = `import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export function exercise(answer: (req: IncomingMessage, res: ServerResponse) => void): void {
  function tell(emitter: EventEmitter, value: number): boolean {
    return emitter.emit("value", value) && emitter.listenerCount("value") > 0;
  }
  function feed(stream: Readable, value: number): unknown {
    stream.push(value);
    return stream.read();
  }

  const emitter = new EventEmitter();
  let heard = 0;
  emitter.on("value", (value: number) => void (heard += value));
  const stream = new Readable({ objectMode: true, read() {} });
  console.log(tell(emitter, 2), tell(stream, 3), heard, feed(stream, 4));

  const server = createServer((req, res) => {
    res.statusCode = req.method === "GET" && req.url === "/text" ? 200 : 404;
    res.setHeader("content-type", "text/plain");
    answer(req, res);
  });
  server.listen(0, async () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    for (const path of ["/text", "/other"]) {
      const response = await fetch("http://127.0.0.1:" + port + path);
      console.log(response.status, response.headers.get("content-type"), await response.text());
    }
    server.close();
  });
}
`;

describe("compile/aot/types of node's classes", () => {
  test("native module utilities and once wrappers remain callable", () =>
    slot(async () => {
      using dir = tempDir("aot-native-module-utilities", {
        "main.ts": `
          import Module, { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
          const module = new Module("aot-module");
          console.log(module.id, module.children.length, typeof module.require);
          let resolved = false;
          const hooks = registerHooks({
            resolve(specifier, context, next) {
              if (specifier === "node:path") resolved = true;
              return next(specifier, context);
            },
          });
          const path = createRequire(import.meta.url)("node:path");
          hooks.deregister();
          console.log(resolved, path.basename("/a/b"));
          const redirected = registerHooks({
            resolve(specifier, context, next) {
              return next(specifier === "node:path" ? "node:util" : specifier, context);
            },
          });
          const require = createRequire(import.meta.url);
          const staticAnswer = require("node:path");
          const name = process.argv[2] === "path" ? "node:path" : "node:os";
          const computedAnswer = require(name);
          console.log(typeof staticAnswer.isDeepStrictEqual, typeof staticAnswer.basename);
          console.log(typeof computedAnswer.isDeepStrictEqual, typeof computedAnswer.basename);
          console.log(require.resolve("node:path"), require.resolve(name));
          import required = require("node:path");
          console.log(Object.hasOwn(required, "isDeepStrictEqual"));
          redirected.deregister();
          console.log(typeof require("node:path").basename, require.resolve("node:path"));
          console.log(stripTypeScriptTypes("const value: number = 42;").includes(": number"));
          let heard = 0;
          process.once("beforeExit", function(this: typeof process, value) {
            if (this !== process) throw new Error("wrong once receiver");
            heard += value;
          });
          const [once] = process.rawListeners("beforeExit");
          once(42);
          once(100);
          console.log(heard, process.listenerCount("beforeExit"));
        `,
      });
      const folder = String(dir);
      const executable = join(folder, isWindows ? "app.exe" : "app");
      built(await spawned([bunExe(), ...compileCommand, "main.ts", "--outfile", executable], folder, bunEnv));
      const ran = await spawned([executable, "path"], folder, bunEnv);
      expect({ stdout: ran.stdout, exitCode: ran.exitCode, signal: ran.signal }).toEqual({
        stdout:
          "aot-module 0 function\ntrue b\nfunction undefined\nfunction undefined\nutil util\ntrue\nfunction node:path\nfalse\n42 0\n",
        exitCode: 0,
        signal: null,
      });
      expect(ran.stderr).not.toMatch(/^error\b/m);
    }));

  test("customization hooks reached through aliases or computed calls retain redirected exports", () =>
    slot(async () => {
      for (const mode of ["aliased", "computed"]) {
        using dir = tempDir("aot-module-hooks-" + mode, {
          "registration.ts": 'export { registerHooks as install } from "node:module";',
          "replacement.ts": 'export function extra() { return "replacement"; }',
          "original.ts": 'export const value = "original";',
          "main.ts": `
            ${
              mode === "aliased"
                ? 'import { install } from "./registration.ts";'
                : `import Module from "node:module";
            const method = process.argv[2];
            if (method !== "registerHooks") throw new Error("expected registerHooks");`
            }
            import { createRequire } from "node:module";
            import "./replacement.ts";
            const require = createRequire(import.meta.url);
            let asked = 0;
            const hooks = ${mode === "aliased" ? "install" : "Module[method]"}({
              resolve(specifier, context, next) {
                if (specifier === "./original.ts") {
                  asked++;
                  return next("./replacement.ts", context);
                }
                return next(specifier, context);
              },
            });
            console.log(require("./original.ts").extra());
            require("./original.ts");
            console.log(asked);
            hooks.deregister();
            console.log(require("./original.ts").value);
          `,
        });
        const folder = String(dir);
        const executable = join(folder, isWindows ? "app.exe" : "app");
        built(
          await spawned(
            [
              bunExe(),
              ...compileCommand,
              ...(canTrim ? ["--trim-without=Interpreter"] : []),
              "main.ts",
              "--outfile",
              executable,
            ],
            folder,
            bunEnv,
          ),
        );
        for (const command of [
          [bunExe(), "main.ts", "registerHooks"],
          [executable, "registerHooks"],
        ]) {
          const ran = await spawned(command, folder, bunEnv);
          expect({ stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.exitCode, signal: ran.signal }).toEqual({
            stdout: "replacement\n2\noriginal\n",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        }
      }
    }));

  test.each([
    {
      name: "typed",
      parameters: "req: IncomingMessage, res: ServerResponse",
      types: ["IncomingMessage", "ServerResponse"],
    },
    { name: "untyped", parameters: "req, res", types: [] },
  ])(
    "$name HTTP callback guards match its native class annotations",
    ({ parameters, types }) =>
      slot(async () => {
        using dir = tempDir("aot-types-of-node-classes", {
          "main.ts": program.replace("req: IncomingMessage, res: ServerResponse", parameters),
          "node_modules/exercise/package.json": JSON.stringify({ name: "exercise", type: "module", main: "index.ts" }),
          "node_modules/exercise/index.ts": exercise,
        });
        const folder = String(dir);
        const executable = join(folder, isWindows ? "app.exe" : "app");
        const build = await spawned(
          [bunExe(), ...compileCommand, "--explain=guards-json", "main.ts", "--outfile", executable],
          folder,
          bunEnv,
        );
        built(build);
        const guards = build.stdout
          .split("\n")
          .filter(line => line.startsWith("{"))
          .map(line => JSON.parse(line) as { aot: string; file: string; function: string; type: string })
          // Dependency guards must not satisfy the callback's declaration proof.
          .filter(
            guard => guard.aot === "type-check" && guard.function === "answer" && basename(guard.file) === "main.ts",
          )
          .map(guard => guard.type)
          .filter(type => type === "IncomingMessage" || type === "ServerResponse");
        expect(new Set(guards), build.stdout).toEqual(new Set(types));
        const plain = await spawned([bunExe(), "main.ts"], folder, bunEnv);
        expect(plain).toEqual({
          stdout: "true false 2 4\n200 text/plain /text\n404 text/plain /other\n",
          stderr: "",
          exitCode: 0,
          signal: null,
        });
        expect(await spawned([executable], folder, bunEnv)).toEqual(plain);
      }),
    600_000,
  );
});
