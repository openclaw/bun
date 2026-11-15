"""Run the committed cluster regressions on admitted pre-fix and repaired binaries."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import xml.etree.ElementTree as ET


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ("baseline", "fixed", "source", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--fixed-artifact", type=int, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    out = args.out.resolve()
    out.mkdir()
    report = {"diagnosticComplete": False, "shippingArchiveQualified": False, "runs": []}

    def save():
        data = json.dumps(report, indent=2) + "\n"
        assert len(data.encode()) <= 1024 * 1024
        (out / "report.json").write_text(data)

    save()
    try:
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        tree = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD^{tree}"], text=True).strip()
        assert revision == "9c4e2b1f426f7e938c18ed2a7ace5d17d68c55fa"
        assert tree == "6c2389ca16899c716070fae66ad103986a438147"
        test = "test/js/node/cluster.test.ts"
        assert sha(source / test) == "7e61aacd0f5ab92f2efc4c2260e787f1965d29a280991c1d72da06577267eba0"
        names = [
            "worker.disconnect() keeps IPC connected until active connections drain",
            "worker.disconnect() still closes IPC for an entry that never loads cluster",
        ]
        pattern = r"^worker[.]disconnect[(][)] (?:keeps IPC connected until active connections drain|still closes IPC for an entry that never loads cluster)$"
        report.update({
            "source": revision, "tree": tree, "testSHA256": sha(source / test),
            "controller": os.environ["GITHUB_SHA"],
            "baselineRun": 43731013867, "baselineArtifact": 14168969043,
            "fixedRun": 43739822593, "fixedArtifact": args.fixed_artifact,
            "credentialsInChildEnvironment": False,
        })
        with tempfile.TemporaryDirectory(prefix="cluster-drain-regression-") as scratch:
            root = Path(scratch)
            home = root / "home"
            home.mkdir()
            env = {
                "PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": scratch,
                "BUN_TMPDIR": scratch, "TEST_TMPDIR": scratch, "BUN_INSTALL_CACHE_DIR": scratch,
                "LANG": "C.UTF-8", "TZ": "Etc/UTC", "CI": "1", "GITHUB_ACTIONS": "false",
                "NO_COLOR": "1", "BUN_DEBUG_QUIET_LOGS": "1",
                "BUN_DISABLE_SLOW_FILESYSTEM_WARNING": "1", "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1",
                "BUN_GARBAGE_COLLECTOR_LEVEL": "1", "BUN_JSC_randomIntegrityAuditRate": "1.0",
                "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "BUN_ENABLE_CRASH_REPORTING": "0",
            }

            def redact(text):
                for path in (scratch, str(source.parent)):
                    text = text.replace(path, "<diagnostic>")
                return text

            for label, binary, expected_revision in (
                ("baseline", args.baseline.resolve(), "55284cc25ad430f9bbc46a4923ea120dd4dea637"),
                ("fixed", args.fixed.resolve(), "fe6297f8aeb9fb8f9ef1d55a49d054528c68f90c"),
            ):
                identity = json.loads(subprocess.check_output([
                    str(binary), "-e",
                    "console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))",
                ], env=env, text=True, timeout=10))
                assert identity["revision"] == expected_revision
                assert identity["webkit"] == "3357f9d63e6dd87a53f2aade723482130a55c0cd"
                assert identity["platform"] == "darwin" and identity["arch"] == "arm64"
                junit = root / (label + ".xml")
                proc = subprocess.Popen([
                    str(binary), "test", test, "--test-name-pattern", pattern,
                    "--reporter=junit", "--reporter-outfile=" + str(junit),
                ], cwd=source, env=env, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    stdout, stderr = proc.communicate(timeout=90)
                finally:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    stdout, stderr = proc.communicate()
                assert len(stdout) + len(stderr) <= 1024 * 1024
                assert junit.stat().st_size <= 1024 * 1024
                cases = []
                for case in ET.parse(junit).getroot().iter("testcase"):
                    if case.get("name") in names:
                        cases.append({
                            "name": case.get("name"), "skipped": case.find("skipped") is not None,
                            "failed": case.find("failure") is not None or case.find("error") is not None,
                            "detail": redact("".join(case.itertext()))[:16000],
                        })
                report["runs"].append({
                    "runtime": label, "identity": identity, "sha256": sha(binary),
                    "bytes": binary.stat().st_size, "exitCode": proc.returncode,
                    "stdout": redact(stdout.decode(errors="replace"))[-24000:],
                    "stderr": redact(stderr.decode(errors="replace"))[-24000:],
                    "junitSHA256": sha(junit), "cases": cases,
                })
                save()
                assert sorted(case["name"] for case in cases) == sorted(names), "two exact committed cases must execute"
                assert not any(case["skipped"] for case in cases)
                failures = {case["name"] for case in cases if case["failed"]}
                assert failures == ({names[0]} if label == "baseline" else set())
                assert proc.returncode == (1 if label == "baseline" else 0)
            assert subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True) == ""
            report["diagnosticComplete"] = True
            print(json.dumps({"diagnosticComplete": True, "baselineFailed": names[0], "fixedPassed": names}))
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
