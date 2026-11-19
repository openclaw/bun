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
import { describe, expect, spyOn, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { pins } from "../../scripts/build/ci-images/spec.ts";
import type { Config } from "../../scripts/build/config.ts";
import {
  checkSha256,
  downloadRetry,
  downloadWithRetry,
  fetchPrebuilt,
  prefetchPathForSha256,
  prefetchPathForUrl,
  type RetryPolicy,
} from "../../scripts/build/download.ts";
import { BuildError, describeError } from "../../scripts/build/error.ts";
import { ensureWindowsSysroot, XWIN_VERSION } from "../../scripts/build/winsysroot.ts";

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
    await fetchPrebuilt("fixture", server.url.href, dest, "pin", digest);
    expect(readFileSync(join(dest, "value"), "utf8")).toBe("verified");
    await fetchPrebuilt("fixture", server.url.href, dest, "pin", digest);
    expect(requests).toBe(1);
    // Malformed archive bytes distinguish checksum rejection from extraction failure.
    responseBytes = new TextEncoder().encode("not a gzip archive");
    await expect(fetchPrebuilt("fixture", server.url.href, dest, "pin", "0".repeat(64))).rejects.toThrow(
      `expected ${"0".repeat(64)}`,
    );
    expect(readFileSync(join(dest, "value"), "utf8")).toBe("verified");
    expect(requests).toBe(2);
    await expect(fetchPrebuilt("fixture", server.url.href, dest, "pin", "invalid")).rejects.toThrow(
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
          await fetchPrebuilt("fixture", ${JSON.stringify(server.url.href)}, ${JSON.stringify(target)}, "pin", ${JSON.stringify(digest)});`,
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
    expect(corruptError).toContain(`expected ${digest}`);
    expect(corruptExit).not.toBe(0);
    expect(existsSync(corruptDest)).toBe(false);
    expect(readdirSync(String(dir)).filter(name => name.startsWith("corrupt-install.") && name.endsWith(".partial"))).toEqual([]);
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

test("checkSha256() accepts the file's own sha256 and throws on any other", () => {
  using dir = tempDir("build-check-sha256", { "dep.tar.gz": BODY });
  const file = join(String(dir), "dep.tar.gz");
  const actual = new Bun.CryptoHasher("sha256").update(BODY).digest("hex");
  const other = new Bun.CryptoHasher("sha256").update("other bytes").digest("hex");

  expect(() => checkSha256(file, actual)).not.toThrow();
  expect(() => checkSha256(file, other)).toThrow(new BuildError(`dep.tar.gz: sha256 is ${actual}, expected ${other}`));
});

function sha256Of(bytes: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("checkSha256() hashes a file that takes several reads", () => {
  using dir = tempDir("build-check-sha256-large", {});
  const file = join(String(dir), "dep.tar.gz");
  const bytes = Buffer.alloc((2 << 20) + 1, "0123456789abc");
  writeFileSync(file, bytes);

  expect(() => checkSha256(file, sha256Of(bytes))).not.toThrow();
});

test("a download whose sha256 is not the pinned one is neither kept nor retried", async () => {
  using dir = tempDir("build-download-sha256", {});
  await using server = await fakeServer([]);
  const dest = join(String(dir), "dep.tar.gz");
  const other = sha256Of("other bytes");

  const err = await rejection(downloadWithRetry(server.url, dest, "dep", noBackoff, undefined, other));

  expect((err as BuildError).message).toBe(`${server.url}: sha256 is ${sha256Of(BODY)}, expected ${other}`);
  expect(server.requests).toBe(1);
  expect(readdirSync(String(dir))).toEqual([]);

  await downloadWithRetry(server.url, dest, "dep", noBackoff, undefined, sha256Of(BODY));
  expect(readFileSync(dest, "utf8")).toBe(BODY);
});

describe("prebuilt tarballs", () => {
  const TARBALL = "tag/bun-webkit-linux-amd64.tar.gz";
  const GENERATORS = "tag/bun-webkit-aot-sources.tar.gz";
  const archive = (from: string, files: Record<string, string> = {}) =>
    new Bun.Archive({ "bun-webkit/from": from, ...files }, { compress: "gzip" }).bytes();

  /** A release that serves `assets`, and two ways to fetch TARBALL from it. */
  function release(assets: Record<string, Uint8Array>) {
    const dir = tempDir("build-prebuilt-sha256", {});
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname.slice(1);
        requests.push(path);
        return path in assets ? new Response(assets[path]) : new Response(null, { status: 404 });
      },
    });
    const cache = join(String(dir), "cache");
    const dest = join(cache, "webkit");
    const prefetch = join(String(dir), "prefetch");
    const write = (path: string, contents: string | Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    return {
      requests,
      url: (path: string) => server.url.href + path,
      /** Which archive is unpacked. Undefined: the cache has nothing in it at all. */
      unpacked: () =>
        existsSync(cache) && readdirSync(cache).length > 0 ? readFileSync(join(dest, "from"), "utf8") : undefined,
      prefetchFile: (path: string, bytes: Uint8Array, pinned = false) =>
        write(pinned ? prefetchPathForSha256(sha256Of(bytes), prefetch)! : prefetchPathForUrl(server.url.href + path, prefetch)!, bytes),
      prefetchTree(identity: string, from: string, checkedAgainst?: Uint8Array) {
        if (checkedAgainst) write(join(prefetch, "extracted", "webkit", ".sha256"), sha256Of(checkedAgainst) + "\n");
        write(join(prefetch, "extracted", "webkit", ".identity"), identity + "\n");
        write(join(prefetch, "extracted", "webkit", "from"), from);
      },
      fetchPrebuilt: (pinned: Uint8Array | undefined) =>
        withLogCaptured(() =>
          fetchPrebuilt("WebKit", server.url.href + TARBALL, dest, "tag", pinned && sha256Of(pinned)),
        ),
      /** The command ninja runs. */
      async fetch(pinned: Record<string, Uint8Array> | undefined, { generatorsOnly = false } = {}) {
        // The source owner selects the archive and literal digest before invoking the CLI.
        const path = generatorsOnly ? GENERATORS : TARBALL;
        const digest = pinned === undefined ? "-" : pinned[path] ? sha256Of(pinned[path]) : "";
        await using proc = Bun.spawn({
          cmd: [
            bunExe(),
            join(import.meta.dir, "../../scripts/build/fetch-cli.ts"),
            ...["prebuilt", "WebKit", Buffer.from(server.url.href + path).toString("base64url"), dest, "tag", digest],
          ],
          env: {
            ...bunEnv,
            BUN_BUILD_PREFETCH_DIR: prefetch,
            BUN_WEBKIT_GENERATORS_ONLY: generatorsOnly ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        return { error: stderr.split("\n")[0], exitCode };
      },
      async [Symbol.asyncDispose]() {
        await server.stop(true);
        dir[Symbol.dispose]();
      },
    };
  }
  const ok = { error: "", exitCode: 0 };

  test("unpacks the pinned tarball, once", async () => {
    const good = await archive("good");
    await using r = release({ [TARBALL]: good });

    await r.fetchPrebuilt(good);
    await r.fetchPrebuilt(good);
    expect(r.unpacked()).toBe("good");
    expect(r.requests).toEqual([TARBALL]);
  });

  test("replaces a tree that was unpacked unchecked, or checked against another pin", async () => {
    const [second, third] = await Promise.all([archive("second"), archive("third")]);
    const first = await archive("first", { "bun-webkit/.sha256": sha256Of(second) + "\n" });
    const assets = { [TARBALL]: first };
    await using r = release(assets);

    await r.fetchPrebuilt(undefined);
    expect(r.unpacked()).toBe("first");
    assets[TARBALL] = second;
    await r.fetchPrebuilt(second);
    expect(r.unpacked()).toBe("second");
    assets[TARBALL] = third;
    await r.fetchPrebuilt(third);
    expect(r.unpacked()).toBe("third");
  });

  test("a fetch without pins has a separate cache identity", async () => {
    const [good, evil] = await Promise.all([archive("good"), archive("evil")]);
    const assets = { [TARBALL]: good };
    await using r = release(assets);

    await r.fetchPrebuilt(good);
    assets[TARBALL] = evil;
    await r.fetchPrebuilt(undefined);
    expect(r.unpacked()).toBe("evil");
    expect(r.requests).toEqual([TARBALL, TARBALL]);
  });

  test.concurrent("does not unpack another tarball", async () => {
    const [good, evil] = await Promise.all([archive("good"), archive("evil")]);
    await using r = release({ [TARBALL]: evil });

    expect(await r.fetch({ [TARBALL]: good })).toEqual({
      error: `error: ${r.url(TARBALL)}: sha256 is ${sha256Of(evil)}, expected ${sha256Of(good)}`,
      exitCode: 1,
    });
    expect(r.unpacked()).toBeUndefined();
  });

  test.concurrent("rejects an invalid literal digest before downloading", async () => {
    const good = await archive("good");
    await using r = release({ [TARBALL]: good });

    expect(await r.fetch({ [`old-${TARBALL}`]: good })).toEqual({
      error: "error: prebuilt: invalid SHA-256",
      exitCode: 1,
    });
    expect(r.requests).toEqual([]);
  });

  test.concurrent("verifies the archive instead of trusting a stamped prefetch tree", async () => {
    const good = await archive("good");
    await using r = release({ [TARBALL]: good });
    r.prefetchTree(`tag:sha256:${sha256Of(good)}`, "prefetched", good);

    expect(await r.fetch({ [TARBALL]: good })).toEqual(ok);
    expect(r.unpacked()).toBe("good");
    expect(r.requests).toEqual([TARBALL]);
  });

  test.concurrent("takes the pinned tarball from the prefetch cache", async () => {
    const good = await archive("good");
    await using r = release({});
    r.prefetchFile(TARBALL, good, true);

    expect(await r.fetch({ [TARBALL]: good })).toEqual(ok);
    expect(r.unpacked()).toBe("good");
    expect(r.requests).toEqual([]);
  });

  test.concurrent("passes over what the prefetch cache has that is not the pinned tarball", async () => {
    const [good, evil] = await Promise.all([archive("good"), archive("evil")]);
    await using r = release({ [TARBALL]: good });
    r.prefetchFile(TARBALL, evil);
    r.prefetchTree("tag", "unchecked");

    expect(await r.fetch({ [TARBALL]: good })).toEqual(ok);
    expect(r.unpacked()).toBe("good");
    expect(r.requests).toEqual([TARBALL]);
  });

  test.concurrent("unpacks the pinned generators", async () => {
    const [good, generators] = await Promise.all([archive("good"), archive("generators")]);
    const assets = { [TARBALL]: good, [GENERATORS]: generators };
    await using r = release(assets);

    expect(await r.fetch(assets, { generatorsOnly: true })).toEqual(ok);
    expect(r.unpacked()).toBe("generators");
  });

  test.concurrent("does not unpack other generators, or fall back to the tarball", async () => {
    const [good, generators, evil] = await Promise.all([archive("good"), archive("generators"), archive("evil")]);
    await using r = release({ [TARBALL]: good, [GENERATORS]: evil });

    expect(await r.fetch({ [TARBALL]: good, [GENERATORS]: generators }, { generatorsOnly: true })).toEqual({
      error: `error: ${r.url(GENERATORS)}: sha256 is ${sha256Of(evil)}, expected ${sha256Of(generators)}`,
      exitCode: 1,
    });
    expect(r.unpacked()).toBeUndefined();
  });

  test.concurrent("a missing explicitly selected generator archive does not fall back", async () => {
    await using r = release({ [TARBALL]: await archive("unchecked") });

    const result = await r.fetch(undefined, { generatorsOnly: true });
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Prebuilt WebKit is not published at that URL");
    expect(r.unpacked()).toBeUndefined();
    expect(r.requests).toEqual([GENERATORS]);
  });

  test.concurrent("an invalid generator digest does not fall back to the main archive", async () => {
    const [good, evil] = await Promise.all([archive("good"), archive("evil")]);
    await using r = release({ [TARBALL]: good, [GENERATORS]: evil });

    expect(await r.fetch({ [TARBALL]: good }, { generatorsOnly: true })).toEqual({
      error: "error: prebuilt: invalid SHA-256",
      exitCode: 1,
    });
    expect(r.unpacked()).toBeUndefined();
    expect(r.requests).toEqual([]);
  });
});

/** What ensureWindowsSysroot() reads of a CI build for Windows on `host`, with no sysroot on the machine. */
function windowsCrossConfig(root: string, host: Pick<Config["host"], "os" | "arch">) {
  return {
    windows: true,
    arch: "x64",
    ci: true,
    host: { ...host, exeSuffix: "" },
    cacheDir: join(root, "cache"),
    winsysroot: join(root, "sysroot"),
  };
}

test("an xwin archive whose sha256 is not the pinned one is not unpacked", async () => {
  using dir = tempDir("build-xwin-sha256", {});
  const root = String(dir);
  const cfg = windowsCrossConfig(root, { os: "linux", arch: "x64" });

  // The download is served from the prefetch directory: an archive with the release's layout and other bytes.
  const release = `xwin-${XWIN_VERSION}-x86_64-unknown-linux-musl`;
  const url = `https://github.com/Jake-Shadle/xwin/releases/download/${XWIN_VERSION}/${release}.tar.gz`;
  const prefetch = join(root, "prefetch");
  const prefetched = prefetchPathForUrl(url, prefetch)!;
  mkdirSync(dirname(prefetched), { recursive: true });
  writeFileSync(prefetched, await new Bun.Archive({ [`${release}/xwin`]: "" }, { compress: "gzip" }).bytes());

  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `import { ensureWindowsSysroot } from ${JSON.stringify(join(import.meta.dir, "../../scripts/build/winsysroot.ts"))};
       await ensureWindowsSysroot(${JSON.stringify(cfg)});`,
    ],
    env: { ...bunEnv, BUN_BUILD_PREFETCH_DIR: prefetch },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toContain(`expected ${pins.windowsSysroot.xwinSha256.x64}`);
  expect(readdirSync(cfg.cacheDir)).toEqual([]);
  expect(exitCode).not.toBe(0);
});

test("a host xwin has no release for is told so", async () => {
  using dir = tempDir("build-xwin-host", {});
  const cfg = windowsCrossConfig(String(dir), { os: "darwin", arch: "aarch64" });

  const err = await rejection(ensureWindowsSysroot(cfg as Config));

  expect(err).toBeInstanceOf(BuildError);
  expect((err as BuildError).message).toBe("No xwin release for host darwin-aarch64");
});
