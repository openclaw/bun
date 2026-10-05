#!/usr/bin/env python3
"""Build one frozen Bun revision with three published engines; retain all raw results."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

SOURCE = "0e6a7b354732a887a937f396db1283b8a1bd644e"
ARMS = ["42ab", "641c", "f1e1"]
parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--measure-only", action="store_true")
parser.add_argument("--runner-env", action="store_true")
args = parser.parse_args()
source = args.source.resolve()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
inputs = Path(__file__).resolve().parent.parent
env = os.environ.copy()
env.update(BUN_RUNTIME_TRANSPILER_CACHE_PATH="0", BUN_DEBUG_QUIET_LOGS="1")
env["PATH"] = "/opt/homebrew/opt/rustup/bin:" + env["PATH"]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(cmd, log, required=True):
    start = time.time()
    with (output / log).open("w") as stream:
        result = subprocess.run(cmd, cwd=source, env=env, stdout=stream, stderr=subprocess.STDOUT)
    print(json.dumps({"command": cmd, "log": log, "exit": result.returncode, "seconds": time.time()-start}), flush=True)
    if required and result.returncode:
        raise RuntimeError(f"Command failed: {log}")
    return result.returncode

head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
assert head == SOURCE, head
test = source / "test/js/node/vm/script-leak.test.ts"
original = test.read_text()
pin = source / "scripts/build/deps/webkit-artifacts.json"
original_pin = pin.read_bytes()
metadata = {"source": head, "platform": platform.platform(), "machine": platform.machine(), "test_sha256": digest(test), "arms": {}}
try:
    if args.measure_only:
        metadata = json.loads((output / "metadata.json").read_text())
        assert metadata["source"] == head
        assert metadata["test_sha256"] == digest(test)
        for arm in ARMS:
            manifest = inputs / "manifests" / f"{arm}.json"
            saved = metadata["arms"][arm]
            assert saved["binary_sha256"] == digest(output / f"bun-{arm}")
            assert saved["manifest_sha256"] == digest(manifest)
            assert saved["engine"] == json.loads(manifest.read_text())["version"]
    else:
        for arm in ARMS:
            # The shared-Mac 25 GiB floor does not apply to GitHub's smaller runner disks.
            minimum_free = 8 if env.get("GITHUB_ACTIONS") == "true" else 25
            assert shutil.disk_usage(source).free > minimum_free * 1024**3, f"Less than {minimum_free} GiB free"
            manifest = inputs / "manifests" / f"{arm}.json"
            pin.write_bytes(manifest.read_bytes())
            run(["bun", "run", "build:release", "--lto=off"], f"build-{arm}.log")
            binary = output / f"bun-{arm}"
            shutil.copy2(source / "build/release/bun", binary)
            profile = source / "build/release/bun-profile"
            if profile.exists() and not env.get("CI"):
                shutil.copy2(profile, output / f"bun-profile-{arm}")
            metadata["arms"][arm] = {"binary_sha256": digest(binary), "manifest_sha256": digest(manifest), "engine": json.loads(manifest.read_text())["version"]}
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2))
finally:
    pin.write_bytes(original_pin)

if args.runner_env:
    env.update(BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING="1", BUN_GARBAGE_COLLECTOR_LEVEL="1", BUN_JSC_randomIntegrityAuditRate="1.0", BUN_ENABLE_CRASH_REPORTING="0", BUN_DISABLE_SLOW_FILESYSTEM_WARNING="1")
(output / "measurement-environment.json").write_text(json.dumps({"platform": platform.platform(), "machine": platform.machine(), "runner_env": args.runner_env, "runtime_environment": {key: env.get(key) for key in ["BUN_GARBAGE_COLLECTOR_LEVEL", "BUN_JSC_randomIntegrityAuditRate", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"]}}, indent=2))
observed = source / "test/js/node/vm/w179-observed.test.ts"
assert not observed.exists()
observed.write_text(original.replace("    // ASAN's quarantine", '    console.log("W179_RSS " + JSON.stringify({ initialUsage, finalUsage, megabytes }));\n    // ASAN\'s quarantine'))
try:
    # Rotate order so warm caches and host drift are not confounded with the engine.
    for rep in range(12):
        for arm in ARMS[rep % 3:] + ARMS[:rep % 3]:
            exe = str(output / f"bun-{arm}")
            for kind, fixture in [("original", test), ("observed", observed)]:
                log = f"{kind}-{arm}-{rep:02}.log"
                run([exe, "--expose-internals", "test", str(fixture), "--timeout", "90000"], log, required=False)
                if kind == "observed":
                    rows = [line.removeprefix("W179_RSS ") for line in (output / log).read_text().splitlines() if line.startswith("W179_RSS ")]
                    assert len(rows) == 1, f"Missing or duplicate RSS measurement: {log}"
                    assert all(isinstance(json.loads(rows[0])[key], (int, float)) for key in ["initialUsage", "finalUsage", "megabytes"])
    for rep in range(3):
        for arm in ARMS[rep:] + ARMS[:rep]:
            run([str(output / f"bun-{arm}"), str(inputs / "scripts/retained.ts")], f"retained-{arm}-{rep}.json")
    for arm in ARMS:
        run([str(output / f"bun-{arm}"), str(inputs / "scripts/retained.ts"), "--retain"], f"positive-{arm}.json")
finally:
    observed.unlink()
assert digest(test) == metadata["test_sha256"]
