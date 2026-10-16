import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [directory, mode, childMode] = process.argv.slice(2);
const marker = path.join(directory, `${mode}.disconnected`);
if (childMode) {
  const order = [];
  const disconnected = once(process, "disconnect");
  process.on("disconnect", () => order.push("disconnect"));
  const handle = mode === "handle" ? net.createServer() : undefined;
  if (handle) await new Promise(resolve => handle.listen(0, "127.0.0.1", resolve));
  process.send({ oracleReady: true });
  if (mode === "closed") await disconnected;
  else {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker)) {
      assert.ok(Date.now() < deadline, "parent did not disconnect");
    }
  }
  const synchronous = [];
  const error = await new Promise(resolve => {
    const returned = process.send({ synthetic: true }, handle, error => {
      assert.deepEqual(synchronous, ["returned"]);
      order.push("callback");
      resolve(error);
    });
    assert.equal(returned, mode !== "closed");
    synchronous.push("returned");
  });
  handle?.close();
  if (mode === "handle") assert.equal(error, null);
  else {
    assert.equal(error.code, mode === "closed" ? "ERR_IPC_CHANNEL_CLOSED" : "EPIPE");
    assert.equal(error.message, mode === "closed" ? "Channel closed" : "write EPIPE");
    assert.equal(error.name, "Error");
  }
  if (mode === "early") {
    if (error) assert.equal(error.syscall, "write");
    await disconnected;
  }
  if (mode !== "handle") {
    assert.deepEqual(order, mode === "closed" ? ["disconnect", "callback"] : ["callback", "disconnect"]);
  }
} else {
  fs.rmSync(marker, { force: true });
  const child = fork(fileURLToPath(import.meta.url), [directory, mode, "child"], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const output = [];
  const errors = [];
  child.stdout.on("data", data => output.push(data));
  child.stderr.on("data", data => errors.push(data));
  const exited = once(child, "exit");
  const stdoutEnded = once(child.stdout, "end");
  const stderrEnded = once(child.stderr, "end");
  assert.deepEqual(await once(child, "message"), [{ oracleReady: true }, undefined]);
  const disconnected = once(child, "disconnect");
  child.disconnect();
  await disconnected;
  fs.writeFileSync(marker, "closed");
  const [[code, signal]] = await Promise.all([exited, stdoutEnded, stderrEnded]);
  assert.deepEqual(
    { code, signal, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() },
    {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    },
  );
  console.log(`${mode} send oracle passed`);
}
