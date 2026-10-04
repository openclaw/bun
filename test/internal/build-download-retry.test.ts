/**
 * downloadWithRetry() (scripts/build/download.ts) is all that stands between
 * a CI build lane and github.com: every dep whose pin moved after the CI
 * images (and the prefetch cache baked into them) were published downloads
 * live on every lane of every build, WebKit included, so a build makes on the
 * order of a hundred github.com round-trips through this one loop. The
 * outages CI actually hits are agent-wide and last from 30s to a few minutes;
 * a 5 attempt / ~30s schedule gave up inside them and failed the lane with
 * nothing but "cause: fetch failed" in the log.
 *
 * The fake server below scripts one outcome per request. The production
 * schedule is driven with its backoff zeroed, so the full attempt count runs
 * in milliseconds; the schedule's real timing is asserted separately.
 */
import { expect, spyOn, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import {
  downloadRetry,
  downloadWithRetry,
  fetchPrebuilt,
  prefetchPathForSha256,
  prefetchPathForUrl,
  type RetryPolicy,
} from "../../scripts/build/download.ts";
import { BuildError, describeError } from "../../scripts/build/error.ts";

const BODY = "tarball bytes";

test("prebuilt archives verify bytes before extraction and key cache hits by digest", async () => {
  using dir = tempDir("prebuilt-sha256", { "package/value": "verified" });
  const archive = join(String(dir), "package.tar.gz");
  expect(spawnSync("tar", ["-czf", archive, "-C", String(dir), "package"]).status).toBe(0);
  const bytes = readFileSync(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let responseBytes: Uint8Array = bytes;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      requests++;
      return new Response(responseBytes);
    },
  });
  const dest = join(String(dir), "installed");
  try {
    await fetchPrebuilt("fixture", server.url.href, dest, "pin", [], digest);
    expect(readFileSync(join(dest, "value"), "utf8")).toBe("verified");
    await fetchPrebuilt("fixture", server.url.href, dest, "pin", [], digest);
    expect(requests).toBe(1);
    // Malformed archive bytes distinguish checksum rejection from extraction failure.
    responseBytes = new TextEncoder().encode("not a gzip archive");
    await expect(fetchPrebuilt("fixture", server.url.href, dest, "pin", [], "0".repeat(64))).rejects.toThrow(
      "SHA-256 mismatch for fixture",
    );
    expect(readFileSync(join(dest, "value"), "utf8")).toBe("verified");
    expect(requests).toBe(2);
    await expect(fetchPrebuilt("fixture", server.url.href, dest, "pin", [], "invalid")).rejects.toThrow(
      "prebuilt: invalid SHA-256",
    );
    const cache = join(String(dir), "prefetch");
    mkdirSync(join(cache, "by-url"), { recursive: true });
    mkdirSync(join(cache, "by-sha256"), { recursive: true });
    writeFileSync(prefetchPathForUrl(server.url.href, cache)!, "untrusted URL cache");
    const cachedArchive = prefetchPathForSha256(digest, cache)!;
    writeFileSync(cachedArchive, bytes);
    const downloadModule = new URL("../../scripts/build/download.ts", import.meta.url).href;
    async function fromPrefetch(target: string) {
      await using child = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `import { fetchPrebuilt } from ${JSON.stringify(downloadModule)};
          await fetchPrebuilt("fixture", ${JSON.stringify(server.url.href)}, ${JSON.stringify(target)}, "pin", [], ${JSON.stringify(digest)});`,
        ],
        env: { ...bunEnv, BUN_BUILD_PREFETCH_DIR: cache },
        stdout: "pipe",
        stderr: "pipe",
      });
      return await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    }
    const unverifiedTree = join(cache, "extracted", "cached-install");
    mkdirSync(unverifiedTree, { recursive: true });
    writeFileSync(join(unverifiedTree, ".identity"), `pin:sha256:${digest}\n`);
    writeFileSync(join(unverifiedTree, "value"), "unverified extracted image cache");
    const cachedDest = join(String(dir), "cached-install");
    const [, cachedError, cachedExit] = await fromPrefetch(cachedDest);
    expect(cachedError).toBe("");
    expect(cachedExit).toBe(0);
    expect(readFileSync(join(cachedDest, "value"), "utf8")).toBe("verified");
    expect(requests).toBe(2);
    writeFileSync(cachedArchive, "corrupt digest cache");
    const corruptDest = join(String(dir), "corrupt-install");
    const [, corruptError, corruptExit] = await fromPrefetch(corruptDest);
    expect(corruptError).toContain("SHA-256 mismatch for fixture");
    expect(corruptExit).not.toBe(0);
    expect(existsSync(corruptDest)).toBe(false);
  } finally {
    server.stop(true);
  }
});

/** The production attempt count with no waiting between attempts. */
const noBackoff: RetryPolicy = { ...downloadRetry, backoffMs: () => 0 };

/** "drop" closes the connection without answering; a string is a status line. */
type Outcome = "drop" | string;

/**
 * Answers each request with the next scripted outcome, then with BODY once
 * the script runs out (or drops forever when asked to). "drop" is what an
 * unreachable or resetting github.com looks like to fetch(). Every response
 * is Connection: close, so one attempt is exactly one request here.
 */
async function fakeServer(script: Outcome[], { dropForever = false } = {}) {
  let requests = 0;
  const server = createServer(socket => {
    socket.once("data", () => {
      requests++;
      const outcome = dropForever ? "drop" : script.shift();
      if (outcome === "drop") {
        socket.destroy();
      } else if (outcome === undefined) {
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n${BODY}`);
      } else {
        socket.end(`HTTP/1.1 ${outcome}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/dep.tar.gz`,
    get requests() {
      return requests;
    },
    [Symbol.asyncDispose]: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the download to fail");
}

/** downloadWithRetry narrates each retry through console.log; collect those lines instead of printing them. */
async function withLogCaptured<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    return { result: await fn(), lines };
  } finally {
    log.mockRestore();
  }
}

test("the schedule waits out at least two minutes of github.com being unreachable", () => {
  let totalBackoffMs = 0;
  for (let attempt = 2; attempt <= downloadRetry.attempts; attempt++) {
    const backoffMs = downloadRetry.backoffMs(attempt);
    // Capped so a recovered network is noticed within half a minute.
    expect(backoffMs).toBeLessThanOrEqual(30_000);
    totalBackoffMs += backoffMs;
  }
  expect(totalBackoffMs).toBeGreaterThanOrEqual(120_000);
});

test("a download that fails on every attempt but the last still succeeds", async () => {
  using dir = tempDir("build-download-retry", {});
  await using server = await fakeServer(Array(downloadRetry.attempts - 1).fill("drop"));
  const dest = join(String(dir), "dep.tar.gz");

  const { lines } = await withLogCaptured(() => downloadWithRetry(server.url, dest, "dep", noBackoff));

  expect(readFileSync(dest, "utf8")).toBe(BODY);
  expect(server.requests).toBe(downloadRetry.attempts);
  expect(lines.filter(line => line.startsWith("retry "))).toHaveLength(downloadRetry.attempts - 1);
});

test("429 is retried, and the retry line says what failed", async () => {
  using dir = tempDir("build-download-retry", {});
  await using server = await fakeServer(["429 Too Many Requests"]);
  const dest = join(String(dir), "dep.tar.gz");

  const { lines } = await withLogCaptured(() => downloadWithRetry(server.url, dest, "dep", noBackoff));

  expect(readFileSync(dest, "utf8")).toBe(BODY);
  expect(server.requests).toBe(2);
  expect(lines).toEqual([`retry 2/${downloadRetry.attempts} in 0ms (HTTP 429 Too Many Requests for ${server.url})`]);
});

test("404 is not retried and is thrown as-is (prefetch-deps.ts matches on the message)", async () => {
  using dir = tempDir("build-download-retry", {});
  await using server = await fakeServer(["404 Not Found"]);
  const dest = join(String(dir), "dep.tar.gz");

  const { result: err, lines } = await withLogCaptured(() =>
    rejection(downloadWithRetry(server.url, dest, "dep", noBackoff)),
  );

  expect(err).toBeInstanceOf(BuildError);
  expect((err as BuildError).message).toBe(`HTTP 404 Not Found for ${server.url}`);
  expect(lines).toEqual([]);
  expect(server.requests).toBe(1);
  expect(existsSync(dest)).toBe(false);
});

test("giving up reports the attempt count and the failure that ended it", async () => {
  using dir = tempDir("build-download-retry", {});
  await using server = await fakeServer([], { dropForever: true });
  const dest = join(String(dir), "dep.tar.gz");

  const { result, lines } = await withLogCaptured(() =>
    rejection(downloadWithRetry(server.url, dest, "dep", noBackoff)),
  );
  const err = result as BuildError;

  expect(err).toBeInstanceOf(BuildError);
  expect(err.message).toBe(`Failed to download after ${downloadRetry.attempts} attempts: ${server.url}`);
  // The dropped connection is what fetch() threw; it must be named both in
  // the final report and on every retry line. (The exact wording is the
  // runtime's, so only its gist is pinned.)
  const droppedConnection = /closed|reset/i;
  const reason = describeError(err.cause);
  expect(reason).toMatch(droppedConnection);
  expect(err.format()).toContain(`cause: ${reason}`);
  expect(lines.map(line => line.replace(/ \(.*\)$/, ""))).toEqual(
    Array.from({ length: downloadRetry.attempts - 1 }, (_, i) => `retry ${i + 2}/${downloadRetry.attempts} in 0ms`),
  );
  for (const line of lines) expect(line).toMatch(droppedConnection);
  expect(server.requests).toBe(downloadRetry.attempts);
  expect(existsSync(dest)).toBe(false);
});

test("BuildError.format() shows what is behind node's 'fetch failed'", () => {
  const err = new BuildError("Failed to download after 10 attempts: https://github.com/o/r/archive/abc.tar.gz", {
    hint: "Check network connectivity",
    cause: new TypeError("fetch failed", { cause: new Error("getaddrinfo EAI_AGAIN github.com") }),
  });

  expect(err.format()).toBe(
    "error: Failed to download after 10 attempts: https://github.com/o/r/archive/abc.tar.gz\n" +
      "  hint: Check network connectivity\n" +
      "  cause: fetch failed: getaddrinfo EAI_AGAIN github.com\n",
  );
});

test("describeError() flattens cause chains, AggregateErrors, and non-Error causes", () => {
  expect(describeError("just a string")).toBe("just a string");
  expect(describeError(new Error("write failed", { cause: "ENOSPC" }))).toBe("write failed: ENOSPC");

  // node's shape for a connect that failed on every resolved address: the
  // AggregateError's own message is empty, the reasons are in .errors.
  const connect = new AggregateError([
    new Error("connect ETIMEDOUT 140.82.112.3:443"),
    new Error("connect ENETUNREACH 140.82.112.4:443"),
  ]);
  expect(describeError(new TypeError("fetch failed", { cause: connect }))).toBe(
    "fetch failed: connect ETIMEDOUT 140.82.112.3:443; connect ENETUNREACH 140.82.112.4:443",
  );

  const loop = new Error("loops");
  loop.cause = loop;
  expect(describeError(loop)).toBe("loops");
});
