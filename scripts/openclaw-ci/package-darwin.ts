import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bunExeName } from "../build/config.ts";
import { configOf } from "../build/configure.ts";
import { webkitAotFile, webkitJSCPath, webkitTestAotPath } from "../build/deps/webkit.ts";

// Stage the cross-built executable and its matching engine for the native macOS test job.
const { cfg } = configOf({ profile: "openclaw-native-darwin-arm64" });
const staging = resolve(cfg.cwd, "build/openclaw-ci/darwin-arm64");
const executable = resolve(cfg.buildDir, "bun");
mkdirSync(staging, { recursive: true });
for (const [source, name] of [
  [executable, "bun"],
  [resolve(cfg.buildDir, bunExeName(cfg) + ".trim"), "bun.trim"],
  [webkitJSCPath(cfg), "jsc"],
  [webkitTestAotPath(cfg), "testaot"],
  [webkitAotFile(cfg, "directory"), "aot-engine"],
] as const) {
  cpSync(source, join(staging, name), { recursive: true });
}
