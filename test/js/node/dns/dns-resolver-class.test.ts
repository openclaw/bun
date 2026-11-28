// node-dns.test.js resolves public hostnames. These tests need no network.
import { describe, expect, test } from "bun:test";
import { runWithError } from "harness";
import dgram from "node:dgram";
import dns from "node:dns";
import { once } from "node:events";

describe.each([
  ["dns.Resolver", dns.Resolver],
  ["dns.promises.Resolver", dns.promises.Resolver],
])("%s", (_name, Resolver: any) => {
  test("an instance has Resolver.prototype", () => {
    const resolver = new Resolver();
    expect(Object.getPrototypeOf(resolver)).toBe(Resolver.prototype);
    expect(resolver.constructor).toBe(Resolver);
  });

  test("a subclass instance has the subclass prototype and its own servers", () => {
    class PinnedResolver extends Resolver {
      getServers() {
        return super.getServers().map((server: string) => `pinned ${server}`);
      }
    }

    const resolver = new (PinnedResolver as any)({ timeout: 1000, tries: 1 });
    expect(Object.getPrototypeOf(resolver)).toBe(PinnedResolver.prototype);
    expect(resolver).toBeInstanceOf(Resolver);

    resolver.setServers(["192.0.2.1"]);
    expect(resolver.getServers()).toEqual(["pinned 192.0.2.1"]);
    expect(dns.getServers()).not.toContain("192.0.2.1");
  });

  test("throws a TypeError when called without new", () => {
    expect(() => Resolver()).toThrow(TypeError);
  });

  test.each([
    ["resolve", "ERR_INVALID_ARG_TYPE"],
    ["resolveAny", "ERR_INVALID_ARG_TYPE"],
    ["reverse", "ERR_INVALID_ARG_TYPE"],
    ["setLocalAddress", "ERR_INVALID_IP_ADDRESS"],
    ["setServers", "ERR_INVALID_ARG_TYPE"],
  ])("_handle.%s() treats a missing argument as undefined", (method, code) => {
    const handle = new Resolver()._handle;
    const missing = runWithError(() => handle[method]());
    expect(missing).toMatchObject({ name: "TypeError", code });
    expect(missing).toEqual(runWithError(() => handle[method](undefined)));
  });
});

test.each(["resolveTxt", "resolveAny"] as const)(
  "%s preserves TXT record and character-string boundaries",
  async method => {
    const socket = dgram.createSocket("udp4");
    try {
      socket.on("message", (query, peer) => {
        const question = query.subarray(12, query.indexOf(0, 12) + 5);
        const header = Buffer.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]);
        const answers = [Buffer.from([1, 0x61, 0, 1, 0xff]), Buffer.from([1, 0x62])].flatMap(data => [
          Buffer.from([0xc0, 0x0c, 0, 16, 0, 1, 0, 0, 0, 0, 0, data.length]),
          data,
        ]);
        socket.send(Buffer.concat([header, question, ...answers]), peer.port, peer.address);
      });
      socket.bind(0, "127.0.0.1");
      await once(socket, "listening");
      const resolver = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
      resolver.setServers(["127.0.0.1:" + socket.address().port]);
      const records = [["a", "", "ÿ"], ["b"]];
      expect(await resolver[method]("chunks.example.test")).toEqual(
        method === "resolveTxt" ? records : records.map(entries => ({ type: "TXT", entries })),
      );
    } finally {
      socket.close();
    }
  },
);
