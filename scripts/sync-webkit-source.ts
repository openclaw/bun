import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const bunRepo = dirname(import.meta.dir);
const webkitRepo = join(bunRepo, "vendor/WebKit");
if (!existsSync(webkitRepo)) {
  console.log("could not find WebKit clone");
  console.log("clone https://github.com/openclaw/WebKit.git to vendor/WebKit");
  console.log("or create a symlink/worktree to an existing clone");
  process.exit(1);
}

process.chdir(webkitRepo);
const checkedOutCommit = (await Bun.$`git rev-parse HEAD`.text()).trim();
// config.ts and deps/webkit.ts import each other; evaluating config.ts first
// matches the build's entry order so WEBKIT_VERSION initializes before use.
await import("./build/config.ts");
const { WEBKIT_VERSION } = await import("./build/deps/webkit.ts");

// Resolve the commit pinned by the committed OpenClaw artifact manifest.
async function resolveToSha(): Promise<string> {
  const out = await Bun.$`git rev-parse --verify ${WEBKIT_VERSION}^{commit}`.quiet().nothrow();
  return out.exitCode === 0 ? out.text().trim() : "";
}

let expectedSha = await resolveToSha();
if (!expectedSha) {
  await Bun.$`git fetch --tags origin`;
  expectedSha = await resolveToSha();
}
if (!expectedSha) {
  console.log(`could not resolve ${WEBKIT_VERSION} in vendor/WebKit even after fetching`);
  console.log("check that the commit or tag exists on https://github.com/openclaw/WebKit");
  process.exit(1);
}

if (checkedOutCommit === expectedSha) {
  console.log(`already at ${WEBKIT_VERSION} (${expectedSha})`);
} else {
  console.log(`changing from ${checkedOutCommit} to ${WEBKIT_VERSION} (${expectedSha})`);
  // it is OK that this leaves you with a detached HEAD
  await Bun.$`git checkout ${expectedSha}`;
}
