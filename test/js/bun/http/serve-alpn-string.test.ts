import { expect, test } from "bun:test";
import { tls as tlsCert } from "harness";
import tls from "node:tls";

function wireList(protocol: string) {
  return String.fromCharCode(protocol.length) + protocol;
}

function negotiatedProtocol(port: number, protocol: string) {
  return new Promise<string | null>((resolve, reject) => {
    const socket = tls.connect({
      port,
      host: "127.0.0.1",
      servername: "localhost",
      rejectUnauthorized: false,
      ALPNProtocols: [protocol],
    });
    socket.once("secureConnect", () => {
      const selected = socket.alpnProtocol;
      socket.end();
      resolve(selected);
    });
    socket.once("error", reject);
  });
}

test("Bun.serve forwards a wire-format ALPNProtocols string", async () => {
  for (const protocol of ["h2", "http/1.1"]) {
    const server = Bun.serve({
      port: 0,
      tls: {
        ...tlsCert,
        ALPNProtocols: wireList(protocol),
      },
      fetch() {
        return new Response("ok");
      },
    });
    try {
      expect(await negotiatedProtocol(server.port, protocol)).toBe(protocol);
    } finally {
      server.stop(true);
    }
  }
});

test("a plain ALPNProtocols string is not a protocol name", () => {
  expect(() => {
    const server = Bun.serve({
      port: 0,
      tls: {
        ...tlsCert,
        ALPNProtocols: "http/1.1",
      },
      fetch() {
        return new Response("ok");
      },
    });
    server.stop(true);
  }).toThrow("Failed to configure TLS ALPN protocols");
});
