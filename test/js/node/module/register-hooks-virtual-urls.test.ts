import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import path from "node:path";
for (const namespace of ["w85_virtual", "123plugin", "@scoped/plugin", "bun-virtual", "bun-builtin"]) {
  for (const method of ["require", "import"]) {
    for (const behavior of [
      "defer",
      "override",
      "parent",
      "roundtrip",
      "deregister-resolve",
      "deregister-load",
      "replace-native-name",
      "direct",
      "direct-after-deregister",
      "no-hooks",
    ]) {
      test(`${namespace} ${method} ${behavior} keeps virtual hook URLs valid`, async () => {
        await using proc = Bun.spawn({
          cmd: [
            bunExe(),
            path.join(import.meta.dir, "register-hooks-virtual-urls.fixture.mjs"),
            namespace,
            method,
            behavior,
          ],
          env: bunEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect({ exit, stderr, error: JSON.parse(stdout).error }).toEqual({ exit: 0, stderr: "", error: undefined });
      });
    }
  }
}

for (const namespace of ["bun-virtual", "bun-builtin"]) {
  test(`${namespace} remains a plugin namespace without hooks`, async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        path.join(import.meta.dir, "register-hooks-virtual-urls.fixture.mjs"),
        namespace,
        "import",
        "no-hooks",
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ exit, stderr, error: JSON.parse(stdout).error }).toEqual({ exit: 0, stderr: "", error: undefined });
  });
}
