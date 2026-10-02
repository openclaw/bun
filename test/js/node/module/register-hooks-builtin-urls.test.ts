import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import path from "node:path";

const replacements = [
  "ffi",
  "ws",
  "undici",
  "node-fetch",
  "isomorphic-fetch",
  "@vercel/fetch",
  "utf-8-validate",
  "abort-controller",
  "ws/lib/websocket",
  "abort-controller/polyfill",
  "next/dist/compiled/ws",
  "next/dist/compiled/node-fetch",
  "next/dist/compiled/undici",
];
const cases: [string, string, string, string][] = [];
for (const specifier of ["ws", "ffi"]) {
  for (const method of ["require", "import"]) {
    for (const behavior of ["deregister-resolve", "deregister-load"]) {
      cases.push([specifier, method, "missing", behavior]);
    }
  }
}
cases.push(["ws", "require", "installed", "tsconfig"], ["ws", "import", "installed", "tsconfig"]);
cases.push(["ws", "require", "installed", "conditions"], ["ws", "import", "installed", "conditions"]);
for (const specifier of replacements) {
  for (const method of ["require", "import"]) {
    for (const installed of ["installed", "missing"]) {
      for (const behavior of ["defer", "override", "load-only", "no-hooks"]) {
        cases.push([specifier, method, installed, behavior]);
      }
    }
  }
}
for (const specifier of ["bun", "sys", "node:sys", "internal/test/binding", "internal/validators"]) {
  for (const method of ["require", "import"]) {
    for (const behavior of ["defer", "override"]) cases.push([specifier, method, "missing", behavior]);
  }
}
for (const installed of ["installed", "missing"]) {
  cases.push(["ws", "require", installed, "roundtrip"]);
  cases.push(["ws", "require", installed, "imports"]);
  cases.push(["ws", "import", installed, "imports"]);
}

test.each(cases)("%s %s (%s, %s) supplies consistent hook URLs", async (specifier, method, installed, behavior) => {
  using root = tempDir("hook-builtin-url", {});
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "--expose-internals",
      path.join(import.meta.dir, "register-hooks-builtin-urls.fixture.mjs"),
      specifier,
      method,
      installed,
      behavior,
      String(root),
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ exit, stderr, result: JSON.parse(stdout).ok }).toEqual({ exit: 0, stderr: "", result: true });
});
