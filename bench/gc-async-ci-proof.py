"""Temporary Linux-only proof; this diagnostic branch must never be merged."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import zipfile

checkout = Path.cwd()
source = checkout / "source"
root = checkout / "proof"
root.mkdir()
(root / "home").mkdir(mode=0o700)
(root / "tmp").mkdir(mode=0o700)
head = "3f65cff0d2c2fbdae7921634fa0724c633c8b6bd"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() == head
hashes = {
    "artifacts/baseline/bun-linux-x64.zip": "5b17f7c554d7669c0a9253f5aa2e56c205a1a84c5ef136433b1a1717083f39ab",
    "artifacts/candidate/bun-linux-x64.zip": "7215831627f3eb225fa1a1757a23456f686d5a0aa94100b5740812dec7dd3393",
    "artifacts/control/bun-linux-x64.zip": "85a265a2533d3c960caf1f3ccd73f1a269aeb88e3831ec0b4b04c9c3f924d82f",
    "source/bench/gc-async-stack.mjs": "09db8a7bee4be019544abc9af6159f739e0866148860dbd59784680ffe77101b",
    "source/test/js/node/worker_threads/worker_threads.test.ts": "2c246a36b6f09dd1c593450b0d160af991d666b9b4f76ff02dd22fe96e8d73fc",
}
for name, expected in hashes.items():
    assert hashlib.sha256((checkout / name).read_bytes()).hexdigest() == expected, name
(root / "input-hashes.json").write_text(json.dumps(hashes, indent=2) + "\n")
env = {**os.environ, "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"), "CI": "true", "NO_COLOR": "1"}
for key in ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_WEBKIT_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"]:
    env.pop(key, None)
binaries = {}
identities = {}
for label, revision, engine in [
    ("baseline", "6aba42d75d4bcee905087fa518cb2df6ff49bb0d", "419b5a0470fc059a610e98697691bf6f7cedd841"),
    ("candidate", head, "b82bc917e99110b61c3a21202d6def7457aa194c"),
    ("control", "6b7c19f0db6b3cadfa02391c553919ad6c1409da", "b82bc917e99110b61c3a21202d6def7457aa194c"),
]:
    with zipfile.ZipFile(checkout / "artifacts" / label / "bun-linux-x64.zip") as archive:
        archive.extractall(root / label)
    exe = root / label / "bun-linux-x64" / "bun"
    exe.chmod(0o755)
    binaries[label] = str(exe)
    identity = json.loads(subprocess.check_output(
        [str(exe), "-p", "JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,arch:process.arch})"], env=env, text=True))
    assert identity == {"revision": revision, "webkit": engine, "arch": "x64"}
    identities[label] = {**identity, "sha256": hashlib.sha256(exe.read_bytes()).hexdigest()}
(root / "identities.json").write_text(json.dumps(identities, indent=2) + "\n")
with (root / "cost.log").open("w") as log:
    cost = subprocess.run(["node", str(checkout / "bench/gc-async-calibrated.mjs"), binaries["baseline"], binaries["candidate"], str(root / "results"), binaries["control"]], env=env, stdout=log, stderr=log)
(root / "cost-exit.json").write_text(json.dumps({"exitCode": cost.returncode}) + "\n")
print((root / "cost.log").read_text(), flush=True)
out = root / "surrounding"
out.mkdir()
target = "test/js/node/worker_threads/worker_threads.test.ts"
commands = [("immediate-gc-" + str(i), [target, "-t", "wakes a parked worker for an immediate GC timer"]) for i in range(1, 11)]
files = []
for directory in ["test/js/node/worker_threads", "test/js/node/timers", "test/js/node/timers.promises", "test/js/web/timers"]:
    files += [str(p.relative_to(source)) for p in (source / directory).iterdir() if ".test." in p.name and p.is_file()]
assert len(files) == 22
commands += [(name, [name]) for name in sorted(files)]
rows = []
for i, (label, args) in enumerate(commands):
    dest = out / str(i)
    dest.mkdir()
    (dest / "home").mkdir(mode=0o700)
    (dest / "tmp").mkdir(mode=0o700)
    test_env = {**env, "HOME": str(dest / "home"), "TMPDIR": str(dest / "tmp"),
                "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "BUN_ENABLE_CRASH_REPORTING": "0",
                "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1", "BUN_DEBUG_QUIET_LOGS": "1",
                "BUN_DISABLE_SLOW_FILESYSTEM_WARNING": "1", "BUN_GARBAGE_COLLECTOR_LEVEL": "1",
                "BUN_JSC_randomIntegrityAuditRate": "1.0", "GITHUB_ACTIONS": "true"}
    start = time.monotonic()
    with (dest / "test.log").open("w") as log:
        proc = subprocess.Popen([binaries["candidate"], "test", *args], cwd=source, env=test_env, stdout=log, stderr=log, start_new_session=True)
        try:
            code = proc.wait(timeout=180)
        except subprocess.TimeoutExpired:
            code = "harness_timeout"
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
    row = {"label": label, "args": args, "exitCode": code, "seconds": time.monotonic() - start, "log": str(dest / "test.log")}
    rows.append(row)
    (out / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(json.dumps(row), flush=True)
assert cost.returncode == 0, "Cost gate failed; retain results without retries"
assert all(row["exitCode"] == 0 for row in rows), "Surrounding failure; retain logs without retries"
