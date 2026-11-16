"""Replay reviewed canonical CI groups in independent hosted old/new Bun jobs."""

import argparse
import difflib
import hashlib
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


CANDIDATE = "4ea5babab09c338812ae50dbcdaed990f48cd0fc"
GROUPS = ("large10", "large5", "small4", "large2", "large42_storage", "large42_process")
INVITATION_FILE = "src/config/sessions/session-mention-invitation.test.ts"
INVITATION_SOURCE_SHA256 = "a3fe4f0f54f7daceaa7ce53e1df5525f067cb5699b0096a6c527e366b24a8cf4"
INVITATION_CALLBACK_SHA256 = "1775321fae85b26fca81575d9910aa3118e8e67955cd9d1774d8335e3f310fe7"
INVITATION_CASES = (
    *(f"commits a tag and its invitation together before any Inbox work, without regranting on reopen (first: {first})" for first in ("false", "true")),
    *(f"rolls back the tag, grant and watermark when commit authority changes (first: {first})" for first in ("false", "true")),
    "keeps each first-session message's own watermark when invitations are deferred until session creation",
    "does not grant access when a message hook removes the selected token",
    "releases invitation callbacks and closes admissions after commit",
    "releases invitation callbacks and closes admissions after rollback",
)
common = runpy.run_path(str(Path(__file__).with_name("openclaw-repin-regression.py")))


def invitation_callback_bytes(original):
    assert hashlib.sha256(original).hexdigest() == INVITATION_SOURCE_SHA256
    old_import = b'import { setImmediate as nextTurn } from "node:timers/promises";'
    new_import = b'import { setImmediate as nextTurn } from "node:timers";'
    old_call = b"      await nextTurn();\n      queryObjects(WeakRef);"
    new_call = b"""      await new Promise<void>((resolve, reject) => {
        nextTurn(() => {
          try {
            queryObjects(WeakRef);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });"""
    assert original.count(old_import) == original.count(old_call) == 1
    patched = original.replace(old_import, new_import).replace(old_call, new_call)
    assert hashlib.sha256(patched).hexdigest() == INVITATION_CALLBACK_SHA256
    return patched


def invitation_observations(log, exit_code):
    rows, summaries = [], []
    prefix = "[shard:bun:core-runtime-config-hosted-3]"
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        if not line.startswith(prefix):
            continue
        body = line[len(prefix):].strip()
        if body.startswith(("Test Files ", "Tests ")):
            summaries.append(body)
        if not re.search(r"\|[^|]+\|.* >(?: |$)", body):
            continue
        match = re.fullmatch(r"(.*?)\|([^|]+)\|\s+(.+?) > (.+?)(?: \d+(?:\.\d+)?ms)?", body)
        assert match, "malformed diagnostic case row"
        assert match[2] == "runtime-config" and match[3] == INVITATION_FILE, "unexpected diagnostic file"
        assert match[4] in INVITATION_CASES, "unexpected diagnostic case"
        marker = match[1].strip()
        if marker == "FAIL":
            continue  # Native failure summaries repeat the primary case result.
        assert marker in {"✓", "√", "×", "↓"}, "unsupported diagnostic case status"
        rows.append({"file": match[3], "fullName": match[4],
                     "status": {"✓": "passed", "√": "passed", "×": "failed", "↓": "skipped"}[marker]})
    assert len(rows) == 8 and {row["fullName"] for row in rows} == set(INVITATION_CASES), "incomplete or duplicate diagnostic cases"
    assert all(row["status"] in {"passed", "failed"} for row in rows), "diagnostic case skipped"
    assert exit_code != 0 or all(row["status"] == "passed" for row in rows), "successful exit contradicts failed case"
    return {"cases": rows, "nativeSummaries": summaries}


def doctor_observations(log):
    rows = []
    for line in log.splitlines():
        match = re.match(r"^(?:\[shard:[^]]+\] )?\[doctor-causes\] (.*)$", line)
        if match:
            assert len(line.encode()) <= 64 * 1024
            rows.append(json.loads(match[1]))
    assert rows and all(row["version"] == 1 for row in rows), "observer readiness missing"
    ready = [row for row in rows if row["kind"] == "ready"]
    cases = [row for row in rows if row["kind"] == "case"]
    assert len(ready) == 1 and ready[0]["bun"] and ready[0]["bunRevision"] == common["RELEASES"]["new"][0]
    assert 1 <= len(cases) <= 2 and len(rows) == 1 + len(cases), "observer missing, incomplete or duplicated"
    assert all(row["complete"] and row["errors"] for row in cases), "incomplete observer cause tree"
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--controller-sha", required=True)
    parser.add_argument("--group", choices=GROUPS, required=True)
    parser.add_argument("--pin", choices=("old", "new"), required=True)
    parser.add_argument("--doctor-causes", action="store_true")
    parser.add_argument("--invitation-retention", action="store_true")
    parser.add_argument("--invitation-native-callback", action="store_true")
    args = parser.parse_args()
    assert not args.doctor_causes or (args.group, args.pin) == ("large5", "new")
    assert not args.invitation_retention or (args.group == "small4" and not args.doctor_causes)
    assert not args.invitation_native_callback or ((args.group, args.pin) == ("small4", "new")
                                                   and not args.doctor_causes and not args.invitation_retention)
    source, out = args.source.resolve(), args.out.resolve()
    assert out.is_dir(), "metadata admission must finish first"
    root = Path(tempfile.mkdtemp(prefix="openclaw-linux-repin-"))
    node = Path(shutil.which("node")).resolve()
    env = common["private_env"](root / "control", str(node.parent) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    redact = lambda text: text.replace(str(root), "<private-cell>").replace(str(source), "<openclaw-source>").replace(str(Path(__file__).resolve().parents[2]), "<diagnostic-controller>")
    report = {"source": CANDIDATE, "controller": args.controller_sha, "group": args.group,
              "pin": args.pin, "status": "INCONCLUSIVE", "settlementUncertain": False,
              "stateDisposition": "retained-for-hosted-runner-teardown", "preparation": [],
              "cacheProfile": "cold-private-caches; original CI cache restore status unknown"}
    if args.doctor_causes or args.invitation_retention or args.invitation_native_callback:
        report.update(diagnosticOnly=True, qualifiesRepin=False)
    candidate_bytes = None
    original_test_bytes = None
    deadline = time.monotonic() + 75 * 60

    def save():
        data = redact(json.dumps(report, indent=2) + "\n")
        assert len(data.encode()) <= common["LIMIT"]
        (out / "report.json").write_text(data)

    def interrupt(signum, frame):
        report["settlementUncertain"] = True
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def git(*arguments):
        return subprocess.check_output(["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
                                        "-c", "core.hooksPath=/dev/null", "-C", str(source), *arguments],
                                       env=env, text=True, timeout=120).strip()

    def checked(command, label, command_env=None, timeout=600):
        report["settlementUncertain"] = True
        result = common["run"](command, source, command_env or env, out / (label + ".log"), redact,
                               min(timeout, max(1, deadline - time.monotonic())))
        report["preparation"].append({"step": label, **result})
        report["settlementUncertain"] = result["settlementUncertain"] or result["exitCode"] != 0
        save()
        assert not report["settlementUncertain"], label + " failed; state retained for runner teardown"

    save()
    try:
        assert (platform.system(), platform.machine()) == ("Linux", "x86_64")
        assert "BUN_RELEASE_METADATA_TOKEN" not in os.environ
        assert git("rev-parse", "HEAD") == CANDIDATE
        assert git("-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD") == args.controller_sha
        assert not git("status", "--porcelain", "--untracked-files=no")
        pin_path = source / common["PIN"]
        candidate_bytes = pin_path.read_bytes()
        old_bytes = (git("show", common["BASE"] + ":" + common["PIN"]) + "\n").encode()
        pins = {"old": json.loads(old_bytes), "new": json.loads(candidate_bytes)}
        binding = {"source": CANDIDATE, "controller": args.controller_sha,
                   "sourceTree": git("rev-parse", "HEAD^{tree}"), "baselineSource": common["BASE"],
                   "pinSHA256": {"old": hashlib.sha256(old_bytes).hexdigest(),
                                 "new": hashlib.sha256(candidate_bytes).hexdigest()}}
        metadata = common["read_admission_receipt"](out / "metadata-admission.json", binding, pins)
        report.update(binding=binding, release=metadata["releases"][args.pin],
                      metadataSHA256=common["sha"](out / "metadata-admission.json"))
        payload_path = Path(__file__).with_name("openclaw-canonical-ci-groups.json")
        payload = json.loads(payload_path.read_text())
        assert payload["head"] == CANDIDATE and set(payload["groups"]) == set(GROUPS)
        selected = payload["groups"][args.group]
        assert selected["nativeArgv"] == ["node", "--import", "tsx", "scripts/ci-run-node-test-shard.mts"]
        group_json = json.dumps([selected["group"]], separators=(",", ":"))
        report.update(payloadSHA256=common["sha"](payload_path), originalPayloadSHA256=payload["originalPayloadSHA256"],
                      groupSHA256=hashlib.sha256(group_json.encode()).hexdigest(), selectedInput=selected)
        if args.invitation_retention or args.invitation_native_callback:
            assert len(selected["group"]["includePatterns"]) == 309 and INVITATION_FILE in selected["group"]["includePatterns"]
            effective_group = {**selected["group"], "includePatterns": [INVITATION_FILE]}
            group_json = json.dumps([effective_group], separators=(",", ":"))
            report["invitationRetention"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroup": effective_group, "effectiveGroupSHA256": hashlib.sha256(group_json.encode()).hexdigest(),
                "expectedCases": INVITATION_CASES,
                "scope": "standalone file; a pass does not explain or waive the original 309-file failure"}
        pin_path.write_bytes(old_bytes if args.pin == "old" else candidate_bytes)
        report["activePin"] = args.pin
        checked(["/bin/bash", "scripts/stage-openclaw-bun.sh", str(root / "runtime"), "linux", "x64"],
                "stage-bun", {**env, "OPENCLAW_BUN_CACHE_ROOT": str(root / "archives")})
        bun = root / "runtime/bin/bun"
        assert bun.is_file() and not bun.is_symlink()
        assert common["sha"](bun) == pins[args.pin]["artifacts"]["linux-x64"]["executableSha256"]
        report["bunSHA256"] = common["sha"](bun)
        env.update(OPENCLAW_BUN_PATH=str(bun), BUN_BIN=str(bun), PATH=str(bun.parent) + ":" + env["PATH"])
        report["settlementUncertain"] = True
        host = json.loads(subprocess.check_output([str(node), "-e",
            "console.log(JSON.stringify({node:process.version,nodePath:process.execPath,cores:require('os').availableParallelism(),memoryBytes:require('os').totalmem(),platform:process.platform,arch:process.arch}))"],
            env=env, text=True, timeout=30))
        assert host["node"] == "v24.22.1" and host["cores"] == 4
        identity = json.loads(subprocess.check_output([str(bun), "-e",
            "console.log(JSON.stringify({version:Bun.version,revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))"],
            env=env, text=True, timeout=30))
        assert identity == {"version": "1.4.4", "revision": common["RELEASES"][args.pin][0],
                            "webkit": common["RELEASES"][args.pin][2], "platform": "linux", "arch": "x64"}
        report.update(host=host, bunIdentity=identity, settlementUncertain=False)
        # The native setup writes only to a private receipt, never an Actions command file.
        semantic_env = root / "semantic-env"
        checked(["/bin/bash", ".github/actions/setup-node-env/semantic-memory.sh"], "semantic-memory",
                {**env, "GITHUB_ENV": str(semantic_env)})
        exports = {}
        for line in semantic_env.read_text().splitlines():
            key, value = line.split("=", 1)
            assert key in {"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} and key not in exports
            exports[key] = value
        runtime_dir = Path("/run/user") / str(os.getuid())
        assert exports["XDG_RUNTIME_DIR"] == str(runtime_dir)
        assert runtime_dir.is_dir() and runtime_dir.stat().st_uid == os.getuid()
        assert (runtime_dir / "systemd/private").is_socket()
        if "DBUS_SESSION_BUS_ADDRESS" in exports:
            assert exports["DBUS_SESSION_BUS_ADDRESS"] == "unix:path=" + str(runtime_dir / "bus")
            assert (runtime_dir / "bus").is_socket()
        env.update(exports)
        package = json.loads((source / "package.json").read_text())
        assert package["packageManager"].startswith("pnpm@12.15.0+sha512.")
        env.update(COREPACK_HOME=str(root / "corepack"), COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
                   PNPM_CONFIG_FROZEN_LOCKFILE="true")
        bin_dir = root / "bin"
        bin_dir.mkdir(mode=0o700)
        checked(["corepack", "enable", "--install-directory", str(bin_dir)], "corepack-enable")
        env["PATH"] = str(bin_dir) + ":" + env["PATH"]
        checked(["corepack", "prepare", package["packageManager"], "--activate"], "corepack-prepare")
        checked(["/bin/bash", ".github/actions/setup-node-env/install-dependencies.sh"], "dependencies",
                {**env, "NODE_BIN": str(node.parent), "FROZEN_LOCKFILE": "true", "DEPENDENCY_CACHE": "false",
                 "DEPENDENCY_CACHE_HIT": "false"}, 1200)
        env.update(selected["env"])
        env.update(OPENCLAW_NODE_TEST_GROUPS_JSON=group_json, OPENCLAW_VITEST_MAX_WORKERS="3",
                   OPENCLAW_NODE_TEST_PLAN_CONCURRENCY="1", FROZEN_TARGET="false",
                   RUNNER_ENVIRONMENT="github-hosted", GITHUB_ACTIONS="true",
                   OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT=str(root / "cache/vitest"),
                   NODE_COMPILE_CACHE=str(root / "cache/node"), BUN_RUNTIME_TRANSPILER_CACHE_PATH=str(root / "cache/bun"))
        assert env["OPENCLAW_NODE_TEST_VITEST_ARGS_JSON"] == "[]"
        if args.doctor_causes:
            observer = Path(__file__).with_name("doctor-cause-reporter.mjs").resolve()
            assert observer.is_file() and not observer.is_relative_to(source)
            effective_args = ["--reporter=verbose", "--reporter=github-actions", "--reporter=" + str(observer)]
            report["observer"] = {"diagnosticOnly": True, "qualifiesRepin": False,
                                  "originalVitestArgs": [], "effectiveVitestArgs": effective_args,
                                  "sha256": common["sha"](observer)}
            env["OPENCLAW_NODE_TEST_VITEST_ARGS_JSON"] = json.dumps(effective_args)
        report.update(command=selected["nativeArgv"], childEnvironment=env)
        if args.invitation_native_callback:
            test_path = source / INVITATION_FILE
            assert test_path.is_file() and not test_path.is_symlink()
            original = test_path.read_bytes()
            patched = invitation_callback_bytes(original)
            report["testProjection"] = {"path": INVITATION_FILE, "state": "prepared",
                "originalSHA256": INVITATION_SOURCE_SHA256, "patchedSHA256": INVITATION_CALLBACK_SHA256,
                "diff": "".join(difflib.unified_diff(original.decode().splitlines(True),
                    patched.decode().splitlines(True), fromfile="a/" + INVITATION_FILE, tofile="b/" + INVITATION_FILE)),
                "scope": "one immediate and one GC per retention case; Promise/closure roots and GC/resumption ordering differ; no qualification or leak-cause verdict"}
            original_test_bytes = original
            test_path.write_bytes(patched)
            report["testProjection"]["state"] = "applied"
            assert common["sha"](test_path) == INVITATION_CALLBACK_SHA256
            assert git("diff", "HEAD", "--name-only") == INVITATION_FILE, "unexpected tracked source projection"
        remaining = deadline - time.monotonic()
        assert remaining > 0, "controller preparation exhausted the diagnostic budget"
        report["settlementUncertain"] = True
        save()
        outcome = common["run"]([str(node), *selected["nativeArgv"][1:]], source, env,
                                out / "native-shard.log", redact, remaining, output_limit=32 * 1024 * 1024)
        report["nativeOutcome"] = outcome
        assert not outcome["settlementUncertain"], "native settlement uncertain; state retained for runner teardown"
        log = (out / "native-shard.log").read_text()
        completions = [json.loads(line.removeprefix("[shard:completion] "))
                       for line in log.splitlines() if line.startswith("[shard:completion] ")]
        assert len(completions) == 1, \
            "native settlement/completion missing; state retained for runner teardown"
        completion = completions[0]
        assert completion["version"] == 1 and completion["planned"] == completion["completed"] == 1
        assert completion["invocations"] > 0 and 0 <= completion["failedInvocations"] <= completion["invocations"]
        assert (completion["failedInvocations"] == 0) == (outcome["exitCode"] == 0)
        report.update(nativeCompletion=completion, settlementUncertain=False)
        if args.invitation_retention or args.invitation_native_callback:
            report["invitationRetention"].update(invitation_observations(log, outcome["exitCode"]))
            report.update(status="DIAGNOSTIC", diagnosticNativeStatus="PASS" if outcome["exitCode"] == 0 else "FAIL")
        elif args.doctor_causes:
            report["observer"]["records"] = doctor_observations(log)
            assert outcome["exitCode"] == 1, "instrumented run did not reproduce a native failure"
            report["status"] = "DIAGNOSTIC"
        else:
            report["status"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
        raise SystemExit(outcome["exitCode"])
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        if report["settlementUncertain"]:
            report["restoration"] = "not-attempted-indeterminate-settlement"
            if original_test_bytes is not None:
                report["testProjection"]["state"] = "retained-indeterminate-settlement"
        elif candidate_bytes is not None:
            restore_allowed = original_test_bytes is None or (test_path.is_file() and not test_path.is_symlink()
                              and common["sha"](test_path) == INVITATION_CALLBACK_SHA256)
            if restore_allowed:
                if original_test_bytes is not None:
                    (source / INVITATION_FILE).write_bytes(original_test_bytes)
                    report["testProjection"].update(state="restored", restoredSHA256=common["sha"](source / INVITATION_FILE))
                    assert report["testProjection"]["restoredSHA256"] == INVITATION_SOURCE_SHA256
                (source / common["PIN"]).write_bytes(candidate_bytes)
                report["candidatePinRestored"] = (source / common["PIN"]).read_bytes() == candidate_bytes
            else:
                report["testProjection"]["state"] = "retained-unexpected-test-bytes"
                report.update(status="INCONCLUSIVE", error="diagnostic test changed unexpectedly; no restoration attempted")
            report["trackedSourceClean"] = not git("status", "--porcelain", "--untracked-files=no")
            if not report["trackedSourceClean"]:
                report.update(status="INCONCLUSIVE", error="tracked source changed")
        save()
        assert report.get("trackedSourceClean", True), "tracked source changed"


if __name__ == "__main__":
    main()
