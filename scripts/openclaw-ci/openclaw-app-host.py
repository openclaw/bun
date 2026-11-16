"""Build exact-source assets and invoke the canonical disposable macOS app host."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import runpy
import shutil
import signal
import subprocess
import tempfile


CANDIDATE = "4ea5babab09c338812ae50dbcdaed990f48cd0fc"
FILTERS = ("BundledRecoveryCompositionTests/`ordinary retry`",
           "ClientCredentialStartupCompositionTests", "BundledRecoveryCompositionTests/relaunch")
# Three native 600s test limits plus 15m for package/runtime staging and owner cleanup.
APP_HOST_BUDGET = 45 * 60
common = runpy.run_path(str(Path(__file__).with_name("openclaw-repin-regression.py")))


def summarize_events(text, expected_filter):
    functions, started, completed = set(), set(), set()
    ended = skipped = issues = 0
    for line in text.splitlines():
        record = json.loads(line)
        if record.get("kind") not in ("test", "event"):
            continue
        assert record["version"] == "6.3.0"
        payload = record["payload"]
        kind = payload["kind"]
        if record["kind"] == "test" and kind == "function" and expected_filter in payload["id"]:
            functions.add(payload["id"])
        elif record["kind"] == "event":
            test_id = payload.get("testID")
            if kind == "testStarted" and test_id in functions:
                started.add(test_id)
            elif kind == "testEnded" and test_id in started:
                completed.add(test_id)
            ended += kind == "runEnded"
            skipped += kind in ("testSkipped", "testCancelled")
            issues += kind == "issueRecorded"
    return {"filter": expected_filter, "functions": sorted(functions), "started": sorted(started),
            "completed": sorted(completed), "runEnded": ended, "skippedOrCancelled": skipped,
            "recordedIssues": issues}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--controller-sha", required=True)
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    assert out.is_dir(), "metadata admission must finish first"
    root = Path(tempfile.mkdtemp(prefix="openclaw-app-host-"))
    node = Path(shutil.which("node")).resolve()
    env = common["private_env"](root / "build", str(node.parent) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    redact = lambda text: text.replace(str(root), "<private-build>").replace(str(source), "<openclaw-source>").replace(str(account_home), "<disposable-account-home>")
    report = {"source": CANDIDATE, "controller": args.controller_sha, "status": "INCONCLUSIVE",
              "scope": "three focused bundled app-host filters; not the full Swift suite",
              "settlementUncertain": False, "preparation": [], "phases": [],
              "cacheProfile": "cold private build caches",
              "stateDisposition": "native owner cleanup; remaining scratch retained for hosted runner teardown"}

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

    def checked(command, label, timeout, command_env=None):
        report["settlementUncertain"] = True
        outcome = common["run"](command, source, command_env or env, out / (label + ".log"),
                                redact, timeout, output_limit=8 * 1024 * 1024)
        report["preparation"].append({"step": label, "budgetSeconds": timeout, **outcome})
        report["settlementUncertain"] = outcome["settlementUncertain"] or outcome["exitCode"] != 0
        save()
        assert not report["settlementUncertain"], label + " failed; no app-host product verdict"

    save()
    try:
        assert (platform.system(), platform.machine()) == ("Darwin", "arm64")
        assert tuple(map(int, platform.mac_ver()[0].split(".")[:2])) >= (26, 2)
        assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        assert "BUN_RELEASE_METADATA_TOKEN" not in os.environ
        assert os.getuid() != 0 and account_home.is_dir() and account_home.stat().st_uid == os.getuid()
        assert git("rev-parse", "HEAD") == CANDIDATE
        assert git("-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD") == args.controller_sha
        assert not git("status", "--porcelain", "--untracked-files=no")
        candidate_bytes = (source / common["PIN"]).read_bytes()
        old_bytes = (git("show", common["BASE"] + ":" + common["PIN"]) + "\n").encode()
        pins = {"old": json.loads(old_bytes), "new": json.loads(candidate_bytes)}
        binding = {"source": CANDIDATE, "controller": args.controller_sha,
                   "sourceTree": git("rev-parse", "HEAD^{tree}"), "baselineSource": common["BASE"],
                   "pinSHA256": {"old": hashlib.sha256(old_bytes).hexdigest(),
                                 "new": hashlib.sha256(candidate_bytes).hexdigest()}}
        metadata = common["read_admission_receipt"](out / "metadata-admission.json", binding, pins)
        report.update(binding=binding, release=metadata["releases"]["new"],
                      metadataSHA256=common["sha"](out / "metadata-admission.json"))
        for key in ("SDKROOT", "TOOLCHAINS", "DYLD_FRAMEWORK_PATH", "DYLD_LIBRARY_PATH", "RUNNER_TRACKING_ID"):
            if os.environ.get(key):
                env[key] = os.environ[key]
        assert env.get("RUNNER_TRACKING_ID"), "missing hosted orphan-cleanup correlation"
        env["DEVELOPER_DIR"] = "/Applications/Xcode.app/Contents/Developer"
        checked(["/bin/bash", "-c", "set -euo pipefail; source scripts/lib/swift-toolchain.sh; select_xcode_toolchain; require_swift_toolchain"], "toolchain", 120)
        for tool in ("security", "launchctl", "xcrun", "codesign", "otool", "install_name_tool"):
            assert shutil.which(tool, path=env["PATH"]), "missing native tool: " + tool
        for command in (["launchctl", "print", "gui/" + str(os.getuid())], ["security", "list-keychains", "-d", "user"]):
            subprocess.run(command, env={**env, "HOME": str(account_home)}, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        assert subprocess.check_output([str(node), "--version"], env=env, text=True, timeout=30).strip() == "v24.22.1"
        report["host"] = {"runnerClass": "github-hosted xcode-27", "os": platform.mac_ver()[0],
                          "arch": platform.machine(), "cores": os.cpu_count(), "node": "v24.22.1",
                          "canonicalAccountHomeAdmitted": True, "guiDomainAndUserKeychainAvailable": True}
        package = json.loads((source / "package.json").read_text())
        assert package["packageManager"].startswith("pnpm@12.15.0+sha512.")
        env.update(COREPACK_HOME=str(root / "corepack"), COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
                   PNPM_CONFIG_FROZEN_LOCKFILE="true", OPENCLAW_BUN_CACHE_ROOT=str(root / "bun-archives"))
        bin_dir = root / "bin"
        bin_dir.mkdir(mode=0o700)
        checked(["corepack", "enable", "--install-directory", str(bin_dir)], "corepack-enable", 60)
        env["PATH"] = str(bin_dir) + ":" + env["PATH"]
        checked(["corepack", "prepare", package["packageManager"], "--activate"], "corepack-prepare", 120)
        checked(["/bin/bash", ".github/actions/setup-node-env/install-dependencies.sh"], "dependencies", 1200,
                {**env, "NODE_BIN": str(node.parent), "FROZEN_LOCKFILE": "true", "DEPENDENCY_CACHE": "false", "DEPENDENCY_CACHE_HIT": "false"})
        checked([str(node), "scripts/prepare-apple-mermaid.mjs"], "mermaid", 600)
        checked(["swift", "build", "--package-path", "apps/macos", "--build-system", "native",
                 "--enable-code-coverage", "--disable-index-store", "-Xswiftc", "-gline-tables-only", "--build-tests"], "swift-build", 2100)
        report["runtimeBuildProfile"] = "canonical private macOS app: pnpm build with OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1"
        checked(["pnpm", "build"], "runtime-build", 2100,
                {**env, "NODE_OPTIONS": "--max-old-space-size=8192", "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD": "1"})
        build = json.loads((source / "dist/build-info.json").read_text())
        assert build["commit"] == CANDIDATE
        report["buildInfo"] = build
        assert not git("status", "--porcelain", "--untracked-files=no")
        app_temp = root / "app-host-temp"
        app_temp.mkdir(mode=0o700)
        app_env = {key: value for key, value in env.items() if key != "OPENCLAW_STATE_DIR"}
        app_env.update(HOME=str(account_home), USERPROFILE=str(account_home), RUNNER_TEMP=str(app_temp),
                       RUNNER_OS="macOS", GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted")
        report.update(buildEnvironmentKeys=sorted(env), appHostEnvironmentKeys=sorted(app_env), settlementUncertain=True)
        save()
        outcome = common["run"](["/bin/bash", "scripts/test-macos-app-host.sh"], source, app_env,
                                out / "app-host.log", redact, APP_HOST_BUDGET, output_limit=16 * 1024 * 1024)
        report["nativeOutcome"] = outcome
        report["appHostBudgetSeconds"] = APP_HOST_BUDGET
        report["settlementUncertain"] = outcome["settlementUncertain"]
        assert not report["settlementUncertain"], "native settlement uncertain; retain state for runner teardown"
        log = (out / "app-host.log").read_text()
        report["settlementUncertain"] = any(marker in log for marker in (
            "test Gateway retirement is unverified", "retained resources after incomplete launch/cleanup",
        ))
        assert not report["settlementUncertain"], "native resource retirement unverified; retain state for runner teardown"
        diagnostics = list(app_temp.glob("openclaw-recovery-events-*"))
        assert len(diagnostics) <= 1, "unexpected extra native app-host invocation"
        event_texts = []
        if diagnostics:
            assert diagnostics[0].is_dir() and not diagnostics[0].is_symlink()
            for number, expected_filter in enumerate(FILTERS):
                events = diagnostics[0] / f"phase-{number}-events.jsonl"
                if events.is_file() and not events.is_symlink():
                    assert events.stat().st_size <= common["LIMIT"]
                    text = events.read_text()
                    (out / events.name).write_text(redact(text))
                    event_texts.append((text, expected_filter))
        report["phases"] = [summarize_events(text, expected_filter) for text, expected_filter in event_texts]
        runtimes = [json.loads(line) for line in log.splitlines() if line.startswith('{"architecture":')]
        report["canonicalBundledRuntimeVerification"] = runtimes
        if outcome["exitCode"] != 0:
            report.update(status="FAIL", failureStage="native-test-or-cleanup" if event_texts else "app-host-stage-or-launch")
            raise AssertionError("canonical app host failed")
        assert len(report["phases"]) == 3 and all(
            phase["completed"] and phase["started"] == phase["completed"] and phase["runEnded"] == 1
            and phase["skippedOrCancelled"] == phase["recordedIssues"] == 0
            for phase in report["phases"]), "incomplete or nonpassing native app-host phases"
        assert {p.name for p in diagnostics[0].iterdir()} == {f"phase-{i}-events.jsonl" for i in range(3)}
        assert "Staged OpenClaw Bun " + pins["new"]["tag"] + " [darwin arm64]" in log
        assert runtimes and all(row["architecture"] == "arm64" and row["revision"] == pins["new"]["revision"]
                                and all(row["build"][key] == build[key] for key in ("version", "commit", "builtAt", "buildId")) for row in runtimes)
        report.update(status="PASS", canonicalStagerVerifiedArtifact=pins["new"]["artifacts"]["darwin-arm64"])
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        if report["settlementUncertain"]:
            report["stateDisposition"] = "retained for hosted runner teardown; native settlement unverified"
        report["trackedSourceClean"] = not git("status", "--porcelain", "--untracked-files=no")
        if not report["trackedSourceClean"]:
            report["status"] = "INCONCLUSIVE"
        save()
        assert report["trackedSourceClean"], "tracked source changed"


if __name__ == "__main__":
    main()
