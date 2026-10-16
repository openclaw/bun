import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const file = path.join(process.argv[2], "file.txt");
fs.writeFileSync(file, "not a directory");
for (const candidate of [path.join(file, "child"), file + path.sep]) {
  for (const bigint of [false, true]) {
    const options = { throwIfNoEntry: false, bigint };
    assert.equal(fs.statSync(candidate, options), undefined);
    assert.equal(await fs.promises.stat(candidate, options), undefined);
    assert.equal(await promisify(fs.stat)(candidate, options), undefined);
    const code = process.platform === "win32" ? "ENOENT" : "ENOTDIR";
    for (const throwIfNoEntry of [undefined, true]) {
      const throwing = { bigint, throwIfNoEntry };
      assert.throws(() => fs.statSync(candidate, throwing), { code });
      await assert.rejects(fs.promises.stat(candidate, throwing), { code });
      await assert.rejects(promisify(fs.stat)(candidate, throwing), { code });
    }
    if (process.platform !== "win32") {
      assert.throws(() => fs.lstatSync(candidate, options), { code: "ENOTDIR" });
      await assert.rejects(fs.promises.lstat(candidate, options), { code: "ENOTDIR" });
      await assert.rejects(promisify(fs.lstat)(candidate, options), { code: "ENOTDIR" });
    }
  }
}
const missing = path.join(process.argv[2], "missing");
assert.equal(fs.statSync(missing, { throwIfNoEntry: false }), undefined);
assert.equal(fs.lstatSync(missing, { throwIfNoEntry: false }), undefined);
console.log("stat oracle passed");
