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
