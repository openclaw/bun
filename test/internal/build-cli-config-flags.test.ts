/**
 * `scripts/build.ts` config flags: every `PartialConfig` field is a `--flag`, parsed by the kind the field's type
 * gives it. Driven through the script itself; each case ends in argument parsing, before anything is configured.
 */
import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote } from "../../scripts/build/shell.ts";

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

test("regeneration keeps the source owner when the build directory belongs to another checkout", async () => {
  using dir = tempDir("build regen owner", { "package.json": JSON.stringify({ name: "bun" }) });
  const buildDir = join(String(dir), "output");
  const configured = await build("--mode=codegen", `--build-dir=${buildDir}`, "--configure-only");
  expect(configured.stderr).toContain("codegen only");
  expect(configured.exitCode).toBe(0);
  const manifest = join(buildDir, "build.ninja");
  const before = readFileSync(manifest, "utf8");
  const command = /^rule regen\n  command = (.+)$/m.exec(before)?.[1];
  expect(command).toBeDefined();
  const windows = process.platform === "win32";
  // Substitute the same relative input Ninja supplies to the old rule.
  const expanded = command!.replaceAll("$in", quote("configure.json", windows));
  await using proc = Bun.spawn({
    cmd: windows ? ["cmd", "/d", "/s", "/c", expanded] : ["sh", "-c", expanded],
    cwd: buildDir,
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(readFileSync(manifest, "utf8")).toBe(before);
});
