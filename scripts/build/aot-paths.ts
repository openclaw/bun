import { configOf } from "./configure.ts";
import { webkitAotFile, webkitJSCPath, webkitTestAotPath } from "./deps/webkit.ts";
import { BuildError } from "./error.ts";

function parseConfig(args: string[]) {
  let profile = "debug";
  let webkit: "local" | "prebuilt" | undefined;
  for (const arg of args) {
    if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (arg === "--webkit=local" || arg === "--webkit=prebuilt") {
      webkit = arg === "--webkit=local" ? "local" : "prebuilt";
    } else {
      console.error("usage: bun scripts/build/aot-paths.ts [--profile=<name>] [--webkit=local|prebuilt]");
      process.exit(1);
    }
  }
  return { profile, overrides: webkit === undefined ? {} : { webkit } };
}

// stdout is read as NAME=<path> lines ($GITHUB_ENV, `export $(..)`), and resolving the toolchain can console.log.
console.log = console.error;

try {
  const { cfg } = configOf(parseConfig(process.argv.slice(2)));
  const paths = {
    TESTAOT: webkitTestAotPath(cfg),
    JSC: webkitJSCPath(cfg),
    AOT_SCHEMA: webkitAotFile(cfg, "AOTSchema.def"),
    AOT_BUILTINS_GENERATED: webkitAotFile(cfg, "builtins-generated"),
    AOT_ENGINE_DIRECTORY: webkitAotFile(cfg, "directory"),
  };
  for (const [name, path] of Object.entries(paths)) process.stdout.write(`${name}=${path}\n`);
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  process.stderr.write(error.format());
  process.exit(1);
}
