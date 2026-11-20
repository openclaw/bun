#!/usr/bin/env python3
"""Export ICU from the matched WebKit recipe without building WebKit itself."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


MARKER = "# Copy WebKit source and build."
TARGET = "source-pair-icu"
LIBRARIES = ("libicudata.a", "libicui18n.a", "libicuuc.a")


def export_recipe(recipe):
    if recipe.count(MARKER) != 1:
        raise ValueError("WebKit Dockerfile must have one ICU/WebKit boundary")
    return recipe.split(MARKER)[0] + f"""FROM scratch AS {TARGET}
COPY --from=lane /output/include/unicode /include/unicode
COPY --from=lane /output/lib/libicudata.a /output/lib/libicui18n.a /output/lib/libicuuc.a /lib/
"""


def export_command(command, dockerfile):
    if command[:3] != ["docker", "buildx", "build"] or command[-1] != ".":
        raise ValueError("Unexpected WebKit lane build command")
    if command.count("-f") != 1 or command.count("--target=artifact") != 1:
        raise ValueError("WebKit lane must name one Dockerfile and artifact target")
    result = command.copy()
    result[result.index("-f") + 1] = str(dockerfile)
    result[result.index("--target=artifact")] = f"--target={TARGET}"
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--webkit", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    root, output = args.webkit.resolve(), args.output.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        raise ValueError("Expected a full WebKit commit SHA")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if actual != args.sha:
        raise ValueError("WebKit checkout does not match the requested commit")
    inputs = ["Dockerfile", ".github/scripts/lanes.mjs", "icu"]
    subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *inputs], cwd=root, check=True)
    if output.exists() and any(output.iterdir()):
        raise ValueError("ICU output directory must be empty")
    source = json.loads((root / "icu/source.json").read_text())
    recipe = export_recipe((root / "Dockerfile").read_text())
    command = json.loads(subprocess.check_output([
        "node", ".github/scripts/lanes.mjs", "build", "bun-webkit-linux-amd64-lto-aot",
        "--output", str(output), "--dry-run",
    ], cwd=root, text=True))
    with tempfile.TemporaryDirectory(prefix="source-pair-icu-") as temporary:
        dockerfile = Path(temporary) / "Dockerfile"
        dockerfile.write_text(recipe)
        subprocess.run(export_command(command, dockerfile), cwd=root, check=True)

    header = output / "include/unicode/uvernum.h"
    match = re.search(r'^#define U_ICU_VERSION "([^"]+)"', header.read_text(), re.MULTILINE)
    if not match or match[1] != source["version"]:
        raise ValueError("Exported ICU version does not match WebKit's source pin")
    archives = [output / "lib" / name for name in LIBRARIES]
    if any(not archive.is_file() or not archive.stat().st_size for archive in archives):
        raise ValueError("ICU export is missing a static library")
    symbols = subprocess.check_output([
        "llvm-nm", "--defined-only", str(output / "lib/libicudata.a"),
    ], text=True)
    for symbol in (f"icudt{source['version'].split('.')[0]}_dat", "bun_icu_zstd_dict"):
        if not re.search(r"\b" + re.escape(symbol) + r"\b", symbols):
            raise ValueError(f"ICU export is missing {symbol}")
    tracked = subprocess.check_output([
        "git", "ls-files", "-z", "--", *inputs,
    ], cwd=root).decode().split("\0")
    evidence = {
        "webkit_sha": actual,
        "icu_version": source["version"],
        "icu_source_sha256": source["sha256"],
        "recipe_sha256": hashlib.sha256(recipe.encode()).hexdigest(),
        "inputs": {name: digest(root / name) for name in tracked if name},
        "outputs": {str(path.relative_to(output)): digest(path) for path in [header, *archives]},
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(f"Verified matched ICU {source['version']} with compressed data")


if __name__ == "__main__":
    main()
