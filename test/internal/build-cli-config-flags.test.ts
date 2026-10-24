/**
 * `scripts/build.ts` config flags: every `PartialConfig` field is a `--flag`, parsed by the kind the field's type
 * gives it. Driven through the script itself; each case ends in argument parsing, before anything is configured.
 */
import { expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconfigureCodegen } from "../../scripts/build/configure.ts";
import { readManifest } from "../../scripts/build/ninja.ts";

const buildScript = join(import.meta.dirname, "..", "..", "scripts", "build.ts");

async function build(...args: string[]): Promise<{ stderr: string; exitCode: number }> {
  await using proc = Bun.spawn({
    cmd: [bunExe(), buildScript, ...args],
    env: bunEnv,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  return { stderr, exitCode };
}

test.concurrent.each(["abc", "", "-1", "0x1c", "1e1", "2.5"])(
  "a number field takes a non-negative decimal integer, not %j",
  async value => {
    const { stderr, exitCode } = await build(`--android-api-level=${value}`);
    expect(stderr).toBe(`error: --android-api-level takes a non-negative integer, got: ${JSON.stringify(value)}\n`);
    expect(exitCode).toBe(1);
  },
);

test.concurrent("an unknown field is an error that lists the fields", async () => {
  const { stderr, exitCode } = await build("--ltoo=on");
  expect(stderr).toContain("Unknown config field: --ltoo");
  expect(stderr).toContain("hint: Known fields: ");
  for (const field of ["lto", "androidApiLevel", "freebsdVersion", "nodejsV8Version"]) {
    expect(stderr).toMatch(new RegExp(`Known fields: .*\\b${field}\\b`));
  }
  expect(exitCode).toBe(1);
});

test.concurrent("every spelling of a field is accepted", async () => {
  // Flags are parsed left to right; `--help` prints the usage and exits 0 once everything before it parsed.
  const { stderr, exitCode } = await build(
    "--freebsd-version=14.3",
    "--nodejsV8Version=13.6.233.10",
    "--android-api-level=28",
    "--lto=off",
    "--help",
  );
  expect(stderr).toStartWith("Usage: bun scripts/build.ts");
  expect(exitCode).toBe(0);
});

test.skipIf(isWindows || Bun.which("ninja") === null)(
  "external build reconfiguration stays with its source checkout",
  async () => {
    using dir = tempDir("build-reconfigure-source", {
      "package.json": JSON.stringify({ name: "bun", private: true }),
    });
    const buildDir = join(String(dir), "build 'quoted' $literal");
    mkdirSync(buildDir, { recursive: true });
    await reconfigureCodegen({ overrides: { mode: "codegen", buildDir } });
    const manifest = join(buildDir, "build.ninja");
    const expanded = Bun.spawnSync([Bun.which("ninja")!, "-f", manifest, "-t", "commands", "-s", "build.ninja"], {
      cwd: buildDir,
      env: bunEnv,
    });
    expect(expanded.stderr.toString()).toBe("");
    expect(expanded.exitCode).toBe(0);
    const regenerated = Bun.spawnSync(["/bin/sh", "-c", expanded.stdout.toString()], { cwd: buildDir, env: bunEnv });
    expect(regenerated.stderr.toString()).toBe("");
    expect(regenerated.exitCode).toBe(0);
    const regen = readManifest(readFileSync(manifest, "utf8")).edges.find(edge => edge.rule === "regen")!;
    expect(regen.implicitInputs.map(path => resolve(buildDir, path))).toContain(
      join(process.cwd(), "scripts", "build", "flags.ts"),
    );
  },
);
