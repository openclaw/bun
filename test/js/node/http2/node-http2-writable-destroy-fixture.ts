// Drives the H2FrameParser writable path into a session.destroy() from inside
// a write callback. Without a keepalive spanning on_native_writable's flush
// loop, the parser is freed mid-loop and the next has_backpressure() reads a
// poisoned HiveArray slot (ASAN use-after-poison).
//
// Sequence:
//   1. A large DATA write goes out via the vectored batch path; send/writev
//      is faulted to 0 so the tail lands in write_buffer (has_backpressure
//      becomes true and usockets arms WRITABLE).
//   2. The Writable callback for (1) fires via nextTick; the next buffered
//      chunk reaches send_data with has_backpressure() true and is queued in
//      data_frame_queue with its callback.
//   3. fault.clear() runs (also via nextTick, after (2)); the next I/O poll
//      delivers the writable event and on_native_writable drains write_buffer
//      then flush_stream_queue, which invokes the queued callback
//      synchronously inside the flush loop.
//   4. Callback destroys the session and forces a full GC so the JS
//      wrapper's +1 is released while flush()'s own keepalive is still on
//      the stack; when flush() returns, that keepalive is the last ref.

import { socketFaultInjection as fault } from "bun:internal-for-testing";
import { tls as certs } from "harness";
import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

if (!fault.available()) {
  console.log("ok");
  process.exit(0);
}

const secure = process.argv.includes("--tls");
const server = secure
  ? http2.createSecureServer({ ...certs, settings: { initialWindowSize: 1024 * 1024 } })
  : http2.createServer();
if (secure) server.on("session", session => session.setLocalWindowSize(1024 * 1024));
server.on("stream", (stream: http2.ServerHttp2Stream) => {
  stream.respond({ ":status": 200 });
  stream.resume();
  stream.on("end", () => stream.end());
  stream.on("error", () => {});
});
server.on("sessionError", () => {});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const client = http2.connect(`${secure ? "https" : "http"}://127.0.0.1:${port}`, { rejectUnauthorized: false });
client.on("error", () => {});
await once(client, "connect");
if (secure) {
  // The ping ACK follows the server's SETTINGS/WINDOW_UPDATE on the same stream.
  await new Promise<void>((resolve, reject) => client.ping(error => (error ? reject(error) : resolve())));
  assert(client.state.remoteWindowSize! >= 1024 * 1024);
}

const req = client.request({ ":path": "/", ":method": "POST" });
req.on("error", () => {});
req.on("close", () => {});
// Flush HEADERS now so the fault hits only the DATA batch.
await new Promise<void>(r => setImmediate(r));

// Force 0-byte sends on every outbound path the DATA batch can reach.
fault.set({ syscall: "writev", action: "zero", repeat: -1 });
fault.set({ syscall: "send", action: "zero", repeat: -1 });

const { promise: destroyed, resolve } = Promise.withResolvers<void>();

// (1) Large payload: multi-frame batch path → flush_batch_vectored → writev
// returns 0, unwritten tail lands in write_buffer. Its Writable callback is
// deferred via nextTick (direct path).
let firstCallback = false;
let secondCallback = false;
let faultCleared = false;
// TLS flushes ciphertext batches at 128 KiB. With larger admitted H2 windows,
// this write spills before consuming all plaintext and leaves H2 backpressure.
req.write(
  Buffer.alloc(secure ? 400 * 1024 : 40000, "a"),
  secure
    ? () => {
        firstCallback = true;
      }
    : undefined,
);

// (2) Buffered in the Writable until (1)'s callback runs; when _write runs
// has_backpressure() is true so send_data queues this frame with destroyCb.
req.write(Buffer.alloc(64, "b"), function destroyCb() {
  if (secure) {
    assert(faultCleared);
    assert(!secondCallback);
    secondCallback = true;
  }
  try {
    client.destroy();
  } catch {}
  Bun.gc(true);
  resolve();
});

// (3) Queued after (1)'s deferred callback: by the time this runs the second
// chunk is in data_frame_queue; clear the fault so the writable event drains.
process.nextTick(() =>
  process.nextTick(() => {
    if (secure) {
      assert(firstCallback);
      assert(!secondCallback);
      assert.equal(req.writableLength, 64);
    }
    faultCleared = true;
    fault.clear();
  }),
);

await destroyed;
await new Promise<void>(r => setImmediate(r));

server.close();
console.log("ok");
process.exit(0);
