import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync } from "fs";
import { bunEnv, bunExe, tempDir, tmpdirSync } from "harness";
import { join, parse } from "path";

// OpenClaw fork policy: auto-install is disabled unless explicitly enabled.
//   -i                              Auto-install dependencies during execution. Equivalent to --install=fallback.

describe("basic autoinstall", () => {
  for (const install of ["", "-i", "--install=auto", "--install=fallback", "--install=force"]) {
    for (const has_node_modules of [true, false]) {
      let should_install = false;
      if (has_node_modules) {
        if (install === "" || install === "--install=auto") {
          should_install = false;
        } else {
          should_install = true;
        }
      } else {
        should_install = install !== "";
      }

      test(`${install || "<no flag>"} ${has_node_modules ? "with" : "without"} node_modules ${should_install ? "should" : "should not"} autoinstall`, async () => {
        const dir = tmpdirSync();
        mkdirSync(dir, { recursive: true });
        await Bun.write(join(dir, "index.js"), "import isEven from 'is-even'; console.log(isEven(2));");
        const env = bunEnv;
        env.BUN_INSTALL = install;
        if (has_node_modules) {
          mkdirSync(join(dir, "node_modules/abc"), { recursive: true });
        }
        const { stdout, stderr } = Bun.spawnSync({
          cmd: [bunExe(), ...(install === "" ? [] : [install]), join(dir, "index.js")],
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });

        if (should_install) {
          expect(stderr?.toString("utf8")).not.toContain("error: Cannot find package 'is-even'");
          expect(stdout?.toString("utf8")).toBe("true\n");
        } else {
          expect(stderr?.toString("utf8")).toContain("error: Cannot find package 'is-even'");
        }
      });
    }
  }
});

// In auto-install mode the project's own package.json is the lockfile's root
// package (resolution tag `root`, not `npm`). With a name and an exact version
// present, resolving any missing bare specifier used to read that resolution
// through the npm union accessor: "assertion failed: self.tag == Tag::Npm".
test("auto-install in a project whose package.json has a name and version", async () => {
  const requests: string[] = [];
  using registry = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return new Response("not found", { status: 404 });
    },
  });

  using dir = tempDir("autoinstall-root-name-version", {
    "package.json": JSON.stringify({ name: "myapp", version: "1.0.0" }),
    "index.js": `import "pkg-that-does-not-exist-anywhere";\n`,
    "bunfig.toml": `[install]\nregistry = "http://127.0.0.1:${registry.port}/"\n`,
  });

  await using proc = Bun.spawn({
    // OpenClaw fork policy: opt in to exercise the auto-install resolver.
    cmd: [bunExe(), "--install=auto", "index.js"],
    cwd: String(dir),
    env: { ...bunEnv, BUN_INSTALL_CACHE_DIR: join(String(dir), ".bun-cache") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  // The resolver must get as far as asking the (local) registry for the
  // missing package, then report it as missing instead of dying while
  // re-parsing the project's own package.json.
  expect(requests).toContain("/pkg-that-does-not-exist-anywhere");
  expect(stderr).toContain("Cannot find package 'pkg-that-does-not-exist-anywhere'");
  expect(exitCode).toBe(1);
});

test("--install=fallback to install missing packages", async () => {
  const dir = tmpdirSync();
  mkdirSync(dir, { recursive: true });
  await Promise.all([
    Bun.write(
      join(dir, "index.js"),
      "import isEven from 'is-even'; import isOdd from 'is-odd'; console.log(isEven(2), isOdd(2));",
    ),
    Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test",
        dependencies: {
          "is-odd": "1.0.0",
        },
      }),
    ),
  ]);

  Bun.spawnSync({
    cmd: [bunExe(), "install"],
    cwd: dir,
    env: bunEnv,
  });

  const { stdout, stderr } = Bun.spawnSync({
    cmd: [bunExe(), "--install=fallback", join(dir, "index.js")],
    cwd: dir,
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(stderr?.toString("utf8")).not.toContain("error: Cannot find package 'is-odd'");
  expect(stdout?.toString("utf8")).toBe("true false\n");
});

const probePackage = "oc-nonexistent-probe-pkg-7731";

function isolatedRuntimeEnv(dir: string, registry: string) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return {
    ...bunEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    BUN_INSTALL: join(home, ".bun"),
    BUN_INSTALL_CACHE_DIR: join(home, "cache"),
    BUN_TMPDIR: dir,
    TMPDIR: dir,
    TEMP: dir,
    BUN_OPTIONS: undefined,
    NODE_OPTIONS: undefined,
    BUN_CONFIG_REGISTRY: registry,
    NPM_CONFIG_REGISTRY: registry,
  };
}

async function probeRegistry(requests: string[]) {
  const pkg = { name: probePackage, version: "1.0.0", main: "index.js", bin: { [probePackage]: "cli.js" } };
  const tarball = await new Bun.Archive(
    {
      "package/package.json": JSON.stringify(pkg),
      "package/index.js": `module.exports = "installed";`,
      "package/cli.js": `#!/usr/bin/env bun\nconsole.log("explicit package command");\n`,
    },
    { compress: "gzip" },
  ).bytes();
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      requests.push(`${req.method} ${path}`);
      if (path === `/${probePackage}/-/probe.tgz`) return new Response(tarball);
      if (path === `/${probePackage}`) {
        return Response.json({
          name: probePackage,
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { ...pkg, dist: { tarball: `${server.url}${probePackage}/-/probe.tgz` } } },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("OpenClaw runtime auto-install defaults off", () => {
  for (const cwdKind of ["root", "node_modules", "plain"]) {
    for (const entry of ["import", "worker", "child"]) {
      test.concurrent(`${entry} from ${cwdKind} reports module-not-found without registry requests`, async () => {
        const requests: string[] = [];
        using registry = await probeRegistry(requests);
        using dir = tempDir("runtime-no-auto-install", {
          "plugins/plugin.mjs": `import "${probePackage}";`,
          "import.mjs": `
            try { await import("./plugins/plugin.mjs"); }
            catch (error) { console.log(error.code); process.exitCode = 1; }
          `,
          "worker.mjs": `
            import { Worker } from "node:worker_threads";
            const worker = new Worker(new URL("./plugins/plugin.mjs", import.meta.url));
            worker.on("error", error => { console.log(error.code); process.exitCode = 1; });
          `,
          "child.mjs": `
            import { spawnSync } from "node:child_process";
            import { fileURLToPath } from "node:url";
            const child = spawnSync(process.execPath, [fileURLToPath(new URL("./import.mjs", import.meta.url))], { stdio: "inherit" });
            if (child.error) throw child.error;
            process.exitCode = child.status ?? 2;
          `,
          "lib/node_modules/openclaw/.keep": "",
          "state/.keep": "",
        });
        const cwd =
          cwdKind === "root"
            ? parse(String(dir)).root
            : join(String(dir), cwdKind === "node_modules" ? "lib/node_modules/openclaw" : "state");
        await using proc = Bun.spawn({
          cmd: [bunExe(), join(String(dir), `${entry}.mjs`)],
          cwd,
          env: isolatedRuntimeEnv(String(dir), registry.url.href),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect(requests).toEqual([]);
        expect(stdout).toBe("ERR_MODULE_NOT_FOUND\n");
        expect(stderr).toBe("");
        expect(exitCode).toBe(1);
      });
    }
  }

  for (const setting of [
    "--install=auto",
    "--install=fallback",
    "--install=force",
    "-i",
    "bunfig=auto",
    "bunfig=fallback",
    "bunfig=force",
    "bunfig=true",
  ]) {
    test.concurrent(`${setting} explicitly enables runtime installation`, async () => {
      const requests: string[] = [];
      using registry = await probeRegistry(requests);
      using dir = tempDir("runtime-auto-install-opt-in", {
        "index.js": `import value from "${probePackage}"; console.log(value);`,
        ...(setting.startsWith("bunfig=")
          ? {
              "bunfig.toml": `[install]\nauto = ${setting === "bunfig=true" ? "true" : JSON.stringify(setting.slice(7))}\n`,
            }
          : {}),
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), ...(setting.startsWith("bunfig=") ? [] : [setting]), "index.js"],
        cwd: String(dir),
        env: isolatedRuntimeEnv(String(dir), registry.url.href),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toBe("installed\n");
      expect(stderr).toBe("");
      expect(requests).toContain(`GET /${probePackage}`);
      expect(requests).toContain(`GET /${probePackage}/-/probe.tgz`);
      expect(exitCode).toBe(0);
    });
  }

  test.concurrent("--no-install overrides an explicit bunfig opt-in", async () => {
    const requests: string[] = [];
    using registry = await probeRegistry(requests);
    using dir = tempDir("runtime-no-install-override", {
      "index.js": `import "${probePackage}";`,
      "bunfig.toml": '[install]\nauto = "force"\n',
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--no-install", "index.js"],
      cwd: String(dir),
      env: isolatedRuntimeEnv(String(dir), registry.url.href),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(requests).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toContain(`Cannot find package '${probePackage}'`);
    expect(exitCode).toBe(1);
  });

  for (const command of ["install", "add", "x", "bunx"]) {
    test.concurrent(`explicit ${command} still installs packages`, async () => {
      const requests: string[] = [];
      using registry = await probeRegistry(requests);
      using dir = tempDir("runtime-explicit-package-command", {
        "package.json": JSON.stringify({
          private: true,
          ...(command === "install" ? { dependencies: { [probePackage]: "1.0.0" } } : {}),
        }),
      });
      const env = isolatedRuntimeEnv(String(dir), registry.url.href);
      let cmd = [bunExe(), command, ...(command === "install" ? [] : [probePackage])];
      if (command === "bunx") {
        const alias = join(String(dir), process.platform === "win32" ? "bunx.exe" : "bunx");
        copyFileSync(bunExe(), alias);
        chmodSync(alias, 0o755);
        cmd = [alias, probePackage];
      }
      await using proc = Bun.spawn({ cmd, cwd: String(dir), env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      if (command === "install" || command === "add") {
        expect(stdout).toContain(`${probePackage}@1.0.0`);
        expect(await Bun.file(join(String(dir), "node_modules", probePackage, "index.js")).text()).toContain(
          "installed",
        );
      } else {
        expect(stdout).toBe("explicit package command\n");
      }
      expect(stderr).not.toContain("error:");
      expect(requests).toContain(`GET /${probePackage}`);
      expect(requests).toContain(`GET /${probePackage}/-/probe.tgz`);
      expect(exitCode).toBe(0);
    });
  }
});
