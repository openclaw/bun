import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { isMacOS, isWindows, tempDir } from "harness";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

function noop() {}
describe("fs.opendir", () => {
  // TODO: validatePath
  // it.each([1, 0, null, undefined, function foo() {}, Symbol.for("foo")])(
  //   "throws if the path is not a string: %p",
  //   (path: any) => {
  //     expect(() => fs.opendir(path, noop)).toThrow(/The "path" argument must be of type string/);
  //   },
  // );

  it("throws if callback is not provided", () => {
    expect(() => fs.opendir("foo")).toThrow(/The "callback" argument must be of type function/);
  });

  it("opendirSync on a file throws ENOTDIR with libuv's platform errno", () => {
    const file = path.join(os.tmpdir(), "opendir-enotdir-" + String(Math.random() * 100).substring(0, 6) + ".txt");
    fs.writeFileSync(file, "not a directory");
    try {
      let err: any;
      try {
        fs.opendirSync(file);
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("ENOTDIR");
      expect(err?.errno).toBe(process.platform === "win32" ? -4052 : -20);
      expect(err?.syscall).toBe("opendir");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("fs.Dir", () => {
  describe("given an empty temp directory", () => {
    let dirname: string;

    beforeAll(() => {
      const name = "dir-sync.test." + String(Math.random() * 100).substring(0, 6);
      dirname = path.join(os.tmpdir(), name);
      fs.mkdirSync(dirname);
    });

    afterAll(() => {
      fs.rmSync(dirname, { recursive: true, force: true });
    });

    describe("when an empty directory is opened", () => {
      let dir: fs.Dir;

      beforeEach(() => {
        dir = fs.opendirSync(dirname);
      });

      afterEach(() => {
        try {
          dir.closeSync();
        } catch {
          /* suppress */
        }
      });

      it("returns a Dir instance", () => {
        expect(dir).toBeDefined();
        expect(dir).toBeInstanceOf(fs.Dir);
      });

      describe("reading from the directory", () => {
        it.each([0, 1, false, "foo", {}])("throws if passed a non-function callback (%p)", badCb => {
          expect(() => dir.read(badCb)).toThrow(/The "callback" argument must be of type function/);
        });

        it("it can be read synchronously, even though no entries exist", () => {
          for (let i = 0; i < 5; i++) {
            const actual = dir.readSync();
            expect(actual).toBeNull();
          }
        });

        it("can be read asynchronously, even though no entries exist", async () => {
          const actual = await dir.read();
          expect(actual).toBeNull();
        });

        it("can be read asynchronously with callbacks, even though no entries exist", async () => {
          const actual = await new Promise((resolve, reject) => {
            dir.read((err, ent) => {
              if (err) reject(err);
              else resolve(ent);
            });
          });
          expect(actual).toBeNull();
        });
      }); // </reading from the directory>

      it("can be closed asynchronously", async () => {
        const actual = await dir.close();
        expect(actual).toBeUndefined();
      });

      it("can be closed asynchronously with callbacks", async () => {
        const actual = await new Promise<void>((resolve, reject) => {
          dir.close(err => {
            if (err) reject(err);
            else resolve();
          });
        });
        expect(actual).toBeUndefined();
      });

      it("can be closed synchronously", () => {
        expect(dir.closeSync()).toBeUndefined();
      });

      describe("when closed", () => {
        beforeEach(async () => {
          await dir.close();
        });

        it('attempts to close again will throw "Directory handle was closed"', () => {
          expect(() => dir.closeSync()).toThrow("Directory handle was closed");
          expect(() => dir.close()).toThrow("Directory handle was closed");
        });

        it("attempts to read will throw", () => {
          expect(() => dir.readSync()).toThrow("Directory handle was closed");
          expect(() => dir.read()).toThrow("Directory handle was closed");
        });
      }); // </when closed>
    }); // </when an empty directory is opened>
  }); // </given an empty temp directory>
}); // </fs.Dir>

describe("fs.opendir async validation", () => {
  it("does not invoke the callback synchronously", async () => {
    const dirname = path.join(os.tmpdir(), "opendir-async-" + String(Math.random() * 100).substring(0, 6));
    fs.mkdirSync(dirname);
    try {
      let sync = true;
      const { promise, resolve } = Promise.withResolvers<boolean>();
      fs.opendir(dirname, (err, dir) => {
        resolve(sync);
        dir?.close(() => {});
      });
      sync = false;
      expect(await promise).toBe(false);
    } finally {
      fs.rmSync(dirname, { recursive: true, force: true });
    }
  });

  it("reports ENOTDIR through the callback, not a synchronous throw", async () => {
    const file = path.join(os.tmpdir(), "opendir-async-file-" + String(Math.random() * 100).substring(0, 6));
    fs.writeFileSync(file, "x");
    try {
      const { promise, resolve } = Promise.withResolvers<any>();
      fs.opendir(file, err => resolve(err));
      const err = await promise;
      expect(err?.code).toBe("ENOTDIR");
      expect(err?.syscall).toBe("opendir");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("opendirSync string encoding shorthand", () => {
  it("validates a string options argument as an encoding", () => {
    const dirname = path.join(os.tmpdir(), "opendir-enc-" + String(Math.random() * 100).substring(0, 6));
    fs.mkdirSync(dirname);
    try {
      // an invalid encoding passed as the shorthand is validated like node
      expect(() => fs.opendirSync(dirname, "nope")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    } finally {
      fs.rmSync(dirname, { recursive: true, force: true });
    }
  });

  // On Windows the native readdir always emits UTF-8 names (a pre-existing
  // gap: fs.readdirSync ignores the encoding option there too), so the
  // byte-reinterpretation is only observable on POSIX.
  it.skipIf(process.platform === "win32")("applies the encoding to entry names", () => {
    const dirname = path.join(os.tmpdir(), "opendir-enc-" + String(Math.random() * 100).substring(0, 6));
    fs.mkdirSync(dirname);
    // latin1 makes the shorthand observable: the utf8 bytes of the name are
    // reinterpreted per-byte.
    fs.writeFileSync(path.join(dirname, "na\u00efve.txt"), "x");
    try {
      const dir = fs.opendirSync(dirname, "latin1");
      const entry = dir.readSync();
      expect(entry?.name).toBe(Buffer.from("na\u00efve.txt", "utf8").toString("latin1"));
      dir.closeSync();
    } finally {
      fs.rmSync(dirname, { recursive: true, force: true });
    }
  });
});

describe("directory entries with buffer names", () => {
  const readers = [
    ["readdirSync", (dir, options) => fs.readdirSync(dir, { ...options, withFileTypes: true })],
    ["readdir callback", (dir, options) => promisify(fs.readdir)(dir, { ...options, withFileTypes: true })],
    ["readdir promise", (dir, options) => fs.promises.readdir(dir, { ...options, withFileTypes: true })],
    [
      "opendirSync/readSync",
      (dir, options) => {
        using handle = fs.opendirSync(dir, options);
        const entries = [];
        for (let entry; (entry = handle.readSync()) !== null; ) entries.push(entry);
        return entries;
      },
    ],
    [
      "opendir callback/read callback",
      async (dir, options) => {
        await using handle = await promisify(fs.opendir)(dir, options);
        const entries = [];
        for (let entry; (entry = await promisify(handle.read.bind(handle))()) !== null; ) entries.push(entry);
        return entries;
      },
    ],
    [
      "opendir promise/read promise",
      async (dir, options) => {
        await using handle = await fs.promises.opendir(dir, options);
        const entries = [];
        for (let entry; (entry = await handle.read()) !== null; ) entries.push(entry);
        return entries;
      },
    ],
    [
      "opendir async iterator",
      async (dir, options) => {
        const entries = [];
        for await (const entry of await fs.promises.opendir(dir, options)) entries.push(entry);
        return entries;
      },
    ],
  ] as const;

  it.each(readers)("%s preserves Buffer names and file types", async (_label, read) => {
    using dir = tempDir("dirent-buffer-names", { "ascii.txt": "", "unicode-😀.txt": "", "child/nested.txt": "" });
    const names = ["ascii.txt", "unicode-😀.txt", "child"];
    const entries = await read(String(dir), { encoding: "buffer" });
    expect(entries.map(entry => entry instanceof fs.Dirent)).toEqual(names.map(() => true));
    const retained = entries.map(entry => entry.name);
    expect(
      entries
        .map(entry => ({
          dirent: entry instanceof fs.Dirent,
          buffer: Buffer.isBuffer(entry.name),
          hex: Buffer.from(entry.name).toString("hex"),
          directory: entry.isDirectory(),
          file: entry.isFile(),
          parentPath: entry.parentPath,
        }))
        .sort((a, b) => a.hex.localeCompare(b.hex)),
    ).toEqual(
      names
        .map(name => ({
          dirent: true,
          buffer: true,
          hex: Buffer.from(name).toString("hex"),
          directory: name === "child",
          file: name !== "child",
          parentPath: String(dir),
        }))
        .sort((a, b) => a.hex.localeCompare(b.hex)),
    );
    const textEntries = await read(String(dir), {});
    expect(textEntries.map(entry => entry.name).sort()).toEqual(names.toSorted());
    expect(
      fs
        .readdirSync(String(dir), { encoding: "buffer" })
        .map(name => [Buffer.isBuffer(name), name.toString("hex")])
        .sort(),
    ).toEqual(names.map(name => [true, Buffer.from(name).toString("hex")]).sort());
    Bun.gc(true);
    expect(retained.map(name => Buffer.from(name).toString("hex")).sort()).toEqual(
      names.map(name => Buffer.from(name).toString("hex")).sort(),
    );
  });

  // Windows paths are UTF-16; macOS rejects invalid UTF-8 filename bytes with EILSEQ.
  it.skipIf(isWindows || isMacOS).each(readers)("%s preserves distinct non-UTF-8 names", async (_label, read) => {
    using dir = tempDir("dirent-raw-names", {});
    const names = [
      Buffer.from([0x72, 0x61, 0x77, 0xff]),
      Buffer.from([0x72, 0x61, 0x77, 0xfe]),
      Buffer.from("raw\ufffd"),
    ];
    const prefix = Buffer.from(String(dir) + path.sep);
    for (const name of names) fs.writeFileSync(Buffer.concat([prefix, name]), "");
    fs.symlinkSync(Buffer.concat([prefix, names[0]]), path.join(String(dir), "link"));
    const entries = await read(Buffer.from(String(dir)), { encoding: "buffer" });
    expect(entries.map(entry => entry instanceof fs.Dirent)).toEqual([true, true, true, true]);
    await read(String(dir), {});
    Bun.gc(true);
    expect(
      entries
        .map(entry => ({
          buffer: Buffer.isBuffer(entry.name),
          hex: Buffer.from(entry.name).toString("hex"),
          file: entry.isFile(),
          link: entry.isSymbolicLink(),
        }))
        .sort((a, b) => a.hex.localeCompare(b.hex)),
    ).toEqual(
      [...names, Buffer.from("link")]
        .map(name => ({
          buffer: true,
          hex: name.toString("hex"),
          file: !name.equals(Buffer.from("link")),
          link: name.equals(Buffer.from("link")),
        }))
        .sort((a, b) => a.hex.localeCompare(b.hex)),
    );
  });

  it.each(readers.slice(0, 3))("%s preserves Buffer names in recursive results", async (_label, read) => {
    using dir = tempDir("dirent-recursive-buffer", { "top.txt": "", "child/unicode-😀.txt": "" });
    const entries = await read(String(dir), { encoding: "buffer", recursive: true });
    expect(entries.map(entry => entry instanceof fs.Dirent)).toEqual([true, true, true]);
    expect(
      entries
        .map(entry => ({
          buffer: Buffer.isBuffer(entry.name),
          hex: Buffer.from(entry.name).toString("hex"),
          parentPath: entry.parentPath,
          directory: entry.isDirectory(),
        }))
        .sort((a, b) => a.hex.localeCompare(b.hex)),
    ).toEqual(
      [
        { buffer: true, hex: Buffer.from("child").toString("hex"), parentPath: String(dir), directory: true },
        { buffer: true, hex: Buffer.from("top.txt").toString("hex"), parentPath: String(dir), directory: false },
        {
          buffer: true,
          hex: Buffer.from("unicode-😀.txt").toString("hex"),
          parentPath: path.join(String(dir), "child"),
          directory: false,
        },
      ].sort((a, b) => a.hex.localeCompare(b.hex)),
    );
  });

  it.skipIf(isWindows || isMacOS).each(readers.slice(0, 3))(
    "%s preserves distinct non-UTF-8 names in recursive results",
    async (_label, read) => {
      using dir = tempDir("dirent-recursive-raw", {});
      const child = path.join(String(dir), "child");
      fs.mkdirSync(child);
      const names = [
        Buffer.from([0x72, 0x61, 0x77, 0xff]),
        Buffer.from([0x72, 0x61, 0x77, 0xfe]),
        Buffer.from("raw\ufffd"),
      ];
      const prefix = Buffer.from(child + path.sep);
      for (const name of names) fs.writeFileSync(Buffer.concat([prefix, name]), "");
      const entries = await read(String(dir), { encoding: "buffer", recursive: true });
      expect(entries.map(entry => entry instanceof fs.Dirent)).toEqual([true, true, true, true]);
      expect(
        entries
          .map(entry => ({
            buffer: Buffer.isBuffer(entry.name),
            hex: Buffer.from(entry.name).toString("hex"),
            parentPath: entry.parentPath,
            directory: entry.isDirectory(),
          }))
          .sort((a, b) => a.hex.localeCompare(b.hex)),
      ).toEqual(
        [
          { buffer: true, hex: Buffer.from("child").toString("hex"), parentPath: String(dir), directory: true },
          ...names.map(name => ({ buffer: true, hex: name.toString("hex"), parentPath: child, directory: false })),
        ].sort((a, b) => a.hex.localeCompare(b.hex)),
      );
    },
  );
});

// Node's Dir implements Symbol.dispose / Symbol.asyncDispose so it composes
// with `using` / `await using`. Disposing an already-closed Dir is a no-op.
describe("Dir explicit resource management", () => {
  let dirname: string;
  beforeEach(() => {
    dirname = path.join(os.tmpdir(), "opendir-dispose-" + String(Math.random() * 100).substring(0, 6));
    fs.mkdirSync(dirname);
    fs.writeFileSync(path.join(dirname, "entry.txt"), "x");
  });
  afterEach(() => {
    fs.rmSync(dirname, { recursive: true, force: true });
  });

  it("`using` closes the directory at scope exit", () => {
    let dir!: fs.Dir;
    {
      using d = fs.opendirSync(dirname);
      dir = d;
      expect(d.readSync()?.name).toBe("entry.txt");
    }
    expect(() => dir.readSync()).toThrow(expect.objectContaining({ code: "ERR_DIR_CLOSED" }));
  });

  it("`await using` closes the directory at scope exit", async () => {
    let dir!: fs.Dir;
    {
      await using d = await fs.promises.opendir(dirname);
      dir = d;
    }
    expect(() => dir.readSync()).toThrow(expect.objectContaining({ code: "ERR_DIR_CLOSED" }));
  });

  it("disposing an already-closed Dir does not throw", async () => {
    const dir = fs.opendirSync(dirname);
    dir.closeSync();
    expect(() => dir[Symbol.dispose]()).not.toThrow();
    await expect(dir[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
