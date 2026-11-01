// `IncomingMessage`, `ServerResponse`: a declaration file gives a program these types, and functions of Bun's own modules make the objects.
// A position of such a type expects what that function makes, so a field is read from its slot and a method is called directly behind a test.
import { expect } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDirWithBunTypes as tempDir } from "harness";
import { join } from "node:path";
import { functionsNamed, readBuildReport } from "./harness/build-report";
import { built, slot, spawned } from "./harness/commands";
import { compileCommand, withReport } from "./harness/flags";
import { describe, test } from "./supported";

const program = `import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

function answer(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = req.method === "GET" && req.url === "/text" ? 200 : 404;
  res.setHeader("content-type", "text/plain");
  res.end("hello");
}
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

const server = createServer((req, res) => answer(req, res));
server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  for (const path of ["/text", "/other"]) {
    const response = await fetch("http://127.0.0.1:" + port + path);
    console.log(response.status, response.headers.get("content-type"), await response.text());
  }
  server.close();
});
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
          console.log(stripTypeScriptTypes("const value: number = 42;").includes(": number"));
          let heard = 0;
          process.once("beforeExit", function(value) {
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
      const ran = await spawned([executable], folder, bunEnv);
      expect({ stdout: ran.stdout, exitCode: ran.exitCode, signal: ran.signal }).toEqual({
        stdout: "aot-module 0 function\ntrue b\nfalse\n42 0\n",
        exitCode: 0,
        signal: null,
      });
      expect(ran.stderr).not.toMatch(/^error\b/m);
    }),
  );

  test(
    "a position of such a type is not read by name",
    () =>
      slot(async () => {
        using dir = tempDir("aot-types-of-node-classes", { "main.ts": program });
        const folder = String(dir);
        const executable = join(folder, isWindows ? "app.exe" : "app");
        const reportPath = join(folder, "report.json");
        built(
          await spawned(
            [bunExe(), ...compileCommand, ...withReport(reportPath, "functions"), "main.ts", "--outfile", executable],
            folder,
            bunEnv,
          ),
        );
        const report = readBuildReport(reportPath);
        // TODO: `tell` and `feed`. A class with a dozen classes below it is still read by name.
        for (const name of ["answer"]) {
          const records = functionsNamed(report, name).filter(record => record.role === "Source");
          expect(records).not.toEqual([]);
          expect({ name, byName: records.map(record => record.accesses.byName) }).toEqual({
            name,
            byName: records.map(() => 0),
          });
        }
        const plain = await spawned([bunExe(), "main.ts"], folder, bunEnv);
        expect(await spawned([executable], folder, bunEnv)).toEqual(plain);
      }),
    600_000,
  );
});
