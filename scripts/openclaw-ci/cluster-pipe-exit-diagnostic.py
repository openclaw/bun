"""Observe the original cluster fixture; this does not qualify a native suite."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import tempfile
import time


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ("native", "stock", "source", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    native = args.native.resolve()
    stock = args.stock.resolve()
    out = args.out.resolve()
    out.mkdir()
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    tree = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD^{tree}"], text=True
    ).strip()
    assert revision == "a75d9fc1e8132c88c525f32fbc9a1da6767206bc"
    assert tree == "cc3029841eb0506d15c55fe583c8e6a457573b4d"
    test = source / "test/js/node/cluster.test.ts"
    assert sha(test) == "0bd1825487bb418cf54203a2f134634d0d039c02d6b903b8fa05443405a87809"
    text = test.read_text()
    text = text[text.index("round-robin pipe listen applies readableAll/writableAll") :]
    fixture = re.search(r'"main.ts": `([\s\S]*?)`', text).group(1)
    assert "\\" not in fixture and "${" not in fixture
    fixture_sha = hashlib.sha256(fixture.encode()).hexdigest()
    assert fixture_sha == "836e813c162677bd9d17f09796e115ef95b803901ec177201a2c4d218df3b736"
    report = {
        "diagnosticComplete": False,
        "shippingArchiveQualified": False,
        "source": revision,
        "tree": tree,
        "controller": os.environ["GITHUB_SHA"],
        "nativeInputRun": 43731013867,
        "nativeInputArtifact": 14168969043,
        "fixtureSHA256": fixture_sha,
        "identities": {},
        "trials": [],
    }

    def save():
        data = json.dumps(report, indent=2) + "\n"
        assert len(data.encode()) <= 1024 * 1024
        (out / "report.json").write_text(data)

    save()
    try:
        with tempfile.TemporaryDirectory(prefix="cluster-pipe-exit-") as scratch:
            root = Path(scratch)
            home = root / "home"
            home.mkdir()
            env = {
                "PATH": os.environ["PATH"],
                "HOME": str(home),
                "TMPDIR": scratch,
                "BUN_TMPDIR": scratch,
                "TEST_TMPDIR": scratch,
                "BUN_INSTALL_CACHE_DIR": scratch,
                "LANG": "C.UTF-8",
                "TZ": "Etc/UTC",
                "CI": "1",
                "GITHUB_ACTIONS": "false",
                "NO_COLOR": "1",
                "BUN_DEBUG_QUIET_LOGS": "1",
                "BUN_DISABLE_SLOW_FILESYSTEM_WARNING": "1",
                "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1",
                "BUN_GARBAGE_COLLECTOR_LEVEL": "1",
                "BUN_JSC_randomIntegrityAuditRate": "1.0",
                "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                "BUN_ENABLE_CRASH_REPORTING": "0",
            }
            report["environment"] = {
                "gcLevel": "1",
                "integrityAuditRate": "1.0",
                "transpilerCache": "0",
                "credentialsInChildEnvironment": False,
            }
            for label, binary in (("candidate", native), ("stock", stock)):
                identity = json.loads(subprocess.check_output(
                    [str(binary), "-e", "console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch,version:Bun.version}))"],
                    env=env, text=True, timeout=10,
                ))
                assert identity["platform"] == "darwin" and identity["arch"] == "arm64"
                if label == "candidate":
                    assert identity["revision"] == "55284cc25ad430f9bbc46a4923ea120dd4dea637"
                    assert identity["webkit"] == "3357f9d63e6dd87a53f2aade723482130a55c0cd"
                else:
                    assert identity["version"] == "1.4.4"
                report["identities"][label] = identity | {
                    "sha256": sha(binary), "bytes": binary.stat().st_size,
                }
            save()
            # Paired fixed trials capture an intermittent exit; no handlers rescue it.
            for index in range(20):
                for label, binary in (("candidate", native), ("stock", stock)):
                    trial = root / f"{label}-{index + 1}"
                    trial.mkdir()
                    entry = trial / "main.ts"
                    entry.write_text(fixture)
                    before = resource.getrusage(resource.RUSAGE_CHILDREN)
                    started = time.monotonic()
                    process = subprocess.Popen(
                        [str(binary), str(entry)], cwd=trial, env=env,
                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, start_new_session=True,
                    )
                    timed_out = False
                    try:
                        stdout, stderr = process.communicate(timeout=10)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                    finally:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        stdout, stderr = process.communicate()
                    after = resource.getrusage(resource.RUSAGE_CHILDREN)
                    assert len(stdout) + len(stderr) <= 65536
                    stdout = stdout.decode(errors="replace").replace(scratch, "<fixture>")
                    stderr = stderr.decode(errors="replace").replace(scratch, "<fixture>")
                    row = {
                        "runtime": label, "trial": index + 1,
                        "exitCode": process.returncode if process.returncode >= 0 else None,
                        "signal": -process.returncode if process.returncode < 0 else None,
                        "timedOut": timed_out, "stdout": stdout, "stderr": stderr,
                        "elapsedSeconds": round(time.monotonic() - started, 4),
                        "childUserSeconds": round(after.ru_utime - before.ru_utime, 4),
                        "childSystemSeconds": round(after.ru_stime - before.ru_stime, 4),
                    }
                    row["originalAssertionsPass"] = (
                        not timed_out and process.returncode == 0
                        and "perm bits: 66" in stdout and "worker exit: 0" in stdout
                    )
                    report["trials"].append(row)
                    save()
                    if timed_out:
                        raise RuntimeError("diagnostic trial exceeded its outer 10-second cap")
            report["diagnosticComplete"] = True
            report["failures"] = {
                label: sum(not row["originalAssertionsPass"] for row in report["trials"] if row["runtime"] == label)
                for label in ("candidate", "stock")
            }
            print(json.dumps({"diagnosticComplete": True, "failures": report["failures"], "shippingArchiveQualified": False}))
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
