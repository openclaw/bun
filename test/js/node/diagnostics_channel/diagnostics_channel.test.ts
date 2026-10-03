import { gc } from "bun";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel, Channel, hasSubscribers, subscribe, unsubscribe } from "node:diagnostics_channel";

describe("Channel", () => {
  // test-diagnostics-channel-has-subscribers.js
  test("can have subscribers", () => {
    const name = "channel1";
    const dc = channel(name);
    expect(hasSubscribers(name)).toBeFalse();

    dc.subscribe(() => {});
    expect(hasSubscribers(name)).toBeTrue();

    checkCalls();
  });

  // test-diagnostics-channel-symbol-named.js
  test("can have symbol as name", () => {
    const input = {
      foo: "bar",
    };

    const symbol = Symbol("channel2");

    // Individual channel objects can be created to avoid future lookups
    const dc = channel(symbol);

    // Expect two successful publishes later
    dc.subscribe(
      mustCall((message, name) => {
        expect(name).toBe(symbol);
        expect(message).toStrictEqual(input);
      }),
    );

    dc.publish(input);

    expect(() => {
      // @ts-expect-error
      channel(null);
    }).toThrow(/"channel" argument must be of type string or symbol/);

    checkCalls();
  });

  // test-diagnostics-channel-sync-unsubscribe.js
  test("does not throw when unsubscribed", () => {
    const name = "channel3";
    const data = "some message";

    const onMessageHandler: any = mustCall(() => unsubscribe(name, onMessageHandler));

    subscribe(name, onMessageHandler);

    // This must not throw.
    channel(name).publish(data);

    checkCalls();
  });

  test("self-unsubscribe preserves the current publication's subscribers", () => {
    const name = Symbol("self-unsubscribe");
    const dc = channel(name);
    const calls: string[] = [];
    const first = (message: unknown) => {
      calls.push(`first:${message}`);
      unsubscribe(name, first);
    };
    const second = (message: unknown) => calls.push(`second:${message}`);
    subscribe(name, first);
    subscribe(name, second);

    try {
      dc.publish("current");
      expect(calls).toEqual(["first:current", "second:current"]);
      dc.publish("next");
      expect(calls).toEqual(["first:current", "second:current", "second:next"]);
    } finally {
      unsubscribe(name, first);
      unsubscribe(name, second);
    }
  });

  test("unsubscribing a later subscriber takes effect on the next publication", () => {
    const dc = channel(Symbol("unsubscribe-later"));
    const calls: string[] = [];
    const second = (message: unknown) => calls.push(`second:${message}`);
    const first = (message: unknown) => {
      calls.push(`first:${message}`);
      dc.unsubscribe(second);
    };
    dc.subscribe(first);
    dc.subscribe(second);

    try {
      dc.publish("current");
      expect(calls).toEqual(["first:current", "second:current"]);
      dc.publish("next");
      expect(calls).toEqual(["first:current", "second:current", "first:next"]);
    } finally {
      dc.unsubscribe(first);
      dc.unsubscribe(second);
    }
  });

  test("a subscriber added during publication starts with the next publication", () => {
    const dc = channel(Symbol("subscribe-during-publish"));
    const calls: string[] = [];
    const third = (message: unknown) => calls.push(`third:${message}`);
    const first = (message: unknown) => {
      calls.push(`first:${message}`);
      if (message === "current") dc.subscribe(third);
    };
    const second = (message: unknown) => calls.push(`second:${message}`);
    dc.subscribe(first);
    dc.subscribe(second);

    try {
      dc.publish("current");
      expect(calls).toEqual(["first:current", "second:current"]);
      calls.length = 0;
      dc.publish("next");
      expect(calls).toEqual(["first:next", "second:next", "third:next"]);
    } finally {
      dc.unsubscribe(first);
      dc.unsubscribe(second);
      dc.unsubscribe(third);
    }
  });

  test("recursive publication sees updated subscribers without changing the outer publication", () => {
    const dc = channel(Symbol("recursive-publish"));
    const calls: string[] = [];
    const first = (message: unknown) => {
      calls.push(`first:${message}`);
      dc.unsubscribe(first);
      dc.publish("inner");
    };
    const second = (message: unknown) => {
      calls.push(`second:${message}`);
      if (message === "inner") dc.unsubscribe(second);
    };
    dc.subscribe(first);
    dc.subscribe(second);

    try {
      dc.publish("outer");
      expect(calls).toEqual(["first:outer", "second:inner", "second:outer"]);
      expect(dc.hasSubscribers).toBeFalse();
      dc.publish("next");
      expect(calls).toEqual(["first:outer", "second:inner", "second:outer"]);
    } finally {
      dc.unsubscribe(first);
      dc.unsubscribe(second);
    }
  });

  test("an in-flight subscriber can reactivate an emptied channel", () => {
    const dc = channel(Symbol("reactivate-during-publish"));
    const calls: string[] = [];
    const third = () => calls.push("third");
    const first = () => {
      calls.push("first");
      dc.unsubscribe(first);
      dc.unsubscribe(second);
    };
    const second = () => {
      calls.push("second");
      dc.subscribe(third);
    };
    dc.subscribe(first);
    dc.subscribe(second);

    try {
      dc.publish("current");
      expect(calls).toEqual(["first", "second"]);
      expect(dc.hasSubscribers).toBeTrue();
      dc.publish("next");
      expect(calls).toEqual(["first", "second", "third"]);
    } finally {
      dc.unsubscribe(first);
      dc.unsubscribe(second);
      dc.unsubscribe(third);
    }
  });

  test("runStores preserves the publication snapshot and bound context", () => {
    const dc = channel(Symbol("run-stores-snapshot"));
    const store = new AsyncLocalStorage();
    const message = { value: 42 };
    const calls: [string, unknown][] = [];
    const first = () => {
      calls.push(["first", store.getStore()]);
      dc.unsubscribe(first);
    };
    const second = () => calls.push(["second", store.getStore()]);
    dc.subscribe(first);
    dc.subscribe(second);
    dc.bindStore(store);

    try {
      dc.runStores(message, () => calls.push(["run", store.getStore()]));
      expect(calls).toEqual([
        ["first", message],
        ["second", message],
        ["run", message],
      ]);
      expect(store.getStore()).toBeUndefined();
      calls.length = 0;
      dc.runStores(message, () => calls.push(["run", store.getStore()]));
      expect(calls).toEqual([
        ["second", message],
        ["run", message],
      ]);
    } finally {
      dc.unsubscribe(first);
      dc.unsubscribe(second);
      dc.unbindStore(store);
      store.disable();
    }
  });

  // test-diagnostics-channel-pub-sub.js
  test("can publish and subscribe", () => {
    const name = "channel4";
    const input = {
      foo: "bar",
    };

    // Individual channel objects can be created to avoid future lookups
    const dc = channel(name);
    expect(dc).toBeInstanceOf(Channel);

    // No subscribers yet, should not publish
    expect(dc.hasSubscribers).toBeFalse();

    const subscriber = mustCall((message, name) => {
      expect(name).toBe(dc.name);
      expect(message).toStrictEqual(input);
    });

    // Now there's a subscriber, should publish
    subscribe(name, subscriber);
    expect(dc.hasSubscribers).toBeTrue();

    // The ActiveChannel prototype swap should not fail instanceof
    expect(dc).toBeInstanceOf(Channel);

    // Should trigger the subscriber once
    dc.publish(input);

    // Should not publish after subscriber is unsubscribed
    expect(unsubscribe(name, subscriber)).toBeTrue();
    expect(dc.hasSubscribers).toBeFalse();

    // unsubscribe() should return false when subscriber is not found
    expect(unsubscribe(name, subscriber)).toBeFalse();

    expect(() => {
      // @ts-expect-error
      subscribe(name, null);
    }).toThrow(/"subscription" argument must be of type/);

    // Reaching zero subscribers should not delete from the channels map as there
    // will be no more weakref to incRef if another subscribe happens while the
    // channel object itself exists.
    dc.subscribe(subscriber);
    dc.unsubscribe(subscriber);
    dc.subscribe(subscriber);

    checkCalls();
  });

  // test-diagnostics-channel-object-channel-pub-sub.js
  test("can publish and subscribe using object", () => {
    const name = "channel5";
    const input = {
      foo: "bar",
    };

    // Should not have named channel
    expect(hasSubscribers(name)).toBeFalse();

    // Individual channel objects can be created to avoid future lookups
    const dc = channel(name);
    expect(dc).toBeInstanceOf(Channel);
    expect(channel(name)).toBe(dc); // intentional object equality check

    // No subscribers yet, should not publish
    expect(dc.hasSubscribers).toBeFalse();

    const subscriber = mustCall((message, name) => {
      expect(name).toBe(dc.name);
      expect(message).toStrictEqual(input);
    });

    // Now there's a subscriber, should publish
    dc.subscribe(subscriber);
    expect(dc.hasSubscribers).toBeTrue();

    // The ActiveChannel prototype swap should not fail instanceof
    expect(dc).toBeInstanceOf(Channel);

    // Should trigger the subscriber once
    dc.publish(input);

    // Should not publish after subscriber is unsubscribed
    expect(dc.unsubscribe(subscriber)).toBeTrue();
    expect(dc.hasSubscribers).toBeFalse();

    // unsubscribe() should return false when subscriber is not found
    expect(dc.unsubscribe(subscriber)).toBeFalse();

    expect(() => {
      // @ts-expect-error
      subscribe(null);
    }).toThrow(/"channel" argument must be of type/);

    checkCalls();
  });

  // test-diagnostics-channel-safe-subscriber-errors.js
  // TODO: Needs support for 'uncaughtException' event
  test.todo("can handle subscriber errors", () => {
    const input = {
      foo: "bar",
    };
    const dc = channel("channel6");
    const error = new Error("This error should have been caught!");

    process.on(
      "uncaughtException",
      mustCall(err => {
        expect(err).toStrictEqual(error);
      }),
    );

    dc.subscribe(
      mustCall(() => {
        throw error;
      }),
    );

    // The failing subscriber should not stop subsequent subscribers from running
    dc.subscribe(mustCall(() => {}));

    // Publish should continue without throwing
    const fn = mustCall(() => {});
    dc.publish(input);
    fn();

    checkCalls();
  });

  // test-diagnostics-channel-bind-store.js
  // TODO: Needs support for 'uncaughtException' event
  test.todo("can use bind store", () => {
    let n = 0;
    const name = "channel7";
    const thisArg = new Date();
    const inputs = [{ foo: "bar" }, { baz: "buz" }];

    const dc = channel(name);

    // Bind a storage directly to published data
    const store1 = new AsyncLocalStorage();
    dc.bindStore(store1);
    let store1bound = true;

    // Bind a store with transformation of published data
    const store2 = new AsyncLocalStorage();
    dc.bindStore(
      store2,
      mustCall(data => {
        expect(data).toStrictEqual(inputs[n]);
        return { data };
      }, 4),
    );

    // Regular subscribers should see publishes from runStores calls
    dc.subscribe(
      mustCall(data => {
        if (store1bound) {
          expect(data).toStrictEqual(store1.getStore());
        }
        expect({ data }).toStrictEqual(store2.getStore());
        expect(data).toStrictEqual(inputs[n]);
      }, 4),
    );

    // Verify stores are empty before run
    expect(store1.getStore()).toBeUndefined();
    expect(store2.getStore()).toBeUndefined();

    dc.runStores(
      inputs[n],
      mustCall(function (a, b) {
        // Verify this and argument forwarding
        expect(this).toBe(thisArg);
        expect(a).toBe(1);
        expect(b).toBe(2);

        // Verify store 1 state matches input
        expect(store1.getStore()).toStrictEqual(inputs[n]);

        // Verify store 2 state has expected transformation
        expect(store2.getStore()).toStrictEqual({ data: inputs[n] });

        // Should support nested contexts
        n++;
        dc.runStores(
          inputs[n],
          mustCall(function () {
            // Verify this and argument forwarding
            expect(this).toBeUndefined();

            // Verify store 1 state matches input
            expect(store1.getStore()).toStrictEqual(inputs[n]);

            // Verify store 2 state has expected transformation
            expect(store2.getStore()).toStrictEqual({ data: inputs[n] });
          }),
        );
        n--;

        // Verify store 1 state matches input
        expect(store1.getStore()).toStrictEqual(inputs[n]);

        // Verify store 2 state has expected transformation
        expect(store2.getStore()).toStrictEqual({ data: inputs[n] });
      }),
      thisArg,
      1,
      2,
    );

    // Verify stores are empty after run
    expect(store1.getStore()).toBeUndefined();
    expect(store2.getStore()).toBeUndefined();

    // Verify unbinding works
    expect(dc.unbindStore(store1)).toBeTrue();
    store1bound = false;

    // Verify unbinding a store that is not bound returns false
    expect(dc.unbindStore(store1)).toBeFalse();

    n++;
    dc.runStores(
      inputs[n],
      mustCall(() => {
        // Verify after unbinding store 1 will remain undefined
        expect(store1.getStore()).toBeUndefined();

        // Verify still bound store 2 receives expected data
        expect(store2.getStore()).toStrictEqual({ data: inputs[n] });
      }),
    );

    // Contain transformer errors and emit on next tick
    const fail = new Error("fail");
    dc.bindStore(store1, () => {
      throw fail;
    });

    let calledRunStores = false;
    process.once(
      "uncaughtException",
      mustCall(err => {
        expect(calledRunStores).toBeTrue();
        expect(err).toStrictEqual(fail);
      }),
    );

    dc.runStores(
      inputs[n],
      mustCall(() => {}),
    );
    calledRunStores = true;

    checkCalls();
  });

  // test-diagnostics-channel-memory-leak.js
  //
  // Node's version compares process.memoryUsage().heapUsed before the loop with
  // the value after a collection. In Bun, heapUsed is the size measured by the
  // most recent collection, so the first read dates from some earlier point in
  // this file and the two numbers are not comparable. The entries the module
  // keeps per channel also go away in FinalizationRegistry callbacks, after the
  // collection. So check what the node test is after directly: once
  // unsubscribed, nothing holds the channels.
  test("references are not leaked", () => {
    function noop() {}

    const refs: WeakRef<Channel>[] = [];
    for (let i = 0; i < 1000; i++) {
      const name = `channel7-${i}`;
      const dc = channel(name);
      subscribe(name, noop);
      unsubscribe(name, noop);
      refs.push(new WeakRef(dc));
    }

    // Bun.gc() clears the WeakRef targets this job kept alive before it collects.
    gc(true);

    // Conservative stack scanning can keep the last few channels the loop
    // touched alive, so this checks that the channels are collectable rather
    // than that every one of them was collected. A retained reference keeps
    // all 1000 alive.
    const alive = refs.filter(ref => ref.deref() !== undefined).length;
    expect(alive).toBeLessThan(refs.length / 10);
  });
});

describe("TracingChannel", () => {
  // Port tests from:
  // https://github.com/search?q=repo%3Anodejs%2Fnode+test-diagnostics-channel+AND+%2Ftracing%2F&type=code
  test.todo("TODO");
});

const mocks = new Map();

function mustCall<T>(fn: (...args: any[]) => T, expected?: number) {
  const instance = mock(fn);
  mocks.set(instance, expected ?? 1);
  return instance;
}

function mustNotCall<T>(fn: (...args: any[]) => T) {
  return mustCall(fn, 0);
}

// FIXME: remove this and use `afterEach` instead
// Currently, `bun test` disallows `expect()` in `afterEach`
function checkCalls() {
  for (const [mock, expected] of mocks.entries()) {
    expect(mock).toHaveBeenCalledTimes(expected);
  }
  mocks.clear();
}

beforeEach(() => {
  mocks.clear();
});

const httpServerFinishScript = String.raw`
const assert = require("node:assert/strict");
const { channel } = require("node:diagnostics_channel");
const { once } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const [transport, mode] = process.argv.slice(1);
const dc = channel("http.server.response.finish");
const events = [];
const requests = [];
const responses = [];
const messages = [];
let first;
let queuedWithoutSocket = false;
let publishCalls = 0;
const subscriber = (message, name) => {
  assert.equal(name, "http.server.response.finish");
  const { request, response, socket, server: owner } = message;
  const index = requests.indexOf(request);
  assert.deepEqual(Object.keys(message).sort(), ["request", "response", "server", "socket"]);
  assert.notEqual(index, -1);
  assert.equal(response, responses[index]);
  assert.equal(socket, request.socket);
  assert.equal(socket, response.socket);
  assert.equal(owner, server);
  assert.equal(response.writableFinished, true);
  events.push("diagnostic:" + index);
  messages.push(message);
};
if (mode !== "none" && mode !== "late" && mode !== "late-tick") dc.subscribe(subscriber);
const server = http.createServer((req, res) => {
  const index = requests.length;
  requests.push(req);
  responses.push(res);
  res.on("finish", () => events.push("finish:" + index));
  res.on("close", () => events.push("close:" + index));
  if (mode === "late") dc.subscribe(subscriber);
  if (mode === "late-tick") process.nextTick(() => dc.subscribe(subscriber));
  if (mode === "unsubscribe") dc.unsubscribe(subscriber);
  if (mode === "none" || mode === "unsubscribe") {
    assert.equal(dc.hasSubscribers, false);
    dc.publish = () => publishCalls++;
  }
  if (mode === "abort") {
    res.destroy();
  } else if (mode === "queued" && index === 0) {
    first = res;
  } else {
    if (mode === "queued") {
      queuedWithoutSocket = res.socket === null;
      res.on("socket", () => events.push("assigned:" + index));
    }
    res.end("ok");
    if (first) first.end("ok");
  }
});
const listener = transport === "native" ? server : net.createServer(socket => server.emit("connection", socket));
(async () => {
  let client;
  try {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    client = net.connect(listener.address().port, "127.0.0.1");
    const closed = once(client, "close");
    let received = "";
    client.on("data", chunk => received += chunk);
    const payload = mode === "queued"
      ? "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\nHEAD /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
      : "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    client.write(payload);
    await closed;
    assert.equal(requests.length, mode === "queued" ? 2 : 1);
    if (mode === "none" || mode === "unsubscribe" || mode === "abort") {
      assert.equal(messages.length, 0);
      assert.equal(publishCalls, 0);
    } else {
      assert.equal(messages.length, requests.length);
      for (let i = 0; i < requests.length; i++) {
        assert.equal(messages[i].request, requests[i]);
        assert.ok(events.indexOf("diagnostic:" + i) < events.indexOf("finish:" + i));
        assert.ok(events.indexOf("finish:" + i) < events.indexOf("close:" + i));
      }
    }
    if (mode === "queued") {
      assert.equal(queuedWithoutSocket, true);
      assert.equal(messages[0].socket, messages[1].socket);
      assert.ok(events.indexOf("diagnostic:0") < events.indexOf("assigned:1"));
      assert.deepEqual(events.filter(event => event.startsWith("diagnostic:")), ["diagnostic:0", "diagnostic:1"]);
    }
    assert.equal((received.match(/HTTP\/1.1 200 OK/g) || []).length, mode === "abort" ? 0 : requests.length);
    console.log("ok");
  } finally {
    dc.unsubscribe(subscriber);
    client?.destroy();
    server.closeAllConnections();
    if (listener.listening) await new Promise(resolve => listener.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const transport of ["native", "injected"]) {
  for (const mode of ["sync", "queued", "late", "late-tick", "none", "unsubscribe", "abort"]) {
    test.concurrent(`http.server.response.finish: ${transport} ${mode}`, async () => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", httpServerFinishScript, transport, mode],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    });
  }
}

test("child_process.spawn tracing matches synchronous spawn outcomes", async () => {
  await using child = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      /* js */ `
      import assert from 'node:assert/strict';
      import { ChildProcess, spawn, spawnSync } from 'node:child_process';
      import { tracingChannel } from 'node:diagnostics_channel';
      import { once } from 'node:events';

      const trace = tracingChannel('child_process.spawn');
      const events = [];
      let observerOptions;
      const listeners = {
        start(message) {
          events.push(['start', message]);
          assert.equal(message.process.spawnfile, message.options.file);
          assert.equal(message.process.spawnargs, message.options.args);
          observerOptions = message.options;
          message.process.once('spawn', () => events.push(['spawn']));
        },
        end(message) { events.push(['end', message]); },
        error(message) { events.push(['error', message]); },
        asyncStart() { events.push(['asyncStart']); },
        asyncEnd() { events.push(['asyncEnd']); },
      };
      trace.subscribe(listeners);
      try {
        new ChildProcess();
        assert.throws(() => spawn(null), { code: 'ERR_INVALID_ARG_TYPE' });
        spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
        assert.deepEqual(events, []);

        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        assert.deepEqual(events.map(([name]) => name), ['start', 'end']);
        assert.equal(events[0][1].process, child);
        assert.equal(events[1][1].process, child);
        assert.equal(observerOptions.file, process.execPath);
        await once(child, 'close');
        assert.deepEqual(events.map(([name]) => name), ['start', 'end', 'spawn']);

        events.length = 0;
        const missing = spawn('bun-nonexistent-tracing-executable', [], { stdio: 'ignore' });
        const closed = new Promise(resolve => missing.once('close', resolve));
        missing.on('error', () => events.push(['childError']));
        assert.deepEqual(events.map(([name]) => name), ['start', 'error']);
        assert.equal(events[1][1].process, missing);
        assert.equal(events[1][1].error.code, 'ENOENT');
        assert.equal(events[1][1].error.syscall, 'spawn');
        assert.equal(events[1][1].error.message, 'spawn ENOENT');
        await closed;
        assert.deepEqual(events.map(([name]) => name), ['start', 'error', 'childError']);
        assert.equal(events[1][1].error.syscall, 'spawn');

        events.length = 0;
        assert.throws(() => spawn(process.execPath, [], { cwd: process.execPath }), { code: 'ENOTDIR' });
        assert.deepEqual(events.map(([name]) => name), ['start', 'error']);
        assert.equal(events[1][1].error.code, 'ENOTDIR');
        assert.equal(events[1][1].error.syscall, 'spawn');
        console.log('spawn tracing contract passed');
      } finally {
        trace.unsubscribe(listeners);
      }
    `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  expect(stderr).toBe("");
  expect(stdout).toBe("spawn tracing contract passed\n");
  expect(exitCode).toBe(0);
});

const httpChannelFamilyScript = String.raw`
const assert = require("node:assert/strict");
const dc = require("node:diagnostics_channel");
const { once } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const [transport = "native", mode = "normal"] = process.argv.slice(1);
const names = ["http.server.response.created", "http.server.request.start", "http.server.response.finish",
  "http.client.request.created", "http.client.request.start", "http.client.request.error", "http.client.response.finish"];
const records = [];
const events = [];
const subscriptions = names.map(name => {
  const channel = dc.channel(name);
  const subscriber = (message) => {
    records.push({name, message, keys: Object.keys(message).sort(), socketAtPublish: message.response?.socket});
    events.push(name);
  };
  if (mode !== "none") channel.subscribe(subscriber);
  return {channel, subscriber};
});
const requests = [];
const responses = [];
let client;
let clientResponse;
let clientError;
let first;
let server;
function handler(req, res) {
  requests.push(req); responses.push(res); events.push("handler");
  res.on("finish", () => events.push("finish"));
  if (mode === "abort") res.destroy();
  else if (mode === "queued" && !first) first = res;
  else {
    res.end("ok");
    if (first) first.end("ok");
  }
}
server = http.createServer(handler);
if (mode === "continue") server.on("checkContinue", handler);
if (mode === "expectation") server.on("checkExpectation", handler);
if (mode === "upgrade") server.on("upgrade", (req, socket) => {events.push("upgrade"); socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");});
const listener = transport === "injected" ? net.createServer(socket => server.emit("connection", socket)) : server;
const timer = setTimeout(() => { console.error("HTTP proof timed out"); process.exit(2); }, 10000);
(async () => {
  try {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    if (["normal", "none", "abort"].includes(mode)) {
      await new Promise((resolve, reject) => {
        client = http.request({host:"127.0.0.1",port:listener.address().port,path:"/synthetic",agent:false}, res => {
          clientResponse = res; events.push("response"); res.on("error", reject); res.on("end", resolve); res.resume();
        });
        client.on("error", err => {clientError = err; events.push("error"); mode === "abort" ? resolve() : reject(err);});
        client.end();
      });
    } else {
      client = net.connect(listener.address().port,"127.0.0.1");
      const closed = once(client,"close");
      client.resume();
      const extra = mode === "continue" ? "Expect: 100-continue\r\n" :
        ["expectation","reject"].includes(mode) ? "Expect: synthetic\r\n" :
        ["upgrade","declined"].includes(mode) ? "Upgrade: synthetic\r\n" : "";
      const connection = ["upgrade","declined"].includes(mode) ? "upgrade, close" : "close";
      const request = "GET /synthetic HTTP/1.1\r\nHost: localhost\r\n" + extra + "Connection: " + connection + "\r\n\r\n";
      client.write(mode === "queued" ? "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n"+request : request);
      await closed;
    }
    const perName = Object.fromEntries(names.map(name => [name,records.filter(record => record.name === name)]));
    console.log(JSON.stringify({transport,mode,events,counts:Object.fromEntries(names.map(name=>[name,perName[name].length])),
      payloadKeys:Object.fromEntries(names.map(name=>[name,perName[name].map(x=>x.keys)]))}));
    if (mode === "none") {assert.equal(records.length,0); return;}
    const expected = mode === "upgrade" ? 0 : mode === "queued" ? 2 : 1;
    for (const name of names.slice(0,3)) assert.equal(perName[name].length,name.endsWith("finish") && mode === "abort" ? 0 : expected,name);
    for (let i=0;i<expected;i++) {
      const created=perName[names[0]][i],start=perName[names[1]][i],finish=perName[names[2]][i];
      assert.deepEqual(created.keys,["request","response"]);
      assert.deepEqual(start.keys,["request","response","server","socket"]);
      assert.equal(start.message.server,server);
      assert.equal(start.message.socket,start.message.request.socket);
      assert.equal(created.message.request,start.message.request);
      assert.equal(created.message.response,start.message.response);
      assert.equal(start.socketAtPublish,null,"start publishes before socket assignment");
      if(mode !== "reject") {
        assert.equal(start.message.request,requests[i]); assert.equal(start.message.response,responses[i]);
      }
      if(finish) {
        assert.deepEqual(finish.keys,start.keys); assert.equal(finish.message.request,start.message.request);
        assert.equal(finish.message.response,start.message.response); assert.equal(finish.message.server,server);
      }
    }
    if(expected && mode !== "reject") assert.ok(events.indexOf(names[1]) < events.indexOf("handler"));
    if(["normal","abort"].includes(mode)) {
      for(const name of names.slice(3,5)) {assert.equal(perName[name].length,1,name);assert.equal(perName[name][0].message.request,client);assert.deepEqual(perName[name][0].keys,["request"]);}
      const error=perName[names[5]],response=perName[names[6]];
      assert.equal(error.length,mode === "abort" ? 1 : 0);assert.equal(response.length,mode === "normal" ? 1 : 0);
      if(error.length) {assert.deepEqual(error[0].keys,["error","request"]);assert.equal(error[0].message.error,clientError);assert.ok(events.indexOf(names[5])<events.indexOf("error"));}
      if(response.length) {assert.deepEqual(response[0].keys,["request","response"]);assert.equal(response[0].message.response,clientResponse);assert.ok(events.indexOf(names[6])<events.indexOf("response"));}
    }
  } finally {
    clearTimeout(timer);
    for(const {channel,subscriber} of subscriptions) channel.unsubscribe(subscriber);
    client?.destroy(); server.closeAllConnections();
    if(listener.listening) await new Promise(resolve=>listener.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
`;

for (const transport of ["native", "injected"]) {
  for (const mode of [
    "normal",
    "none",
    "abort",
    "continue",
    "expectation",
    "reject",
    "upgrade",
    "declined",
    "queued",
  ]) {
    test.concurrent(`http diagnostics family: ${transport} ${mode}`, async () => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", httpChannelFamilyScript, transport, mode],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
      expect(JSON.parse(stdout)).toMatchObject({ transport, mode });
    });
  }
}

const httpConstructorChannelsScript = String.raw`
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const {once} = require("node:events");
const {channel} = require("node:diagnostics_channel");
const [transport = "native", mode = "drop-options"] = process.argv.slice(1);
const created = channel("http.server.response.created");
const seen = [];
const order = [];
const subscriber = message => {seen.push(message); order.push("created"); assert.equal(message.response.socket,null);};
created.subscribe(subscriber);
let server;
let listener;
let client;
const timer = setTimeout(()=>{console.error("constructor proof timed out");process.exit(2)},10000);
(async()=>{
  try {
    if(mode === "standalone") {
      const request = {method:"GET",httpVersionMajor:1,httpVersionMinor:1};
      const response = new http.ServerResponse(request);
      assert.deepEqual(seen,[{request,response}]);
      assert.equal(response.socket,null);
      console.log("ok");
      return;
    }
    class CustomResponse extends http.ServerResponse {
      constructor(req, options) {
        order.push("before");
        super(req,mode === "drop-options" || mode === "upgrade" ? undefined : options);
        order.push("after");
        if(mode === "unsubscribe") created.unsubscribe(subscriber);
      }
    }
    let request;
    let response;
    server = http.createServer({ServerResponse:CustomResponse},(req,res)=>{request=req;response=res;res.end("ok")});
    if(mode === "upgrade") server.on("upgrade",(_req,socket)=>socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n"));
    listener = transport === "injected" ? net.createServer(socket=>server.emit("connection",socket)) : server;
    listener.listen(0,"127.0.0.1");
    await once(listener,"listening");
    client = net.connect(listener.address().port,"127.0.0.1");
    const closed = once(client,"close");
    client.resume();
    client.write(mode === "upgrade" ? "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade\r\nUpgrade: synthetic\r\n\r\n" : "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await closed;
    assert.deepEqual(order,mode === "upgrade" ? [] : ["before","created","after"]);
    assert.deepEqual(seen,mode === "upgrade" ? [] : [{request,response}]);
    console.log("ok");
  } finally {
    clearTimeout(timer);
    created.unsubscribe(subscriber);
    client?.destroy();server?.closeAllConnections();
    if(listener?.listening) await new Promise(resolve=>listener.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
`;

for (const transport of ["native", "injected"]) {
  for (const mode of ["standalone", "drop-options", "forward-options", "unsubscribe", "upgrade"]) {
    test.concurrent(`http response.created constructors: ${transport} ${mode}`, async () => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", httpConstructorChannelsScript, transport, mode],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    });
  }
}

const httpSubscriberWriteScript = String.raw`
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const {once} = require("node:events");
const {channel} = require("node:diagnostics_channel");
const [transport = "native", topic = "http.server.request.start"] = process.argv.slice(1);
const dc = channel(topic);
let first;
let callbacks = 0;
let client;
const subscriber = ({request,response}) => {
  assert.equal(response.socket,null);
  if(request.url === "/second") {
    callbacks++;
    response.setHeader("Content-Length","12");
    response.write("B-head");
  }
};
dc.subscribe(subscriber);
const server = http.createServer((req,res)=>{
  if(req.url === "/first") first = res;
  else {
    res.end("B-tail");
    first.setHeader("Content-Length","6");
    first.end("A-body");
  }
});
const listener = transport === "injected" ? net.createServer(socket=>server.emit("connection",socket)) : server;
const timer=setTimeout(()=>{console.error("subscriber proof timed out");process.exit(2)},10000);
(async()=>{
  try {
    listener.listen(0,"127.0.0.1");await once(listener,"listening");
    client=net.connect(listener.address().port,"127.0.0.1");
    let wire="";
    client.on("data",chunk=>wire+=chunk);
    const closed=once(client,"close");
    client.write("GET /first HTTP/1.1\r\nHost: localhost\r\n\r\nGET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await closed;
    assert.equal(callbacks,1);
    const responses=wire.split("HTTP/1.1 200 OK\r\n");
    assert.equal(responses.length,3,wire);
    assert.equal(responses[0],"");
    assert.equal(responses[1].split("\r\n\r\n")[1],"A-body");
    assert.equal(responses[2].split("\r\n\r\n")[1],"B-headB-tail");
    console.log("ok");
  } finally {
    clearTimeout(timer);dc.unsubscribe(subscriber);client?.destroy();server.closeAllConnections();
    if(listener.listening) await new Promise(resolve=>listener.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
`;

for (const transport of ["native", "injected"]) {
  for (const topic of ["http.server.request.start", "http.server.response.created"]) {
    test.concurrent(`http diagnostics subscriber writes: ${transport} ${topic}`, async () => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", httpSubscriberWriteScript, transport, topic],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    });
  }
}

const httpSubscriberEdgeScript = String.raw`
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {once} = require('node:events');
const {channel} = require('node:diagnostics_channel');
const [transport='native',topic='http.server.request.start',mode='socket-write']=process.argv.slice(1);
const dc=channel(topic);
let response;
let published=0;
let client;
const subscriber=({response:res})=>{
  published++;
  assert.equal(res.socket,null);
  if(mode==='flush') res.flushHeaders();
  else {
    res.write('A');
    res.on('socket',()=>res.write('B'));
  }
};
dc.subscribe(subscriber);
const server=http.createServer((_req,res)=>{response=res;if(mode!=='flush')res.end('C')});
const listener=transport==='injected'?net.createServer(socket=>server.emit('connection',socket)):server;
const timer=setTimeout(()=>{console.error('subscriber edge timeout');process.exit(2)},5000);
(async()=>{
  try {
    listener.listen(0,'127.0.0.1');await once(listener,'listening');
    const body=await new Promise((resolve,reject)=>{
      client=http.get({host:'127.0.0.1',port:listener.address().port,agent:false},res=>{
        if(mode==='flush')response.end('headers-first');
        let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>resolve(body));
      });
      client.on('error',reject);
    });
    assert.equal(published,1);
    assert.equal(body,mode==='flush'?'headers-first':'ABC');
    console.log('ok');
  } finally {
    clearTimeout(timer);dc.unsubscribe(subscriber);client?.destroy();server.closeAllConnections();
    if(listener.listening)await new Promise(resolve=>listener.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
`;

for (const transport of ["native", "injected"]) {
  for (const topic of ["http.server.request.start", "http.server.response.created"]) {
    for (const mode of ["socket-write", "flush"]) {
      test.concurrent(`http diagnostics subscriber ordering: ${transport} ${topic} ${mode}`, async () => {
        await using proc = Bun.spawn({
          cmd: [bunExe(), "-e", httpSubscriberEdgeScript, transport, topic, mode],
          env: bunEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
      });
    }
  }
}

test("fallback response constructor writes are buffered without diagnostics subscribers", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      String.raw`
const assert=require('node:assert/strict');
const http=require('node:http');
const net=require('node:net');
const {once}=require('node:events');
let first;
let client;
class Response extends http.ServerResponse {
  constructor(req,options){
    super(req,options);
    if(req.url==='/second')this.writeEarlyHints({link:'</synthetic>; rel=preload'});
  }
}
const server=http.createServer({ServerResponse:Response},(req,res)=>{
  res.setHeader('Content-Length','6');
  if(req.url==='/first'){first=res;res.write('A-');}
  else {res.end('B-body');first.end('body');}
});
const listener=net.createServer(socket=>server.emit('connection',socket));
const timer=setTimeout(()=>{console.error('constructor hints timeout');process.exit(2)},5000);
(async()=>{
  try{
    listener.listen(0,'127.0.0.1');await once(listener,'listening');
    client=net.connect(listener.address().port,'127.0.0.1');
    let wire='';client.on('data',chunk=>wire+=chunk);
    const closed=once(client,'close');
    client.write('GET /first HTTP/1.1\r\nHost: localhost\r\n\r\nGET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await closed;
    const body=wire.indexOf('A-body'),hint=wire.indexOf('HTTP/1.1 103 Early Hints'),last=wire.indexOf('HTTP/1.1 200 OK',1);
    assert.notEqual(body,-1,wire);assert.ok(hint>body,wire);assert.ok(last>hint,wire);assert.ok(wire.endsWith('B-body'),wire);
    console.log('ok');
  }finally{
    clearTimeout(timer);client?.destroy();server.closeAllConnections();
    if(listener.listening)await new Promise(resolve=>listener.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
`,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
});

const httpSubscriberFreezeScript = String.raw`
const assert=require('node:assert/strict');const http=require('node:http');const net=require('node:net');const {once}=require('node:events');const {channel}=require('node:diagnostics_channel');
const [transport='native',topic='http.server.request.start',mode='write']=process.argv.slice(1);
const dc=channel(topic);let client;let published=0;
const subscriber=({response:res})=>{
 published++;res.setHeader('x-before','yes');res[mode]('A');
 assert.equal(res.headersSent,true);
 assert.throws(()=>res.setHeader('x-after','no'),{code:'ERR_HTTP_HEADERS_SENT'});
 res.statusCode=204;
};
dc.subscribe(subscriber);
const server=http.createServer((_req,res)=>{if(!res.finished)res.end('B')});
const listener=transport==='injected'?net.createServer(socket=>server.emit('connection',socket)):server;
const timer=setTimeout(()=>{console.error('subscriber freeze timeout');process.exit(2)},5000);
(async()=>{try{
 listener.listen(0,'127.0.0.1');await once(listener,'listening');
 const result=await new Promise((resolve,reject)=>{client=http.get({host:'127.0.0.1',port:listener.address().port,agent:false},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,header:res.headers['x-before'],body}))});client.on('error',reject)});
 assert.equal(published,1);assert.deepEqual(result,{status:200,header:'yes',body:mode==='end'?'A':'AB'});console.log('ok');
}finally{clearTimeout(timer);dc.unsubscribe(subscriber);client?.destroy();server.closeAllConnections();if(listener.listening)await new Promise(resolve=>listener.close(resolve))}})().catch(error=>{console.error(error);process.exitCode=1});
`;

for (const transport of ["native", "injected"]) {
  for (const topic of ["http.server.request.start", "http.server.response.created"]) {
    for (const mode of ["write", "end"]) {
      test.concurrent(`http diagnostics freezes headers: ${transport} ${topic} ${mode}`, async () => {
        await using proc = Bun.spawn({
          cmd: [bunExe(), "-e", httpSubscriberFreezeScript, transport, topic, mode],
          env: bunEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
      });
    }
  }
}
