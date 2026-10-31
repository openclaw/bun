import assert from "node:assert/strict";
import cp from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const node = process.env.CONTRACT_NODE;
const root = realpathSync(process.env.LAND175276_ROOT);
const marker = "private-child-contract";
const childCwd = join(root, "child-cwd");
mkdirSync(childCwd, { recursive: true });
const payload =
  "console.log(JSON.stringify({pid:process.pid,cwd:process.cwd(),marker:process.env.CONTRACT_MARKER,args:process.argv.slice(2)}));console.error('child-stderr');process.exit(Number(process.env.CONTRACT_EXIT||0));";
const fresh = (extra = {}) => ({ PATH: process.env.PATH, CONTRACT_MARKER: marker, ...extra });
const options = extra => ({ cwd: childCwd, env: fresh(), encoding: "utf8", timeout: 15000, ...extra });
const results = [];
function promised(api, ...args) {
  assert.equal(typeof cp[api][promisify.custom], "function");
  return promisify(cp[api])(...args);
}
process.env.CONTRACT_MARKER = marker;
async function check(name, action) {
  process.stderr.write("case: " + name + "\n");
  try {
    await action();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
  }
}
function output(stdout, stderr, child, cwd = childCwd) {
  const value = JSON.parse(stdout.toString().trim());
  assert.equal(value.marker, marker);
  assert.equal(realpathSync(value.cwd), cwd);
  if (stderr !== undefined) assert.match(stderr.toString(), /child-stderr/);
  if (child) assert.equal(value.pid, child.pid);
  const receipts = readdirSync(join(root, "preflights")).map(file =>
    JSON.parse(readFileSync(join(root, "preflights", file))),
  );
  const receipt = receipts.find(receipt => receipt.pid === value.pid);
  assert(receipt, "fresh-env descendant must run resolver before payload");
  assert.equal(receipt.source, realpathSync(process.env.LAND175276_CONSUMER));
  assert(receipt.resolved.startsWith(root + sep));
  return value;
}
const quote = value =>
  process.platform === "win32" ? '"' + value + '"' : "'" + value.replaceAll("'", "'\"'\"'") + "'";
const command = [node, "-e", payload].map(quote).join(" ");
const invocations = (fn, opts, callback) => ({
  omitted: () => fn(node, opts, callback),
  undefined: () => fn(node, undefined, opts, callback),
  null: () => fn(node, null, opts, callback),
  array: () => fn(node, [], opts, callback),
});

if (process.argv[2] === "sync") {
  for (const api of ["spawnSync", "execFileSync"]) {
    for (const [name, invoke] of Object.entries(invocations(cp[api], options({ input: payload })))) {
      await check(api + ":" + name, () => {
        const value = invoke();
        if (api === "spawnSync") {
          output(value.stdout, value.stderr);
          assert.equal(value.status, 0);
          assert.equal(value.error, undefined);
        } else output(value);
      });
    }
  }
  await check("environment-prototype", () => {
    const env = Object.assign(Object.create({ CONTRACT_MARKER: marker }), { PATH: process.env.PATH });
    const value = cp.spawnSync(node, ["-e", payload], options({ env }));
    output(value.stdout, value.stderr);
    assert.equal(value.status, 0);
  });
  await check("execSync:options", () => output(cp.execSync(command, options())));
  await check("spawnSync:nonzero-buffer", () => {
    const value = cp.spawnSync(
      node,
      ["-e", payload],
      options({ encoding: "buffer", env: fresh({ CONTRACT_EXIT: "7" }) }),
    );
    assert(Buffer.isBuffer(value.stdout));
    output(value.stdout, value.stderr);
    assert.equal(value.status, 7);
  });
  await check("execFileSync:nonzero", () => {
    assert.throws(
      () => cp.execFileSync(node, ["-e", payload], options({ env: fresh({ CONTRACT_EXIT: "7" }) })),
      error => {
        output(error.stdout, error.stderr);
        assert.equal(error.status, 7);
        return true;
      },
    );
  });
  await check("spawnSync:timeout", () => {
    const value = cp.spawnSync(node, ["-e", "setInterval(()=>{},1000)"], options({ timeout: 2000 }));
    assert.equal(value.error?.code, "ETIMEDOUT");
    assert(value.signal);
  });
  await check("execFileSync:function-argv-retains-preflight", () => {
    const before = new Set(readdirSync(join(root, "preflights")));
    let callbacks = 0;
    const value = cp.execFileSync(node, () => callbacks++);
    assert.equal(value.toString(), "");
    assert.equal(callbacks, 0);
    const added = readdirSync(join(root, "preflights")).filter(file => !before.has(file));
    assert.equal(added.length, 1, "valid function argv must retain the child resolver gate");
    const receipt = JSON.parse(readFileSync(join(root, "preflights", added[0])));
    assert.notEqual(receipt.pid, process.pid);
    assert.equal(receipt.source, realpathSync(process.env.LAND175276_CONSUMER));
    assert(receipt.resolved.startsWith(root + sep));
  });
  await check("execFileSync:function-options-rejected-before-spawn", () => {
    const script = join(root, "invalid-options-child.cjs");
    const markerFile = join(root, "invalid-options-child-ran");
    writeFileSync(
      script,
      'require("node:fs").writeFileSync(' + JSON.stringify(markerFile) + ", String(process.pid));",
    );
    const before = readdirSync(join(root, "preflights")).sort();
    let error;
    try {
      try {
        cp.execFileSync(node, [script], function callback() {});
      } catch (caught) {
        error = caught;
      }
      // Check the side effect and resolver receipts even when no exception was thrown.
      assert.equal(existsSync(markerFile), false, "invalid options must not execute the child");
      assert.deepEqual(readdirSync(join(root, "preflights")).sort(), before);
      assert(error instanceof TypeError);
      assert.equal(error.code, "ERR_INVALID_ARG_TYPE");
    } finally {
      rmSync(script, { force: true });
      rmSync(markerFile, { force: true });
    }
  });
  await check("validation", () => {
    for (const api of ["spawn", "spawnSync", "fork"]) {
      let child;
      try {
        assert.throws(() => {
          child = cp[api](node, "bad-argv", {});
        }, TypeError);
      } finally {
        // A regressed wrapper may launch a child instead of rejecting invalid argv.
        child?.stdin?.end();
        child?.kill?.();
      }
    }
    for (const api of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"])
      assert.throws(() => cp[api](node, ["--version"], 42), TypeError);
    assert.throws(() => cp.spawnSync(node, [], null), TypeError);
    assert.throws(() => cp.execFile(node, [], {}, "bad-callback"), TypeError);
    assert.throws(() => cp.spawnSync(node, [], options({ timeout: -1 })));
  });
  if (globalThis.Bun)
    for (const api of ["spawnSync", "spawn"]) {
      await check("Bun." + api + ":fresh-env", async () => {
        const opts = { cwd: childCwd, env: fresh(), stdout: "pipe", stderr: "pipe" };
        const child = Bun[api]([process.execPath, "-e", payload], opts);
        if (api === "spawnSync") {
          output(child.stdout, child.stderr, child);
          assert.equal(child.exitCode, 0);
        } else {
          const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
          output(stdout, stderr, child);
          assert.equal(code, 0);
        }
      });
    }
} else {
  for (const api of ["spawn", "execFile"])
    for (const name of ["omitted", "undefined", "null", "array"]) {
      await check(
        api + ":" + name,
        () =>
          new Promise((resolve, reject) => {
            const callback = (error, stdout, stderr) => {
              try {
                assert.equal(error, null);
                output(stdout, stderr, child);
                resolve();
              } catch (error) {
                reject(error);
              }
            };
            const child = invocations(cp[api], options(), callback)[name]();
            if (api === "spawn") {
              let stdout = "",
                stderr = "";
              child.stdout.on("data", value => (stdout += value));
              child.stderr.on("data", value => (stderr += value));
              child.on("error", reject);
              child.on("close", code => {
                try {
                  output(stdout, stderr, child);
                  assert.equal(code, 0);
                  resolve();
                } catch (error) {
                  reject(error);
                }
              });
            }
            child.stdin.end(payload);
          }),
      );
    }
  for (const api of ["exec", "execFile"])
    await check(
      api + ":callback-only",
      () =>
        new Promise((resolve, reject) => {
          const child = cp[api](api === "exec" ? command : node, (error, stdout, stderr) => {
            try {
              assert.equal(error, null);
              output(stdout, stderr, api === "execFile" ? child : undefined, root);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          if (api === "execFile") child.stdin.end(payload);
        }),
    );
  for (const [name, args] of [
    ["omitted", []],
    ["undefined", [undefined]],
    ["null", [null]],
    ["array", [[]]],
  ])
    await check("execFile:promisify-argv:" + name, async () => {
      const promise = promised("execFile", node, ...args, options());
      promise.child.stdin.end(payload);
      const value = await promise;
      output(value.stdout, value.stderr, promise.child);
    });
  await check("promisify-validation", () => {
    assert.throws(() => promised("exec", 42), TypeError);
    assert.throws(() => promised("execFile", 42), TypeError);
  });
  await check("execFile:promisify-ENOENT", async () => {
    const promise = promised("execFile", join(root, "does-not-exist"), [], options());
    assert.equal(typeof promise.child.kill, "function");
    await assert.rejects(promise, error => {
      assert.equal(error.code, "ENOENT");
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      return true;
    });
  });
  await check(
    "exec:callback",
    () =>
      new Promise((resolve, reject) => {
        const child = cp.exec(command, options(), (error, stdout, stderr) => {
          try {
            assert.equal(error, null);
            output(stdout, stderr);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }),
  );
  await check(
    "execFile:callback-failure",
    () =>
      new Promise((resolve, reject) => {
        const child = cp.execFile(
          node,
          ["-e", payload],
          options({ env: fresh({ CONTRACT_EXIT: "7" }) }),
          (error, stdout, stderr) => {
            try {
              assert.equal(error.code, 7);
              output(stdout, stderr, child);
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        );
      }),
  );
  for (const api of ["exec", "execFile"])
    for (const failed of [false, true])
      await check(api + ":promisify:" + failed, async () => {
        const opts = options({
          env: fresh({ CONTRACT_EXIT: failed ? "7" : "0" }),
          encoding: failed ? "buffer" : "utf8",
        });
        const promise = api === "exec" ? promised(api, command, opts) : promised(api, node, ["-e", payload], opts);
        assert.equal(typeof promise.child?.kill, "function");
        if (failed)
          await assert.rejects(promise, error => {
            assert.equal(error.code, 7);
            assert(Buffer.isBuffer(error.stdout));
            output(error.stdout, error.stderr, api === "execFile" ? promise.child : undefined);
            return true;
          });
        else {
          const value = await promise;
          output(value.stdout, value.stderr, api === "execFile" ? promise.child : undefined);
        }
      });
  await check("execFile:promisify-timeout", async () => {
    const promise = promised("execFile", node, ["-e", "setInterval(()=>{},1000)"], options({ timeout: 2000 }));
    await assert.rejects(promise, error => {
      assert.equal(error.killed, true);
      assert(error.signal);
      assert.equal(typeof error.stdout, "string");
      return true;
    });
  });
  for (const name of ["omitted", "undefined", "null", "array"])
    await check(
      "fork:" + name,
      () =>
        new Promise((resolve, reject) => {
          const opts = options({ silent: true, execArgv: [] });
          const child = invocations((_, ...args) => cp.fork(process.env.CONTRACT_FORK, ...args), opts)[name]();
          let stdout = "",
            stderr = "";
          child.stdout.on("data", value => (stdout += value));
          child.stderr.on("data", value => (stderr += value));
          child.on("error", reject);
          child.on("close", code => {
            try {
              output(stdout, stderr, child);
              assert.equal(code, 0);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        }),
    );
}
console.log(JSON.stringify({ runtime: process.execPath, version: process.version, results }));
if (results.some(result => !result.ok)) process.exitCode = 1;
