#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends cmake ninja-build nasm ccache golang-go python3-fuse
# Render only the canonical x64 LLVM installer; do not run the machine's agent or service setup.
bun -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { generateImage, images } from "./scripts/build/ci-images/spec.ts";
  import { provisionScript } from "./scripts/openclaw-release/release.ts";
  const image = images.find(image => image.os === "linux" && image.arch === "x64" && image.distro === "debian");
  if (!image) throw new Error("Missing canonical Linux x64 image");
  const { directory } = generateImage(image, process.cwd());
  writeFileSync(join(process.env.RUNNER_TEMP, "openclaw-llvm.sh"), provisionScript(readFileSync(join(directory, "bootstrap.sh"), "utf8"), ["llvm"]));
'
sudo sh "$RUNNER_TEMP/openclaw-llvm.sh" "$GITHUB_SHA" openclaw-native
# Tool discovery prefers system LLVM locations before PATH; bind every tool to the admitted archive.
echo "BUN_TOOLCHAIN_LLVM=$LLVM_DIRECTORY" >> "$GITHUB_ENV"
echo "$LLVM_DIRECTORY/bin" >> "$GITHUB_PATH"
"$LLVM_DIRECTORY/bin/clang" --version
"$LLVM_DIRECTORY/bin/ld.lld" --version
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal
echo "RUSTUP_TOOLCHAIN=$RUST_TOOLCHAIN" >> "$GITHUB_ENV"
df -h /
