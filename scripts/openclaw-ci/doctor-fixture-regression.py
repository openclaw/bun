"""Run the reviewed Doctor fixture regression through its unchanged Node owner."""

import argparse
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request


CANDIDATE = "58778fd27ca2e8725f30a8fd5aa2da0b1b82a855"
PARENT = "43c2926ba69479fdc68f5fccb4fd3a089763c9fb"
TEST = "src/commands/doctor-maintenance.admission-warm.test.ts"
HELPER = "src/commands/doctor-maintenance.admission.test-support.ts"
SOURCE_HASHES = {
    TEST: "a87d656f5be11d0550f2bd749550ca0decb1372966787c197022ac78b46b868d",
    HELPER: "80cc7c47700e9d5e77beb98fd31ec5a73eb8d31945b24ac0dc40f4ffe0266314",
}
REGRESSION = "observes readonly worker requests without adding IPC listeners to other children"
CASES = (
    REGRESSION,
    "admits fast systemd inspection after a slow continuation write",
    *(title.replace("%s", source) for title in (
        "refuses replacement while the %s maintenance reader is bound",
        "refuses a foreign schema version change through the %s reader",
        "refuses new quarantine under the %s maintenance reader",
        "binds the reader to Doctor's %s source and drains before cold restoration",
    ) for source in ("cached-writer", "admitted-read-only")),
    *(f"observes {source} foreign commits without uncommitted rows or inherited discovery snapshots"
      for source in ("cached-writer", "admitted-read-only", "cold-read-only")),
    "refuses committed WAL updates while preserving all live source artifacts",
    "refuses a competing run after replacement of an already admitted source",
    "does not borrow a retained discovery snapshot for current admission",
    "refuses new quarantine with a cold reader and unchanged ledger bytes",
)
SIBLING_CASES = {
    "src/commands/doctor-maintenance.admission-activation.test.ts": (
        "restores within the native deadline when cold source observations cost two seconds",
        "refuses new update after the final restart ownership reply",
        "refuses revoked custody after the final restart ownership reply",
    ),
    "src/commands/doctor-maintenance.continuation-scope.test.ts": (
        "keeps Doctor continuation with its repair scope (cached writer: true)",
        "keeps Doctor continuation with its repair scope (cached writer: false)",
    ),
}
COMMAND = ["pnpm", "test", TEST, "--maxWorkers=1"]
SIBLING_COMMAND = ["pnpm", "test", *SIBLING_CASES, "--maxWorkers=1"]
common = runpy.run_path(str(Path(__file__).with_name("openclaw-repin-regression.py")))


def observations(log, exit_code, expected=None):
    expected = expected or {TEST: CASES}
    identities = {(file, name) for file, names in expected.items() for name in names}
    cases, summaries, completion = [], [], []
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw).strip()
        match = re.search(r"(?:^|\]\s*)(\S+)\s+\|([^|]+)\|\s+(\S+\.test\.ts)(?::\d+)?\s+>\s+(.+)$", line)
        if match:
            status, project, file, tail = match.groups()
            timed = re.fullmatch(r"(.+?)\s+([\d.]+)ms", tail)
            name = timed[1] if timed else tail
            assert project == "commands" and (file, name) in identities, "unexpected case identity"
            if status in {"FAIL", "stderr", "stdout"}:
                continue
            assert status in {"✓", "✔", "×", "✗"} and timed, "skipped or malformed case row"
            cases.append({"file": file, "name": name, "status": "passed" if status in {"✓", "✔"} else "failed",
                          "durationMs": float(timed[2])})
        if re.search(r"(?:^|\]\s*)(?:Test Files|Tests)\s+", line):
            summaries.append(line)
        match = re.fullmatch(r"\[test\] (passed|failed) 1 Vitest shard in .+", line)
        if match:
            completion.append(match[1])
    assert len(cases) == len(identities) and {(row["file"], row["name"]) for row in cases} == identities, "incomplete or duplicate case inventory"
    assert exit_code in (0, 1) and completion == ["passed" if exit_code == 0 else "failed"], "missing canonical completion"
    failed = sum(row["status"] == "failed" for row in cases)
    assert exit_code != 0 or failed == 0, "successful exit contradicts failed case"
    totals = [line for line in summaries if re.search(r"(?:^|\]\s*)Tests\s+", line)]
    assert len(totals) == 1, "missing or multiple native test summaries"
    counts = {status: int(count) for count, status in re.findall(r"(\d+) (passed|failed|skipped|todo)", totals[0])}
    assert counts.get("passed", 0) == len(identities) - failed and counts.get("failed", 0) == failed
    assert not counts.get("skipped", 0) and not counts.get("todo", 0) and f"({len(identities)})" in totals[0]
    return {"cases": cases, "summaries": summaries, "completion": completion[0],
            "regressionCase": next((row for row in cases if row["name"] == REGRESSION), None)}


def metadata_api(endpoint, token):
    assert endpoint in {"commits/" + CANDIDATE, "pulls/200310"} and token
    request = urllib.request.Request("https://api.github.com/repos/openclaw/openclaw/" + endpoint,
        headers={"User-Agent": "openclaw-doctor-fixture-proof", "Authorization": "Bearer " + token})
    with urllib.request.build_opener(common["NoApiRedirect"]()).open(request, timeout=60) as response:
        data = response.read(common["LIMIT"] + 1)
    assert len(data) <= common["LIMIT"], "source metadata exceeds budget"
    return json.loads(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("metadata", "execute"), required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--candidate-sha", choices=(CANDIDATE,), required=True)
    parser.add_argument("--controller-sha", required=True)
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    controller = Path(__file__).resolve().parents[2]
    assert re.fullmatch(r"[0-9a-f]{40}", args.controller_sha)
    if args.phase == "metadata":
        out.mkdir(mode=0o700)
    else:
        assert out.is_dir(), "metadata admission must finish first"
    root = Path(tempfile.mkdtemp(prefix="doctor-fixture-proof-"))
    env = common["private_env"](root / "control", os.environ["PATH"])
    redact = lambda text: text.replace(str(source), "<openclaw-source>").replace(str(controller), "<controller>").replace(str(root), "<private-cell>")
    report = {"source": CANDIDATE, "controller": args.controller_sha, "phase": args.phase,
              "status": "INCONCLUSIVE", "settlementUncertain": False, "preparation": [],
              "command": COMMAND, "runtime": "node", "expectedCases": CASES,
              "stateDisposition": "retained-for-hosted-runner-teardown"}

    def save():
        data = redact(json.dumps(report, indent=2) + "\n")
        assert len(data.encode()) <= common["LIMIT"]
        (out / "report.json").write_text(data)

    def git(*arguments):
        return subprocess.check_output(["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
            "-c", "core.hooksPath=/dev/null", "-C", str(source), *arguments], env=env, text=True, timeout=60).strip()

    def interrupt(signum, frame):
        report["settlementUncertain"] = True
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    deadline = time.monotonic() + 50 * 60

    def checked(command, label, command_env=None, timeout=120, group="preparation"):
        report["settlementUncertain"] = True
        result = common["run"](command, source, command_env or env, out / (label + ".log"), redact,
            min(timeout, max(1, deadline - time.monotonic())), output_limit=8 * 1024 * 1024)
        report.setdefault(group, []).append({"step": label, "command": command, **result})
        report["settlementUncertain"] = result["settlementUncertain"] or result["exitCode"] != 0
        save()
        assert not report["settlementUncertain"], label + " failed; state retained"

    save()
    try:
        assert (platform.system(), platform.machine()) == ("Linux", "x86_64")
        assert git("rev-parse", "HEAD") == CANDIDATE and git("rev-parse", "HEAD^") == PARENT
        assert git("-C", str(controller), "rev-parse", "HEAD") == args.controller_sha
        assert git("remote", "get-url", "origin").removesuffix(".git") == "https://github.com/openclaw/openclaw"
        assert git("diff", "HEAD^", "HEAD", "--name-only").splitlines() == [HELPER]
        assert not git("status", "--porcelain", "--untracked-files=no")
        for name, digest in SOURCE_HASHES.items():
            assert not (source / name).is_symlink() and common["sha"](source / name) == digest
        binding = {"source": CANDIDATE, "parent": PARENT, "sourceTree": git("rev-parse", "HEAD^{tree}"),
                   "controller": args.controller_sha, "sourceHashes": SOURCE_HASHES,
                   "lockSHA256": common["sha"](source / "pnpm-lock.yaml")}
        report["binding"] = binding
        metadata_path = out / "metadata-admission.json"
        if args.phase == "metadata":
            token = os.environ["OPENCLAW_SOURCE_METADATA_TOKEN"]
            commit = metadata_api("commits/" + CANDIDATE, token)
            pr = metadata_api("pulls/200310", token)
            assert commit["sha"] == CANDIDATE and [item["sha"] for item in commit["parents"]] == [PARENT]
            assert commit["commit"]["tree"]["sha"] == binding["sourceTree"]
            assert commit["commit"]["verification"]["verified"] and commit["commit"]["verification"]["reason"] == "valid"
            assert [item["filename"] for item in commit["files"]] == [HELPER]
            assert pr["state"] == "open" and pr["draft"] and pr["head"]["sha"] == CANDIDATE
            assert pr["head"]["repo"]["full_name"] == "openclaw/openclaw"
            metadata_path.write_text(json.dumps({"binding": binding, "signatureVerified": True,
                "pullRequest": "https://github.com/openclaw/openclaw/pull/200310"}, indent=2) + "\n")
            report["status"] = "SOURCE_ADMITTED"
            return
        assert "OPENCLAW_SOURCE_METADATA_TOKEN" not in os.environ
        assert metadata_path.stat().st_size <= common["LIMIT"]
        metadata = json.loads(metadata_path.read_text())
        assert metadata["binding"] == binding and metadata["signatureVerified"] is True
        report["metadataSHA256"] = common["sha"](metadata_path)
        node = Path(shutil.which("node")).resolve()
        env["PATH"] = str(node.parent) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env.update(OPENCLAW_VITEST_RUNTIME="node", OPENCLAW_VITEST_MAX_WORKERS="1",
                   OPENCLAW_TEST_PROJECTS_SERIAL="1", NODE_OPTIONS="--max-old-space-size=8192",
                   COREPACK_HOME=str(root / "corepack"), COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
                   PNPM_CONFIG_FROZEN_LOCKFILE="true")
        checked([str(node), "-e", "console.log(JSON.stringify({version:process.version,bun:process.versions.bun??null,execPath:process.execPath,platform:process.platform,arch:process.arch}))"], "node-identity", timeout=30)
        identity = json.loads((out / "node-identity.log").read_text())
        assert identity == {"version": "v24.22.1", "bun": None, "execPath": str(node), "platform": "linux", "arch": "x64"}
        report["nodeIdentity"] = {**identity, "executableSHA256": common["sha"](node)}
        package = json.loads((source / "package.json").read_text())
        assert package["scripts"]["test"] == "node scripts/test-projects.mts"
        assert package["packageManager"] == "pnpm@12.15.0+sha512.b3951d6d6ff4a9f13dc7cf56cd28d2b8eb37dbcc9c68e52e1e1191873ea9f82a017287ab50baadc5ccc494f036c67c0e47eb13608c2fa36f47711b61ea128e61"
        report["packageManager"] = package["packageManager"]
        bin_dir = root / "bin"
        bin_dir.mkdir(mode=0o700)
        checked(["corepack", "enable", "--install-directory", str(bin_dir)], "corepack-enable")
        env["PATH"] = str(bin_dir) + ":" + env["PATH"]
        checked(["corepack", "prepare", package["packageManager"], "--activate"], "corepack-prepare")
        checked(["/bin/bash", ".github/actions/setup-node-env/install-dependencies.sh"], "dependencies",
            {**env, "NODE_BIN": str(node.parent), "FROZEN_LOCKFILE": "true", "DEPENDENCY_CACHE": "false", "DEPENDENCY_CACHE_HIT": "false"}, 1200)
        report["settlementUncertain"] = True
        outcome = common["run"](COMMAND, source, env, out / "native-test.log", redact,
            min(1500, max(1, deadline - time.monotonic())), output_limit=8 * 1024 * 1024)
        report["nativeOutcome"] = outcome
        report["settlementUncertain"] = outcome["settlementUncertain"]
        assert not outcome["settlementUncertain"], "native settlement uncertain; no proof parsing"
        # A normal process exit alone does not establish the canonical completed run.
        report["settlementUncertain"] = True
        report["observations"] = observations((out / "native-test.log").read_text(), outcome["exitCode"])
        report["settlementUncertain"] = False
        if outcome["exitCode"] == 0:
            report["siblingCommand"] = SIBLING_COMMAND
            report["settlementUncertain"] = True
            sibling = common["run"](SIBLING_COMMAND, source, env, out / "sibling-tests.log", redact,
                min(1500, max(1, deadline - time.monotonic())), output_limit=8 * 1024 * 1024)
            report["siblingOutcome"] = sibling
            report["settlementUncertain"] = sibling["settlementUncertain"]
            assert not sibling["settlementUncertain"], "sibling settlement uncertain; no proof parsing"
            report["settlementUncertain"] = True
            report["siblingObservations"] = observations((out / "sibling-tests.log").read_text(),
                sibling["exitCode"], SIBLING_CASES)
            report["settlementUncertain"] = False
            if sibling["exitCode"] != 0:
                report["status"] = "FAIL"
                raise SystemExit(sibling["exitCode"])
            static_env = {**env, "CI": "false", "OPENCLAW_FORMAT_TOOL": "oxfmt",
                          "OPENCLAW_LINT_TOOL": "oxlint"}
            for command, label in (
                (["node", "scripts/run-format.mts", "--check", TEST, HELPER], "format"),
                (["node", "scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.core.json",
                  TEST, HELPER], "lint"),
                (["node", "scripts/run-tsgo.mjs", "-p",
                  "test/tsconfig/tsconfig.core.test.commands-doctor.json", "--incremental"], "doctor-types"),
            ):
                checked(command, label, static_env, timeout=600, group="staticChecks")
        report["trackedSourceClean"] = not git("status", "--porcelain", "--untracked-files=no")
        assert report["trackedSourceClean"], "source drift after native completion"
        report["status"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
        raise SystemExit(outcome["exitCode"])
    except (Exception, KeyboardInterrupt) as error:
        report.update(status="INCONCLUSIVE", error=type(error).__name__ + ": " + str(error))
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
