import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { createHash } from "node:crypto";
import v8 from "node:v8";
import legacyGolden from "./legacy-clone-golden.fixture.json";
import { legacyGraphs } from "./legacy-clone-graphs.fixture.mjs";

// Buffer identity through v8.serialize/deserialize, matching node v26.3.0's
// serializer delegate behavior (DefaultSerializer host objects). Non-Buffer
// payloads keep bare JSC framing instead of the Buffer envelope.
describe("v8 serialize/deserialize Buffer identity", () => {
  test("cause-free graphs retain the pre-cause v14 bytes", () => {
    for (const [name, value] of Object.entries(legacyGraphs())) {
      const bytes = v8.serialize(value);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(legacyGolden[name]);
    }
  });

  test("only a graph with a cause edge requires v16", () => {
    const error = new Error("empty");
    error.stack = "stable";
    expect(v8.serialize([error, error]).readUInt32LE(0)).toBe(14);
    error.cause = undefined;
    expect(v8.serialize([new Error("first"), error]).readUInt32LE(0)).toBe(16);
  });
  test.each([new Uint8Array([1, 2]), Buffer.from([1, 2])])("serialized output is transferable: %p", input => {
    const serialized = v8.serialize(input);
    expect(serialized.buffer).toBeInstanceOf(ArrayBuffer);
    const transferred = structuredClone(serialized.buffer, { transfer: [serialized.buffer] });
    expect(serialized.byteLength).toBe(0);
    expect(Array.from(v8.deserialize(Buffer.from(transferred)))).toEqual([1, 2]);
  });

  test("Buffer round-trips as Buffer", () => {
    const out = v8.deserialize(v8.serialize(Buffer.from("hi")));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString()).toBe("hi");
  });

  test("Uint8Array stays Uint8Array (node preserves the distinction)", () => {
    const out = v8.deserialize(v8.serialize(new Uint8Array([1, 2])));
    expect(Buffer.isBuffer(out)).toBe(false);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 2]);
  });

  test("other typed arrays keep their type", () => {
    const out = v8.deserialize(v8.serialize(new Float64Array([1.5])));
    expect(out).toBeInstanceOf(Float64Array);
    expect(out[0]).toBe(1.5);
  });

  test("nested Buffers, aliasing preserved", () => {
    const b = Buffer.from("hello world").subarray(6, 9);
    const out = v8.deserialize(v8.serialize({ deep: { list: [b, b] } }));
    expect(Buffer.isBuffer(out.deep.list[0])).toBe(true);
    expect(out.deep.list[0]).toBe(out.deep.list[1]);
    expect(out.deep.list[0].toString()).toBe("wor");
    expect(out.deep.list[0].length).toBe(3);
  });

  test("Buffers as Map keys and values", () => {
    const m = new Map([[Buffer.from("k"), { v: Buffer.from("v") }]]);
    const out = v8.deserialize(v8.serialize(m)) as Map<any, any>;
    const [key, value] = [...out][0];
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(Buffer.isBuffer(value.v)).toBe(true);
  });

  test("Error.cause-only Buffers retain their type and graph identity", () => {
    const buffer = Buffer.from("cause").subarray(1, 4);
    const error = new Error("outer", { cause: new Map([[buffer, buffer]]) });
    const out = v8.deserialize(v8.serialize(error));
    expect(out).toBeInstanceOf(Error);
    expect(out.cause).toBeInstanceOf(Map);
    const [[key, value]] = [...out.cause];
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toBe(value);
    expect(key.toString()).toBe("aus");
  });

  test.each(["name", "message", "stack"])("cause snapshot retains Buffer brand and bytes before %s effects", field => {
    const source = new Error("outer", { cause: Buffer.from("original").subarray(1, 5) });
    source.stack = "";
    let calls = 0;
    const effect = () => {
      calls++;
      source.cause = Buffer.from("replacement");
      return field === "name" ? "Error" : "metadata";
    };
    Object.defineProperty(source, field, field === "message" ? { value: { toString: effect } } : { get: effect });
    const out = v8.deserialize(v8.serialize(source));
    expect(calls).toBe(1);
    expect(Buffer.isBuffer(out.cause)).toBe(true);
    expect(out.cause.toString()).toBe("rigi");
    expect(out.cause.length).toBe(4);
  });

  for (const initial of ["buffer", "absent"]) {
    test.each(["name", "message", "stack"])(
      `later Error with ${initial} cause retains a Buffer introduced by %s effects`,
      field => {
        const later = initial === "buffer" ? new Error("later", { cause: Buffer.from("old") }) : new Error("later");
        const first = new Error("first");
        first.stack = "";
        let calls = 0;
        const effect = () => {
          calls++;
          const buffer = Buffer.from("!new!").subarray(1, 4);
          later.cause = new Map([[buffer, [buffer, buffer]]]);
          return field === "name" ? "Error" : "metadata";
        };
        Object.defineProperty(first, field, field === "message" ? { value: { toString: effect } } : { get: effect });
        const out = v8.deserialize(v8.serialize([first, later, later]));
        expect(calls).toBe(1);
        expect(out[1]).toBe(out[2]);
        expect(out[1].cause).toBeInstanceOf(Map);
        const [[key, values]] = [...out[1].cause];
        expect(Array.from(key)).toEqual([110, 101, 119]);
        expect(Buffer.isBuffer(key)).toBe(true);
        expect(key.toString()).toBe("new");
        expect(values[0]).toBe(key);
        expect(values[1]).toBe(key);
      },
    );
  }

  test("Error.cause Buffer serialization terminates on Error cycles without invoking accessors", () => {
    const error = new Error("outer");
    const nested = new Error("inner", { cause: error });
    const accessor = new Error("accessor");
    let reads = 0;
    Object.defineProperty(accessor, "cause", {
      get() {
        reads++;
        throw new Error("must not read accessor");
      },
    });
    error.cause = [nested, Buffer.from("cycle"), accessor];
    const out = v8.deserialize(v8.serialize(error));
    expect(out.cause[0].cause).toBe(out);
    expect(Buffer.isBuffer(out.cause[1])).toBe(true);
    expect(out.cause[1].toString()).toBe("cycle");
    expect(Object.hasOwn(out.cause[2], "cause")).toBe(false);
    expect(reads).toBe(0);
  });

  test("Buffer-free payloads keep bare JSC framing in the current runtime", () => {
    const jsc = require("bun:jsc");
    const bytes = v8.serialize({ n: 1, s: "x" });
    // Bare JSC bytes deserialize directly — no envelope framing present.
    expect(jsc.deserialize(bytes)).toEqual({ n: 1, s: "x" });
    // deserialize also accepts current bare output from jsc.serialize.
    const bare = jsc.serialize({ buf: new Uint8Array([7]) }, { binaryType: "nodebuffer" });
    expect(v8.deserialize(bare)).toEqual({ buf: new Uint8Array([7]) });
  });

  test.each([249, 250, 251, 252, 65529, 65530, 65531, 65532])(
    "Buffer envelope retains aliases across %i values",
    count => {
      const buffer = Buffer.from("slots");
      const values = Array.from({ length: count }, (_, index) => ({ index }));
      const input: any = { values, buffer, again: buffer, first: values[0], last: values.at(-1) };
      input.self = input;
      const out = v8.deserialize(v8.serialize(input));
      expect(out.self).toBe(out);
      expect(out.first).toBe(out.values[0]);
      expect(out.last).toBe(out.values.at(-1));
      expect(out.buffer).toBe(out.again);
      expect(Buffer.isBuffer(out.buffer)).toBe(true);
      expect(out.buffer.toString()).toBe("slots");
    },
  );

  test("Buffer-free Error graphs retain byte-for-byte bare framing", () => {
    const jsc = require("bun:jsc");
    const error = new Error("bare", { cause: new Map([["cause", { n: 1 }]]) });
    error.stack = "stable";
    const input = [error, error];
    expect(v8.serialize(input)).toEqual(jsc.serialize(input, { binaryType: "nodebuffer" }));
  });

  test("advanced IPC tags Buffers introduced by earlier Error metadata", async () => {
    const source = [
      'process.once("message", () => {',
      "let calls = 0;",
      'for (const initial of ["buffer", "absent"]) for (const field of ["name", "message", "stack"]) {',
      ' const later = initial === "buffer" ? new Error("later", { cause: Buffer.from("old") }) : new Error("later");',
      ' const first = new Error("first"); first.stack = "";',
      ' const effect = () => { calls++; const b = Buffer.from("new"); later.cause = new Map([[b, b]]); return field === "name" ? "Error" : "metadata"; };',
      ' Object.defineProperty(first, field, field === "message" ? { value: { toString: effect } } : { get: effect });',
      " process.send([first, later, later]);",
      "}",
      "process.send({ done: true, calls });",
      "});",
    ].join("\n");
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const messages: any[] = [];
    let calls;
    await using child = Bun.spawn({
      cmd: [bunExe(), "-e", source],
      env: bunEnv,
      stdout: "ignore",
      stderr: "inherit",
      serialization: "advanced",
      ipc(message) {
        if (message?.done) {
          calls = message.calls;
          resolve();
        } else messages.push(message);
      },
      onExit(_child, code, signal) {
        reject(new Error("IPC child exited before completion: " + code + "/" + signal));
      },
    });
    child.send("ready");
    await promise;
    expect(calls).toBe(6);
    expect(messages).toHaveLength(6);
    for (const out of messages) {
      expect(out[1]).toBe(out[2]);
      const [[key, value]] = [...out[1].cause];
      expect(key).toBe(value);
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.toString()).toBe("new");
    }
  });

  test("rejects an envelope whose buffer list holds a non-Uint8Array view", () => {
    // The envelope's buffer list gets Buffer.prototype applied to each entry.
    // A crafted payload can put any typed array there; only Uint8Arrays may
    // become Buffers.
    const jsc = require("bun:jsc");
    const f = new Float64Array([1.5]);
    const payload = jsc.serialize([{ b: f }, [f]], { binaryType: "nodebuffer" });
    const magic = Buffer.from([0xff, 0x42, 0x55, 0x4e, 0x01]);
    expect(() => v8.deserialize(Buffer.concat([magic, payload]))).toThrow("failed to parse serialized buffer envelope");
  });

  test("circular structures with Buffers", () => {
    const obj: any = { buf: Buffer.from("c") };
    obj.self = obj;
    const out = v8.deserialize(v8.serialize(obj));
    expect(out.self).toBe(out);
    expect(Buffer.isBuffer(out.buf)).toBe(true);
  });

  test("round-trip survives tampered globals and prototypes", async () => {
    // Everything the envelope framing touches is captured at module load, so
    // tampering after the module loads must not reach serialize/deserialize.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const v8 = require("node:v8");
        ArrayBuffer.isView = () => false;
        Buffer.allocUnsafe = () => { throw new Error("tampered allocUnsafe"); };
        Buffer.prototype.copy = () => { throw new Error("tampered copy"); };
        const TAProto = Object.getPrototypeOf(Uint8Array.prototype);
        for (const k of ["buffer", "byteOffset", "byteLength"]) {
          Object.defineProperty(TAProto, k, { get() { throw new Error("tampered " + k); } });
        }
        Uint8Array.prototype.subarray = () => { throw new Error("tampered subarray"); };
        globalThis.Uint8Array = function Poisoned() { throw new Error("tampered ctor"); };
        const out = v8.deserialize(v8.serialize({ b: Buffer.from("hi") }));
        console.log(Buffer.isBuffer(out.b), out.b.toString());`,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("true hi\n");
    expect(exitCode).toBe(0);
  });

  test("DataView and ArrayBuffer inputs survive tampered brand checks", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const v8 = require("node:v8");
        const bytes = v8.serialize({ b: Buffer.from("dv") });
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        ArrayBuffer.isView = () => false;
        Object.defineProperty(ArrayBuffer, Symbol.hasInstance, { value: () => false });
        Object.defineProperty(SharedArrayBuffer, Symbol.hasInstance, { value: () => false });
        const a = v8.deserialize(dv);
        const b = v8.deserialize(ab);
        console.log(Buffer.isBuffer(a.b), Buffer.isBuffer(b.b));`,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("true true\n");
    expect(exitCode).toBe(0);
  });
});
