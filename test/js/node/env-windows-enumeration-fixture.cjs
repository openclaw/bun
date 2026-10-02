const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { Worker, SHARE_ENV } = require("node:worker_threads");
const values = { TZ: "UTC", NODE_TLS_REJECT_UNAUTHORIZED: "1", BUN_CONFIG_VERBOSE_FETCH: "0" };
const keys = Object.keys(values);
const select = env => Object.fromEntries(keys.map(key => [key, env[key]]));

async function main() {
  for (const key of keys) assert.equal(process.env[key], undefined);
  Object.assign(process.env, values);
  const check = () => {
    for (const key of keys) {
      assert.equal(Object.getOwnPropertyDescriptor(process.env, key).enumerable, true, key);
      assert.equal(Object.keys(process.env).includes(key), true, key);
    }
    assert.deepEqual(select({ ...process.env }), values);
    assert.deepEqual(select(Object.fromEntries(Object.entries(process.env))), values);
    assert.deepEqual(select(JSON.parse(JSON.stringify(process.env))), values);
    const result = spawnSync(
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map(k => process.env[k])))`],
      {
        env: { ...process.env },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), Object.values(values));
  };
  check();
  assert.equal(new Date("2026-01-01T00:00:00Z").getTimezoneOffset(), 0);
  const worker = new Worker(
    `const {parentPort} = require("node:worker_threads"); parentPort.postMessage(${JSON.stringify(keys)}.map(k => process.env[k]));`,
    { eval: true, env: SHARE_ENV },
  );
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), [Object.values(values)]);
  assert.deepEqual(await exited, [0]);
  check();
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  check();
  console.log("ok");
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
