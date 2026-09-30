import { expect, test } from "bun:test";
import { once } from "events";
import { bunEnv, bunExe, tls as certs } from "harness";
import net from "net";
import tls from "tls";

test("should be able to upgrade a paused socket and also have backpressure on it #15438", async () => {
  // enought to trigger backpressure
  const payload = Buffer.alloc(16 * 1024 * 4, "b").toString("utf8");

  const server = tls.createServer(certs, socket => {
    // echo
    socket.on("data", data => {
      socket.write(data);
    });
  });

  await once(server.listen(0, "127.0.0.1"), "listening");

  const socket = net.connect({
    port: (server.address() as net.AddressInfo).port,
    host: "127.0.0.1",
  });
  await once(socket, "connect");

  // pause raw socket
  socket.pause();

  const tlsSocket = tls.connect({
    ca: certs.cert,
    servername: "localhost",
    socket,
  });
  await once(tlsSocket, "secureConnect");

  // do http request using tls socket
  async function doWrite(socket: net.Socket) {
    let downloadedBody = 0;
    const { promise, resolve, reject } = Promise.withResolvers();
    function onData(data: Buffer) {
      downloadedBody += data.byteLength;
      if (downloadedBody === payload.length * 2) {
        resolve();
      }
    }
    socket.pause();
    socket.write(payload);
    socket.write(payload, () => {
      socket.on("data", onData);
      socket.resume();
    });

    await promise;
    socket.off("data", onData);
  }
  for (let i = 0; i < 100; i++) {
    // upgrade the tlsSocket
    await doWrite(tlsSocket);
  }

  expect().pass();
});

// https://github.com/nodejs/node/blob/v26.3.0/lib/internal/tls/wrap.js#L723-L727
test.each([
  ["readable: false", () => ({ readable: false })],
  [
    "an onread buffer",
    (saw: string[]) => ({ onread: { buffer: Buffer.alloc(64), callback: (n: number) => saw.push(`onread ${n}`) } }),
  ],
  ["no reader", () => ({})],
])(
  "tls.connect({ socket }) over a net.Socket with %s keeps the TLS bytes off the wrapped socket",
  async (_, options) => {
    const server = tls.createServer(certs, socket => {
      socket.on("error", () => {});
      socket.write("banner");
      socket.on("data", data => socket.write("echo:" + data));
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    try {
      const saw: string[] = [];
      const raw = net.connect({
        port: (server.address() as net.AddressInfo).port,
        host: "127.0.0.1",
        ...options(saw),
      });
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      raw.on("error", reject);
      await once(raw, "connect");
      const tlsSocket = tls.connect({ socket: raw, ca: certs.cert, servername: "localhost" });
      const closed = once(tlsSocket, "close");
      let got = "";
      tlsSocket.on("error", reject);
      tlsSocket.on("close", () => reject(new Error(`closed after ${JSON.stringify(got)}`)));
      tlsSocket.on("secureConnect", () => tlsSocket.write("hi"));
      tlsSocket.on("data", data => {
        got += data;
        if (got.endsWith("echo:hi")) resolve(got);
      });
      expect(await promise).toBe("bannerecho:hi");
      expect(saw).toEqual([]);
      expect(raw.readableLength).toBe(0);
      tlsSocket.destroy();
      await closed;
    } finally {
      server.close();
    }
  },
);

// Both peers keep their plaintext 'data' listener across the upgrade.
test("a STARTTLS exchange hands no TLS bytes to the 'data' listeners of the wrapped sockets (#32239)", async () => {
  const saw: string[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server = net.createServer(socket => {
    socket.on("error", reject);
    let wrapped = false;
    socket.on("data", data => {
      if (wrapped) return void saw.push(`server data ${data.length}`);
      wrapped = true;
      socket.write("GO", () => {
        const tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(certs) });
        tlsSocket.on("error", reject);
        tlsSocket.on("data", data => tlsSocket.write("echo:" + data));
      });
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  try {
    const raw = net.connect({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1" });
    raw.on("error", reject);
    let tlsSocket: tls.TLSSocket | undefined;
    raw.on("data", data => {
      if (tlsSocket) return void saw.push(`client data ${data.length}`);
      tlsSocket = tls.connect({ socket: raw, ca: certs.cert, servername: "localhost" });
      tlsSocket.on("error", reject);
      tlsSocket.on("secureConnect", () => tlsSocket!.write("hi"));
      tlsSocket.on("data", data => resolve(String(data)));
    });
    raw.write("STARTTLS");
    expect(await promise).toBe("echo:hi");
    expect(saw).toEqual([]);
    const closed = once(tlsSocket!, "close");
    tlsSocket!.destroy();
    await closed;
  } finally {
    server.close();
  }
});

test.each(["duplex", "buffered duplex", "CONNECT", "CONNECT pending acknowledgement"])(
  "TLS takes ownership of a paused %s transport",
  async kind => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", `(${pausedTransport.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(certs)})`],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "secure exchange; no reads before adoption\n",
      stderr: "",
      exitCode: 0,
    });
  },
);

// Run the same transport exchange in an isolated process, including under Node.
async function pausedTransport(kind, certs) {
  const assert = require("node:assert/strict");
  const { once } = require("node:events");
  const http = require("node:http");
  const net = require("node:net");
  const { Duplex } = require("node:stream");
  const tls = require("node:tls");
  const sockets: any[] = [];
  const servers: any[] = [];
  const { promise, resolve, reject } = Promise.withResolvers();
  const deadline = setTimeout(() => reject(new Error("paused transport did not complete TLS")), 3000);
  function track(socket) {
    sockets.push(socket);
    socket.on("error", reject);
    return socket;
  }
  function receive(socket) {
    track(socket);
    let message = "";
    socket.on("data", chunk => {
      message += chunk;
      if (message === "hello") socket.end("reply");
    });
  }
  function send(socket) {
    track(socket);
    let reply = "";
    socket.on("secureConnect", () => socket.write("hello"));
    socket.on("data", chunk => {
      reply += chunk;
    });
    socket.on("end", () => {
      try {
        assert.equal(reply, "reply");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on("close", () => reject(new Error("TLS closed before the exchange finished")));
  }
  try {
    if (kind.includes("duplex")) {
      const firstWrite = Promise.withResolvers();
      const makeSide = peer =>
        track(
          new Duplex({
            read() {},
            write(chunk, encoding, callback) {
              peer().push(chunk);
              firstWrite.resolve();
              callback();
            },
            final(callback) {
              peer().push(null);
              callback();
            },
          }),
        );
      const clientSide = makeSide(() => serverSide);
      const serverSide = makeSide(() => clientSide);
      clientSide.pause();
      serverSide.pause();
      let adopted = false;
      let earlyData = 0;
      serverSide.on("data", () => {
        if (!adopted) earlyData++;
      });
      const buffered = kind === "buffered duplex";
      send(tls.connect({ socket: clientSide, rejectUnauthorized: false }));
      if (buffered) {
        await Promise.race([firstWrite.promise, promise]);
        assert.ok(serverSide.readableLength > 0);
      }
      assert.equal(earlyData, 0);
      assert.equal(serverSide.isPaused(), true);
      adopted = true;
      receive(new tls.TLSSocket(serverSide, { isServer: true, secureContext: tls.createSecureContext(certs) }));
    } else {
      const target = tls.createServer(certs, receive);
      target.on("tlsClientError", reject);
      servers.push(target);
      const proxy = http.createServer();
      servers.push(proxy);
      proxy.on("connection", track);
      proxy.on("connect", (request, socket, head) => {
        socket.pause();
        assert.equal(head.length, 0);
        let adopted = false;
        socket.on("data", () => {
          if (!adopted) reject(new Error("read before TLS adoption"));
        });
        const adopt = () => {
          assert.equal(socket.isPaused(), true);
          adopted = true;
          target.emit("connection", socket);
        };
        if (kind.endsWith("pending acknowledgement")) {
          socket.cork();
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          adopt();
          socket.uncork();
        } else {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", adopt);
        }
      });
      await once(proxy.listen(0, "127.0.0.1"), "listening");
      const raw = track(net.connect(proxy.address().port, "127.0.0.1"));
      await once(raw, "connect");
      raw.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
      let header = "";
      await new Promise<void>((resolve, reject) => {
        function data(chunk) {
          header += chunk;
          if (header.endsWith("\r\n\r\n")) {
            raw.off("data", data);
            resolve();
          }
        }
        raw.on("data", data);
        raw.once("error", reject);
      });
      assert.equal(header, "HTTP/1.1 200 Connection Established\r\n\r\n");
      raw.pause();
      send(tls.connect({ socket: raw, rejectUnauthorized: false }));
    }
    await promise;
    console.log("secure exchange; no reads before adoption");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
  }
}
