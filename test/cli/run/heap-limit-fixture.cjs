const assert = require("node:assert/strict");
const { fork, spawn } = require("node:child_process");
const { isMainThread, Worker, parentPort, workerData } = require("node:worker_threads");
const gcApi = process.versions.bun ? "Bun.gc(true)" : "global.gc()";
const collect = process.versions.bun ? globalThis.Bun.gc : global.gc;
assert.equal(typeof collect, "function", `${gcApi} must be available`);

function allocate(kind, mib) {
  globalThis.held = [];
  for (let index = 0; index < mib / 8; index++) {
    if (kind === "churn") globalThis.held = [];
    held.push(kind === "buffers" ? new Uint8Array(8 * 1024 * 1024).fill(index) : new Array(1024 * 1024).fill(index));
    if (process.versions.bun) collect(true);
    else collect();
  }
  assert.equal(held.at(-1)[0], mib / 8 - 1);
  return "completed";
}

async function runWorker(options) {
  const events = [];
  const messages = [];
  let error;
  const worker = new Worker(__filename, {
    resourceLimits: { maxOldGenerationSizeMb: options.resource },
    ...(options.emptyExecArgv ? { execArgv: [] } : {}),
    ...(options.workerEnv ? { env: { ...process.env, NODE_OPTIONS: options.workerEnv } } : {}),
    workerData: { kind: options.kind || "arrays", mib: options.mib, nested: options.nested },
  });
  worker.on("message", message => messages.push(message));
  worker.on("error", reason => {
    events.push("error");
    error = { name: reason.name, code: reason.code, message: reason.message };
  });
  return new Promise(resolve =>
    worker.on("exit", code => {
      events.push("exit");
      resolve({ events, messages, error, code });
    }),
  );
}

async function runChild(options) {
  const argv = ["arrays", JSON.stringify({ mib: options.mib })];
  const env = options.clearEnv ? { ...process.env, NODE_OPTIONS: "" } : process.env;
  const child = options.fork
    ? fork(__filename, argv, {
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        ...(options.emptyExecArgv ? { execArgv: ["--expose-gc"] } : {}),
      })
    : spawn(process.execPath, ["--expose-gc", __filename, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => (stdout += chunk));
  child.stderr.on("data", chunk => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        if (code === 0) {
          assert.equal(stdout, "completed\n");
          assert.equal(stderr, "");
          resolve("completed");
        } else {
          assert.match(stderr, /JavaScript heap out of memory/);
          if (process.platform === "win32") assert.equal(code, 134);
          else assert.equal(signal, "SIGABRT");
          resolve("oom");
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

(async () => {
  if (!isMainThread) {
    parentPort.postMessage(
      workerData.kind === "gc-api"
        ? gcApi
        : workerData.nested
          ? await runWorker({ mib: workerData.mib, resource: 16, emptyExecArgv: true })
          : allocate(workerData.kind, workerData.mib),
    );
    return;
  }
  const [mode, input] = process.argv.slice(2);
  const options = JSON.parse(input || "{}");
  if (mode === "worker") console.log(JSON.stringify(await runWorker(options)));
  else if (mode === "gc-api")
    console.log(JSON.stringify({ gcApi, worker: await runWorker({ kind: "gc-api", resource: 128 }) }));
  else if (mode === "child") console.log(await runChild(options));
  else if (mode === "argv") console.log(JSON.stringify(process.execArgv));
  else if (mode === "invalid-worker") {
    assert.throws(() => new Worker(__filename, { execArgv: [options.flag] }), {
      name: "Error",
      code: "ERR_WORKER_INVALID_EXEC_ARGV",
      message: `Initiated Worker with invalid execArgv flags: ${options.flag}`,
    });
    console.log("rejected");
  } else console.log(allocate(mode, options.mib));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
