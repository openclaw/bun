/**
 * All tests in this file should also run in Node.js 26+.
 * The Upgrade-body case follows Node 26 semantics.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Agent, createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { connect as connectSecure } from "node:tls";

it("req.socket emits 'pause' once an unread request body fills the IncomingMessage buffer", async () => {
  // Node's test-http-no-read-no-dump: a handler that never reads the body sees
  // 'pause' on req.connection once the IncomingMessage push() backpressures.
  const { promise: paused, resolve: onPause, reject } = Promise.withResolvers<number>();
  const server = createServer((req, res) => {
    req.connection!.on("pause", () => {
      onPause((req as any).readableLength);
      res.end("ok");
    });
    res.writeHead(200);
    res.flushHeaders();
  });
  try {
    await once(server.listen(0), "listening");
    const port = (server.address() as AddressInfo).port;
    const post = request({ method: "POST", port });
    post.on("error", reject);
    post.flushHeaders();
    // One body chunk at the default highWaterMark: the first parserOnBody push
    // returns false and Node's readStop pauses the socket.
    post.write(Buffer.alloc(64 * 1024, "X"));
    const buffered = await paused;
    assert.ok(buffered > 0);
    post.destroy();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

it("body reading from 'pause' still delivers every byte and 'end'", async () => {
  // A handler that keys its slow-reader flow off the socket's 'pause' event
  // (the pattern from Node's test-http-no-read-no-dump) must still be able to
  // drain the full body once it attaches a 'data' listener.
  const { promise: done, resolve, reject } = Promise.withResolvers<{ pauses: number; received: number }>();
  const server = createServer((req, res) => {
    let pauses = 0;
    let received = 0;
    req.connection!.on("pause", () => {
      pauses++;
      if (pauses > 1) return;
      req.on("data", chunk => (received += chunk.length));
      req.on("end", () => {
        res.end("ok");
        resolve({ pauses, received });
      });
    });
    res.writeHead(200);
    res.flushHeaders();
  });
  try {
    await once(server.listen(0), "listening");
    const port = (server.address() as AddressInfo).port;
    const payload = 256 * 1024;
    const post = request({ method: "POST", port });
    post.on("error", reject);
    post.flushHeaders();
    await once(post, "response");
    post.end(Buffer.alloc(payload, "X"));
    const { pauses, received } = await done;
    assert.equal(received, payload);
    assert.ok(pauses >= 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

it("req.socket emits 'pause' on every body-bearing keep-alive request, not just the first", async () => {
  const pauses: string[] = [];
  const sockets: unknown[] = [];
  const ended = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    sockets.push(req.socket);
    req.connection!.once("pause", () => {
      pauses.push(req.url!);
      res.end("ok");
      if (req.url === "/b") ended.resolve();
    });
    res.writeHead(200);
    res.flushHeaders();
  });
  try {
    await once(server.listen(0), "listening");
    const port = (server.address() as AddressInfo).port;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    for (const path of ["/a", "/b"]) {
      await new Promise<void>((resolve, reject) => {
        const post = request({ method: "POST", port, path, agent }, res => {
          res.resume();
          res.on("end", resolve);
        });
        post.on("error", reject);
        post.end(Buffer.alloc(128 * 1024, "X"));
      });
    }
    await ended.promise;
    agent.destroy();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0], sockets[1]);
    assert.deepEqual(pauses, ["/a", "/b"]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// A chunked body whose first chunk alone overflows a 1 KiB highWaterMark: the
// first push() pauses the connection while the parser is still inside this
// segment, so the chunk after it and the terminating chunk are received while
// the request is paused. The whole request is written at once so that it is
// parsed in one go.
const BODY_HEAD = Buffer.alloc(2048, "x").toString();
const BODY_TAIL = "tail";
function chunkedPost(path: string, extraHeaders = "", trailers = "") {
  return (
    `POST ${path} HTTP/1.1\r\nHost: a\r\n${extraHeaders}Transfer-Encoding: chunked\r\n\r\n` +
    `${BODY_HEAD.length.toString(16)}\r\n${BODY_HEAD}\r\n` +
    `${BODY_TAIL.length.toString(16)}\r\n${BODY_TAIL}\r\n` +
    `0\r\n${trailers}\r\n`
  );
}

async function connectTo(server: Server | SecureServer, secure = false) {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const port = (server.address() as AddressInfo).port;
  const socket = secure
    ? connectSecure({ port, host: "127.0.0.1", rejectUnauthorized: false })
    : connect(port, "127.0.0.1");
  socket.setNoDelay(true);
  const connected = Promise.withResolvers<void>();
  socket.once(secure ? "secureConnect" : "connect", connected.resolve);
  let received = "";
  let failure: Error | undefined;
  const waiting: Array<{ marker: string; resolve: () => void; reject: (error: Error) => void }> = [];
  const fail = (error: Error) => {
    failure ??= error;
    connected.reject(error);
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };
  socket.on("error", fail);
  socket.on("end", () => fail(new Error("Connection ended before the expected response")));
  socket.on("close", () => fail(new Error("Connection closed before the expected response")));
  socket.on("data", chunk => {
    received += chunk;
    for (let i = 0; i < waiting.length; ) {
      if (received.includes(waiting[i].marker)) waiting.splice(i, 1)[0].resolve();
      else i++;
    }
  });
  try {
    await connected.promise;
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return {
    socket,
    get received() {
      return received;
    },
    /** Resolves once the response bytes received so far contain `marker`. */
    receive(marker: string) {
      if (received.includes(marker)) return Promise.resolve();
      if (failure) return Promise.reject(failure);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      waiting.push({ marker, resolve, reject });
      return promise;
    },
  };
}

async function disconnectAndClose(socket: Socket, server: Server | SecureServer) {
  const disconnected = once(socket, "close");
  socket.destroy();
  await disconnected;
  // The server's 'close' event waits for every request the server still
  // counts as in flight, so a request that is never released keeps it from
  // ever firing.
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function cleanup(server: Server | SecureServer, socket?: Socket) {
  socket?.destroy();
  server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}

describe("request whose whole body arrived while it was paused, answered later on a keep-alive connection", () => {
  // In each test the connection goes on to serve a second request before it is
  // closed, so closing it does not tear down the first request as a side
  // effect: the first request has to be released by its own response ending.
  it("is released once the response ends even though the body is never read", async () => {
    const paused: string[] = [];
    const server = createServer({ highWaterMark: 1024 }, (req, res) => {
      req.socket.once("pause", () => paused.push(req.url!));
      if (req.url === "/unread") {
        // Respond once the segment that carried this request has been parsed
        // to the end of its body (setImmediate runs after the read callback
        // that dispatched it), without ever reading the body.
        setImmediate(() => res.end("alpha"));
      } else {
        res.end("bravo");
      }
    });
    try {
      const client = await connectTo(server);
      client.socket.write(chunkedPost("/unread"));
      await client.receive("alpha");
      client.socket.write("GET /next HTTP/1.1\r\nHost: a\r\n\r\n");
      await client.receive("bravo");
      assert.deepEqual(paused, ["/unread"]);
      await disconnectAndClose(client.socket, server);
    } finally {
      server.closeAllConnections();
      if (server.listening) server.close();
    }
  });

  it("still hands the rest of the body to a reader that starts reading as the response ends", async () => {
    const paused: string[] = [];
    const { promise: body, resolve: gotBody } = Promise.withResolvers<string>();
    const server = createServer({ highWaterMark: 1024 }, (req, res) => {
      req.socket.once("pause", () => paused.push(req.url!));
      if (req.url !== "/read") {
        res.end("bravo");
        return;
      }
      let received = "";
      req.on("end", () => gotBody(received));
      setImmediate(() => {
        // The whole body has been received by now, but only its first chunk
        // fit into the request's buffer. Reading starts on the next tick, so
        // the response ends before the rest of the body has been handed over.
        req.on("data", chunk => (received += chunk));
        res.end("alpha");
      });
    });
    try {
      const client = await connectTo(server);
      client.socket.write(chunkedPost("/read"));
      await client.receive("alpha");
      assert.equal(await body, BODY_HEAD + BODY_TAIL);
      client.socket.write("GET /next HTTP/1.1\r\nHost: a\r\n\r\n");
      await client.receive("bravo");
      assert.deepEqual(paused, ["/read"]);
      await disconnectAndClose(client.socket, server);
    } finally {
      server.closeAllConnections();
      if (server.listening) server.close();
    }
  });

  it("is released once the response ends when the next request was pipelined behind it", async () => {
    const paused: string[] = [];
    const { promise: pipelinedBody, resolve: gotPipelinedBody } = Promise.withResolvers<string>();
    const server = createServer({ highWaterMark: 1024 }, (req, res) => {
      req.socket.once("pause", () => paused.push(req.url!));
      if (req.url === "/unread") {
        setImmediate(() => res.end("alpha"));
        return;
      }
      let received = "";
      req.on("data", chunk => (received += chunk));
      req.on("end", () => {
        gotPipelinedBody(received);
        res.end("bravo");
      });
    });
    try {
      const client = await connectTo(server);
      // The second request (and its body) is in the same segment as the first
      // one, so it is dispatched, and its response queued, while the first
      // response is still pending.
      client.socket.write(
        chunkedPost("/unread") + "POST /pipelined HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\r\nabc",
      );
      await client.receive("alpha");
      await client.receive("bravo");
      assert.equal(await pipelinedBody, "abc");
      assert.deepEqual(paused, ["/unread"]);
      await disconnectAndClose(client.socket, server);
    } finally {
      server.closeAllConnections();
      if (server.listening) server.close();
    }
  });

  it("lets a manual reader consume the body after pipelined output drains", async () => {
    let incoming: IncomingMessage | undefined;
    let firstResponse: ServerResponse | undefined;
    let peerClosed: Promise<void> | undefined;
    let received = "";
    let ends = 0;
    let queuedWrite: boolean | undefined;
    let queuedDetached = false;
    let gatePaused = false;
    const queuedBody = "q".repeat(4096);
    const readable = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<never>();
    const errors: Error[] = [];
    const server = createServer({ highWaterMark: 1024 }, (req, res) => {
      req.on("error", error => {
        errors.push(error);
        failed.reject(error);
      });
      if (req.url === "/queued") {
        res.setHeader("Content-Length", queuedBody.length);
        queuedWrite = res.write(queuedBody);
        queuedDetached = res.socket === null;
        res.end();
        return;
      }
      if (req.url === "/gate") {
        gatePaused = (req.socket as Socket & { _paused: boolean })._paused;
        res.setHeader("Content-Length", 7);
        res.end("charlie");
        gate.resolve();
        return;
      }
      if (req.url === "/next") {
        res.setHeader("Content-Length", 5);
        res.end("bravo");
        return;
      }
      incoming = req;
      firstResponse = res;
      peerClosed = new Promise<void>(resolve => req.socket.once("close", () => resolve()));
      req.on("end", () => {
        ends++;
        ended.resolve();
      });
      req.once("readable", readable.resolve);
      req.read(0);
      res.once("finish", finished.resolve);
    });
    let socket: Socket | undefined;
    let clientClosed: Promise<void> | undefined;
    try {
      const client = await connectTo(server);
      socket = client.socket;
      clientClosed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
      const disconnected = clientClosed.then(() => {
        throw new Error("Connection closed before the manual reader finished");
      });
      const wait = <T>(pending: Promise<T>) => Promise.race([pending, failed.promise, disconnected]);
      socket.write(
        chunkedPost("/read", "Trailer: X-Body-Finished\r\n", "X-Body-Finished: yes\r\n") +
          "GET /queued HTTP/1.1\r\nHost: a\r\n\r\n" +
          "GET /gate HTTP/1.1\r\nHost: a\r\n\r\n",
      );
      await wait(Promise.all([readable.promise, gate.promise]));
      assert.ok(incoming);
      assert.ok(firstResponse);
      assert.equal(queuedWrite, false);
      assert.equal(queuedDetached, true);
      assert.equal(gatePaused, true);
      firstResponse.setHeader("Content-Length", 5);
      firstResponse.end("alpha");
      await wait(
        Promise.all([
          client.receive("\r\n\r\nalpha"),
          client.receive(`\r\n\r\n${queuedBody}`),
          client.receive("\r\n\r\ncharlie"),
          finished.promise,
        ]),
      );
      assert.equal(ends, 0);
      assert.equal((incoming.socket as Socket & { _paused: boolean })._paused, false);
      const positions = ["alpha", queuedBody, "charlie"].map(body => client.received.indexOf(`\r\n\r\n${body}`));
      assert.ok(positions[0] >= 0 && positions[0] < positions[1] && positions[1] < positions[2]);
      const readAvailable = () => {
        let chunk: Buffer | null;
        while ((chunk = incoming!.read()) !== null) received += chunk;
      };
      incoming.on("readable", readAvailable);
      readAvailable();
      await wait(ended.promise);
      assert.equal(received, BODY_HEAD + BODY_TAIL);
      assert.equal(ends, 1);
      assert.equal(incoming.complete, true);
      assert.deepEqual(incoming.trailers, { "x-body-finished": "yes" });
      socket.write("GET /next HTTP/1.1\r\nHost: a\r\n\r\n");
      await client.receive("\r\n\r\nbravo");
      await disconnectAndClose(socket, server);
      assert.deepEqual(errors, []);
    } finally {
      await cleanup(server, socket);
      await Promise.all([clientClosed, peerClosed]);
    }
  });

  it("keeps the terminal body readable after the response and socket close", async () => {
    let incoming: IncomingMessage | undefined;
    let received = "";
    let ends = 0;
    let peerClosed: Promise<void> | undefined;
    const ended = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const server = createServer({ highWaterMark: 1024 }, (req, res) => {
      incoming = req;
      peerClosed = new Promise<void>(resolve => req.socket.once("close", () => resolve()));
      req.on("error", error => errors.push(error));
      req.on("data", chunk => {
        received += chunk;
        if (received.length === BODY_HEAD.length) req.pause();
      });
      req.on("end", () => {
        ends++;
        ended.resolve();
      });
      setImmediate(() => {
        res.setHeader("Content-Length", 5);
        res.end("alpha");
      });
    });
    let socket: Socket | undefined;
    let clientClosed: Promise<void> | undefined;
    try {
      const client = await connectTo(server);
      socket = client.socket;
      clientClosed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
      socket.write(chunkedPost("/read"));
      await client.receive("\r\n\r\nalpha");
      assert.ok(incoming);
      assert.equal(received, BODY_HEAD);
      assert.equal(ends, 0);
      assert.equal(incoming.complete, true);

      socket.end();
      await Promise.all([clientClosed, peerClosed]);
      incoming.resume();
      await ended.promise;
      assert.equal(received, BODY_HEAD + BODY_TAIL);
      assert.equal(ends, 1);
      assert.equal(incoming.readableEnded, true);
      assert.deepEqual(errors, []);
    } finally {
      await cleanup(server, socket);
      await Promise.all([clientClosed, peerClosed]);
    }
  });
});

it("upgrade request whose whole body arrived while it was paused still hands the whole body to a reader attached later", async () => {
  const { promise: body, resolve: gotBody } = Promise.withResolvers<string>();
  const server = createServer({ highWaterMark: 1024 });
  server.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n");
    let received = "";
    req.on("end", () => {
      gotBody(received);
      socket.destroy();
    });
    // As above: the whole body has been received by the time this runs, but
    // only its first chunk fit into the request's buffer.
    setImmediate(() => req.on("data", chunk => (received += chunk)));
  });
  try {
    const client = await connectTo(server);
    client.socket.write(chunkedPost("/upgrade", "Upgrade: test\r\nConnection: Upgrade\r\n"));
    await client.receive("101 Switching Protocols");
    assert.equal(await body, BODY_HEAD + BODY_TAIL);
    await once(client.socket, "close");
    server.close();
    await once(server, "close");
  } finally {
    server.closeAllConnections();
    if (server.listening) server.close();
  }
});

const keys = join(import.meta.dirname, "..", "test", "fixtures", "keys");
const tlsOptions = {
  key: readFileSync(join(keys, "agent1-key.pem")),
  cert: readFileSync(join(keys, "agent1-cert.pem")),
};

describe("response ends before the request body arrives", () => {
  for (const [secure, chunked, reader, splitResponse] of [
    [false, false, "flowing", false],
    [true, true, "flowing", true],
    [false, true, "paused", false],
    [true, false, "paused", true],
    [false, false, "unread", true],
    [true, true, "unread", false],
  ] as const) {
    const pauseBeforeResponse = reader === "paused" && chunked;
    const mode = reader === "paused" ? `paused ${pauseBeforeResponse ? "before" : "after"} response` : reader;
    it(`${secure ? "HTTPS" : "HTTP"} ${chunked ? "chunked" : "Content-Length"} ${mode} upload survives the response`, async () => {
      // HTTPS keeps Node's 64 KiB socket buffer despite the HTTP option below.
      const prefix = reader === "unread" ? Buffer.alloc(128 * 1024, "x").toString() : BODY_HEAD;
      let incoming: IncomingMessage | undefined;
      let received = "";
      let ends = 0;
      const errors: Error[] = [];
      const listener = (req: IncomingMessage, res: ServerResponse) => {
        if (req.url !== "/early") {
          res.setHeader("Content-Length", 5);
          res.end("bravo");
          return;
        }
        incoming = req;
        req.on("error", error => {
          errors.push(error);
          res.destroy(error);
        });
        req.on("end", () => ends++);
        const respond = () => {
          if (pauseBeforeResponse) req.pause();
          res.setHeader("Content-Length", 5);
          if (splitResponse) {
            res.write("al");
            res.end("pha");
          } else {
            res.end("alpha");
          }
          if (reader === "paused" && !pauseBeforeResponse) req.pause();
        };
        if (reader === "unread") {
          req.socket.once("pause", respond);
        } else {
          req.on("data", chunk => {
            received += chunk;
            if (received.length === prefix.length) respond();
          });
        }
      };
      const server = secure
        ? createSecureServer({ ...tlsOptions, highWaterMark: 1024 }, listener)
        : createServer({ highWaterMark: 1024 }, listener);
      let socket: Socket | undefined;
      try {
        const client = await connectTo(server, secure);
        socket = client.socket;
        const framing = chunked
          ? "Transfer-Encoding: chunked\r\nTrailer: X-Body-Finished\r\n"
          : `Content-Length: ${prefix.length + BODY_TAIL.length}\r\n`;
        // The tail and framing terminator stay on the client until every
        // response byte arrives. No client HTTP API can auto-end this upload.
        socket.write(
          `POST /early HTTP/1.1\r\nHost: a\r\n${framing}\r\n` +
            (chunked ? `${prefix.length.toString(16)}\r\n${prefix}\r\n` : prefix),
        );
        await client.receive("\r\n\r\nalpha");
        assert.ok(incoming);
        const beforeTail = {
          complete: incoming.complete,
          ended: incoming.readableEnded,
          ends,
          dumped: (incoming as IncomingMessage & { _dumped: boolean })._dumped,
        };
        assert.deepEqual(beforeTail, {
          complete: false,
          ended: false,
          ends: 0,
          dumped: reader === "unread",
        });
        if (reader === "paused") incoming.resume();
        socket.write(
          (chunked
            ? `${BODY_TAIL.length.toString(16)}\r\n${BODY_TAIL}\r\n0\r\nX-Body-Finished: yes\r\n\r\n`
            : BODY_TAIL) + "GET /next HTTP/1.1\r\nHost: a\r\n\r\n",
        );
        await client.receive("\r\n\r\nbravo");
        await disconnectAndClose(socket, server);

        assert.equal(received, reader === "unread" ? "" : prefix + BODY_TAIL);
        assert.equal(ends, 1);
        assert.equal(incoming.complete, true);
        assert.deepEqual(incoming.trailers, chunked ? { "x-body-finished": "yes" } : {});
        assert.deepEqual(errors, []);
      } finally {
        await cleanup(server, socket);
      }
    });
  }

  it("disconnecting an unfinished upload does not report a complete request", async () => {
    let incoming: IncomingMessage | undefined;
    let ends = 0;
    let received = "";
    const closed = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
      incoming = req;
      req.on("error", () => {});
      req.on("end", () => ends++);
      req.socket.once("close", closed.resolve);
      req.on("data", chunk => {
        received += chunk;
        if (received === "part") {
          res.setHeader("Content-Length", 5);
          res.end("alpha");
        }
      });
    });
    let socket: Socket | undefined;
    try {
      const client = await connectTo(server);
      socket = client.socket;
      socket.write("POST /early HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n4\r\npart\r\n");
      await client.receive("\r\n\r\nalpha");
      await disconnectAndClose(socket, server);
      await closed.promise;
      assert.ok(incoming);
      incoming.resume();
      await new Promise<void>(resolve => setImmediate(resolve));

      assert.equal(received, "part");
      assert.equal(incoming.complete, false);
      assert.equal(incoming.readableEnded, false);
      assert.equal(ends, 0);
    } finally {
      await cleanup(server, socket);
    }
  });

  it("destroying an unfinished request inside data returns without a false end", async () => {
    let incoming: IncomingMessage | undefined;
    let received = "";
    let ends = 0;
    let requestClosed: Promise<void> | undefined;
    let peerClosed: Promise<void> | undefined;
    const callbackReturned = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
      incoming = req;
      requestClosed = new Promise<void>(resolve => req.once("close", () => resolve()));
      peerClosed = new Promise<void>(resolve => req.socket.once("close", () => resolve()));
      req.on("error", () => {});
      req.on("end", () => ends++);
      req.on("data", chunk => {
        received += chunk;
        res.end("alpha");
        req.destroy();
        callbackReturned.resolve();
      });
    });
    let socket: Socket | undefined;
    let clientClosed: Promise<void> | undefined;
    try {
      const client = await connectTo(server);
      socket = client.socket;
      clientClosed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
      socket.write("POST /early HTTP/1.1\r\nHost: a\r\nContent-Length: 8\r\n\r\npart");
      await Promise.race([
        callbackReturned.promise,
        clientClosed.then(() => {
          throw new Error("Connection closed before the data callback returned");
        }),
      ]);
      await Promise.all([requestClosed, peerClosed, clientClosed]);
      assert.ok(incoming);
      assert.equal(received, "part");
      assert.equal(incoming.complete, false);
      assert.equal(incoming.readableEnded, false);
      assert.equal(incoming.destroyed, true);
      assert.equal(ends, 0);
    } finally {
      await cleanup(server, socket);
      await Promise.all([requestClosed, peerClosed, clientClosed]);
    }
  });

  for (const chunked of [false, true]) {
    it(`closeIdleConnections preserves an unfinished ${chunked ? "chunked" : "Content-Length"} upload`, async () => {
      let incoming: IncomingMessage | undefined;
      let peer: Socket | undefined;
      let peerClosed: Promise<void> | undefined;
      let received = "";
      let ends = 0;
      const ended = Promise.withResolvers<void>();
      const errors: Error[] = [];
      const server = createServer({ keepAliveTimeout: 0 }, (req, res) => {
        incoming = req;
        peer = req.socket;
        peerClosed = new Promise<void>(resolve => req.socket.once("close", () => resolve()));
        req.on("error", error => {
          errors.push(error);
          res.destroy(error);
        });
        req.on("end", () => {
          ends++;
          ended.resolve();
        });
        req.on("data", chunk => {
          received += chunk;
          if (received === "part") {
            res.setHeader("Content-Length", 5);
            res.end("alpha");
          }
        });
      });
      let socket: Socket | undefined;
      let clientClosed: Promise<void> | undefined;
      try {
        const client = await connectTo(server);
        socket = client.socket;
        clientClosed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
        socket.write(
          "POST /early HTTP/1.1\r\nHost: a\r\n" +
            (chunked ? "Transfer-Encoding: chunked\r\n\r\n4\r\npart\r\n" : "Content-Length: 8\r\n\r\npart"),
        );
        await client.receive("\r\n\r\nalpha");
        assert.ok(incoming);
        assert.ok(peer);
        assert.equal(incoming.complete, false);
        assert.equal(ends, 0);
        const uploaded = Promise.race([
          ended.promise,
          clientClosed.then(() => {
            throw new Error("Idle sweep closed an unfinished upload");
          }),
        ]);

        server.closeIdleConnections();
        socket.write(chunked ? "4\r\ntail\r\n0\r\n\r\n" : "tail");
        await uploaded;
        assert.equal(received, "parttail");
        assert.equal(ends, 1);
        assert.equal(incoming.complete, true);
        assert.equal(peer.destroyed, false);
        assert.equal(socket.destroyed, false);

        // No extra request or response may reset the idle flag under test.
        server.closeIdleConnections();
        await Promise.all([clientClosed, peerClosed]);
        assert.deepEqual(errors, []);
      } finally {
        await cleanup(server, socket);
        await Promise.all([clientClosed, peerClosed]);
      }
    });
  }

  it("ending an older pipelined response preserves the next HTTPS upload's reader", async () => {
    let firstResponse: ServerResponse | undefined;
    let uploadResponse: ServerResponse | undefined;
    let incoming: IncomingMessage | undefined;
    let received = "";
    let ends = 0;
    let callbacks = 0;
    const callbackDone = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const server = createSecureServer(tlsOptions, (req, res) => {
      req.on("error", error => {
        errors.push(error);
        res.destroy(error);
      });
      res.setHeader("Content-Length", req.url === "/barrier" ? 7 : 5);
      if (req.url === "/first") {
        firstResponse = res;
      } else if (req.url === "/upload") {
        incoming = req;
        uploadResponse = res;
        req.on("end", () => ends++);
        req.on("data", chunk => {
          received += chunk;
          if (received === "part") {
            firstResponse!.end("alpha", () => {
              callbacks++;
              callbackDone.resolve();
            });
          }
        });
      } else {
        // The parser reached the next message even if a broken body callback
        // lost the upload. Finish both replies so that loss is an assertion,
        // not a test waiting forever for the missing body event.
        uploadResponse!.end("bravo");
        res.end("charlie");
      }
    });
    let socket: Socket | undefined;
    try {
      const client = await connectTo(server, true);
      socket = client.socket;
      socket.write(
        "GET /first HTTP/1.1\r\nHost: a\r\n\r\n" + "POST /upload HTTP/1.1\r\nHost: a\r\nContent-Length: 8\r\n\r\npart",
      );
      await client.receive("\r\n\r\nalpha");
      assert.equal(socket.destroyed, false);
      await Promise.race([
        callbackDone.promise,
        once(socket, "close").then(() => {
          throw new Error("Connection closed before the first response callback");
        }),
      ]);
      assert.ok(incoming);
      const beforeTail = { complete: incoming.complete, ends, callbacks };
      assert.deepEqual(beforeTail, { complete: false, ends: 0, callbacks: 1 });
      socket.write("restGET /barrier HTTP/1.1\r\nHost: a\r\n\r\n");
      await client.receive("\r\n\r\ncharlie");
      await disconnectAndClose(socket, server);

      assert.equal(received, "partrest");
      assert.equal(ends, 1);
      assert.equal(callbacks, 1);
      assert.equal(incoming.complete, true);
      assert.deepEqual(errors, []);
      const positions = ["alpha", "bravo", "charlie"].map(body => client.received.indexOf(`\r\n\r\n${body}`));
      assert.ok(positions[0] >= 0 && positions[0] < positions[1] && positions[1] < positions[2]);
    } finally {
      await cleanup(server, socket);
    }
  });
});
