"""Compare a reviewed current OpenClaw regression set on two published Bun pins."""

import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request


BASE = "7e48c6be722ae307f8e47f258e2294ef5f3c2da5"
PIN = "scripts/lib/openclaw-bun.json"
ALLOWED = {PIN, "docs/ci/pipeline.md", "docs/install/bun-compatibility.md"}
RELEASES = {
    "old": (
        "191755ec115ece3dd642eba3cb0143cecb5e5d7a",
        "openclaw-v1.4.4-20261026-191755ec11-webkit-b82bc917e9",
        "b82bc917e99110b61c3a21202d6def7457aa194c",
    ),
    "new": (
        "9debcc4b9db331d8ea8be404754baf1ffd0c7175",
        "openclaw-v1.4.4-20261115-9debcc4b9d-webkit-3357f9d63e",
        "3357f9d63e6dd87a53f2aade723482130a55c0cd",
    ),
}
TARGETS = ("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64")
# Current descendants, including three historical failure anchors; not the lost 24-file set.
TESTS = (
    "src/gateway/test-helpers.server-env.test.ts",
    "src/infra/state-migrations.caller-mode.storage.test.ts",
    "src/cli/update-cli/update-command-post-update.test.ts",
    "src/plugins/plugin-generation-conditions.test.ts",
    "src/plugins/loader.native-module-loader.test.ts",
    "src/plugins/loader.lazy-alias.test.ts",
    "src/plugins/plugin-sdk-native-resolver.test.ts",
    "src/gateway/server-close.port-reservation.test.ts",
    "src/gateway/server-http.mcp-oauth-callback.test.ts",
    "src/gateway/desktop/websocket-runtime.test.ts",
    "extensions/anthropic/session-catalog-tree-watch.test.ts",
    "src/auto-reply/usage-bar/template.test.ts",
    "src/agents/code-mode.bridge.lifecycle.test.ts",
    "src/gateway/worker-environments/workspace-hash-memo.test.ts",
    "extensions/openai/openai-chatgpt-oauth-flow.runtime.test.ts",
)
LIMIT = 2 * 1024 * 1024


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def public_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "openclaw-repin-diagnostic"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(LIMIT + 1)
    assert len(data) <= LIMIT, "public metadata exceeds text budget"
    return json.loads(data), hashlib.sha256(data).hexdigest()


class NoApiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("release metadata API redirect refused")


def release_api_json(endpoint, token, expected_tag_object=None):
    allowed = {prefix + tag for _, tag, _ in RELEASES.values()
               for prefix in ("releases/tags/", "git/ref/tags/")}
    if expected_tag_object is not None:
        assert re.fullmatch("[0-9a-f]{40}", expected_tag_object)
        allowed.add("git/tags/" + expected_tag_object)
    assert endpoint in allowed and token, "unapproved release metadata request"
    request = urllib.request.Request("https://api.github.com/repos/openclaw/bun/" + endpoint,
                                     headers={"User-Agent": "openclaw-repin-diagnostic",
                                              "Authorization": "Bearer " + token})
    with urllib.request.build_opener(NoApiRedirect()).open(request, timeout=60) as response:
        data = response.read(LIMIT + 1)
    assert len(data) <= LIMIT, "release metadata exceeds text budget"
    return json.loads(data)


def private_env(cell, tool_path):
    cell.mkdir(mode=0o700)
    directories = {name: cell / name for name in ("home", "config", "cache", "data", "tmp", "state")}
    for directory in directories.values():
        directory.mkdir(mode=0o700)
    return {
        "PATH": tool_path, "CI": "true", "LANG": "en_US.UTF-8", "TZ": "UTC", "NO_COLOR": "1",
        "HOME": str(directories["home"]), "USERPROFILE": str(directories["home"]),
        "XDG_CONFIG_HOME": str(directories["config"]), "XDG_CACHE_HOME": str(directories["cache"]),
        "XDG_DATA_HOME": str(directories["data"]), "TMPDIR": str(directories["tmp"]),
        "OPENCLAW_STATE_DIR": str(directories["state"]), "BUN_ENABLE_CRASH_REPORTING": "0",
    }


def run(command, cwd, env, log, redact, timeout=600):
    started = time.monotonic()
    proc = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    failure = None
    grace = None
    received = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while selector.get_map() or proc.poll() is None:
                if not failure and time.monotonic() - started > timeout:
                    failure = "controller deadline exceeded"
                if failure and grace is None:
                    # The canonical wrapper owns descendant signaling and group joins.
                    proc.terminate()
                    grace = time.monotonic() + 30
                if grace is not None and time.monotonic() >= grace:
                    if proc.poll() is None:
                        proc.kill()
                    break
                try:
                    for key, _ in selector.select(timeout=1):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        received += len(chunk)
                        output.extend(chunk[:max(0, LIMIT - len(output))])
                        if not failure and received > LIMIT:
                            failure = "controller log budget exceeded"
                except KeyboardInterrupt:
                    failure = "controller interrupted"
        proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            proc.terminate()
            # Unexpected controller errors cannot establish native descendant settlement.
            failure = failure or "controller exited before native settlement"
        proc.stdout.close()
        log.write_text(redact(output[:LIMIT].decode(errors="replace")) + (f"\n{failure}\n" if failure else ""))
    indeterminate = any(marker in output for marker in (
        b"processTreeState", b"child/group or nested resource completion was not verified",
        b"descendant completion is unverified",
    ))
    return {"exitCode": proc.returncode, "controllerFailure": failure, "log": log.name,
            "settlementUncertain": bool(failure or indeterminate or proc.returncode not in (0, 1))}


def admit_release(label, pin, token):
    commit, tag, webkit = RELEASES[label]
    assert pin["commit"] == commit and pin["tag"] == tag
    assert re.fullmatch(r"1[.]4[.]4(?:-canary[.]1)?[+]" + commit[:9], pin["revision"])
    assert set(pin["artifacts"]) == set(TARGETS) | {"windows-arm64", "windows-x64"}
    release = release_api_json("releases/tags/" + tag, token)
    assert release["tag_name"] == tag and not release["draft"] and release["published_at"]
    if label == "new":
        assert release["prerelease"], "candidate publication must be a prerelease"
    ref = release_api_json("git/ref/tags/" + tag, token)
    obj = ref["object"]
    if obj["type"] == "tag":
        annotated = release_api_json("git/tags/" + obj["sha"], token, obj["sha"])
        obj = annotated["object"]
    assert obj["type"] == "commit" and obj["sha"] == commit
    assets = {asset["name"]: asset for asset in release["assets"]}
    assert len(assets) == len(release["assets"])
    assert assets["manifest.json"]["browser_download_url"] == \
        "https://github.com/openclaw/bun/releases/download/" + tag + "/manifest.json"
    manifest, digest = public_json(assets["manifest.json"]["browser_download_url"])
    assert manifest["repository"] == "openclaw/bun" and manifest["tag"] == tag
    assert manifest["bun"]["commit"] == commit and manifest["bun"]["revision"] == pin["revision"]
    assert manifest["bun"]["version"] == "1.4.4" and manifest["webkit"]["version"] == webkit
    assert manifest["webkit"]["repository"] == "openclaw/WebKit"
    if assets["manifest.json"].get("digest"):
        assert assets["manifest.json"]["digest"] == "sha256:" + digest
    published = {asset["target"]: asset for asset in manifest["assets"]}
    assert len(published) == len(manifest["assets"]) and set(published) == set(pin["artifacts"])
    for target, artifact in pin["artifacts"].items():
        item = published[target]
        projection = {"asset": item["name"], "sha256": item["sha256"],
                      "executable": item["executable"]["path"],
                      "executableSha256": item["executable"]["sha256"]}
        if target.startswith("windows-"):
            assert item["executable"]["authenticodeSigned"] is True and item["executable"]["testOnly"] is False
            projection.update(authenticodeSigned=True, testOnly=False)
        assert projection == artifact, f"{label} {target}: published pin differs"
        assert assets[item["name"]]["size"] == item["size"] > 0 and item["executable"]["size"] > 0
    return {"release": release["html_url"], "releaseId": release["id"],
            "publishedAt": release["published_at"], "prerelease": release["prerelease"],
            "manifestSHA256": digest, "manifest": manifest, "pin": pin}


def cases(report, source):
    rows = []
    for file in report["testResults"]:
        for case in file["assertionResults"]:
            rows.append({"file": file["name"].removeprefix(str(source) + "/"),
                         "project": file.get("projectName"), "fullName": case["fullName"],
                         "title": case["title"], "ancestors": case["ancestorTitles"],
                         "status": case["status"], "assertions": case.get("numPassingAsserts"),
                         "failures": case["failureMessages"]})
    totals = {key: report.get(key) for key in (
        "success", "numFailedTests", "numFailedTestSuites", "numRuntimeErrorTestSuites",
        "numPassedTests", "numPendingTests", "numTodoTests", "numTotalTests",
    )}
    totals["files"] = [{
        "file": file["name"].removeprefix(str(source) + "/"), "project": file.get("projectName"),
        "status": file["status"], "message": file.get("message"),
    } for file in report["testResults"]]
    return rows, totals


def inventory(rows):
    return Counter(json.dumps({k: v for k, v in row.items() if k != "failures"}, sort_keys=True) for row in rows)


def compare(old, new):
    def groups(rows):
        result = defaultdict(list)
        for row in rows:
            key = json.dumps({k: row[k] for k in ("file", "project", "fullName", "title", "ancestors")}, sort_keys=True)
            result[key].append((row["status"], row["assertions"]))
        return result
    left, right = groups(old["cases"]), groups(new["cases"])
    changes, issues = [], []
    for identity in sorted(left.keys() | right.keys()):
        before, after = Counter(left[identity]), Counter(right[identity])
        if before == after:
            continue
        removed, added = list((before - after).elements()), list((after - before).elements())
        improvement = (
            bool(removed) and len(removed) == len(added)
            and all(status == "failed" for status, _ in removed)
            and all(status == "passed" for status, _ in added)
        )
        change = {"identity": json.loads(identity), "old": sorted(left[identity], key=str),
                  "new": sorted(right[identity], key=str), "oldFailureFixed": improvement}
        changes.append(change)
        if not improvement:
            issues.append(change)
    old_outcome, new_outcome = old["totals"], new["totals"]
    candidate_passed = (
        new["exitCode"] == 0 and new_outcome["success"] is True
        and all(case["status"] in {"passed", "pending", "skipped", "todo"} for case in new["cases"])
        and not new_outcome.get("numFailedTests") and not new_outcome.get("numFailedTestSuites")
        and not new_outcome.get("numRuntimeErrorTestSuites")
        and all(file["status"] == "passed" and not file["message"] for file in new_outcome["files"])
    )
    outcome_changes = {key: {"old": old_outcome.get(key), "new": new_outcome.get(key)}
                       for key in old_outcome.keys() | new_outcome.keys()
                       if old_outcome.get(key) != new_outcome.get(key)}
    if not candidate_passed:
        if not old_outcome.get("capture") or not new_outcome.get("capture"):
            issues.append({"outcome": "failed candidate lacks complete canonical nonassertion capture"})
        if outcome_changes:
            issues.append({"outcomeChanges": outcome_changes})
    elif new_outcome.get("capture") and (
        new_outcome["capture"]["unhandledErrors"] or new_outcome["capture"]["suiteErrors"]
        or new_outcome["capture"]["failedModules"]
    ):
        issues.append({"outcome": "native capture reports errors despite successful JSON"})
    return {"changes": changes, "outcomeChanges": outcome_changes,
            "requiresAssessment": issues, "noNewRegression": not issues}


def collect_reports(native, destination, source, redact):
    indexes = list(native.parent.glob(native.name + ".reports-*/index.json"))
    paths = [native] if native.is_file() else []
    direct_capture = native.with_name(native.name + ".capture.json")
    if direct_capture.is_file():
        paths.append(direct_capture)
    for index_path in indexes:
        paths.extend(p for p in index_path.parent.rglob("*.json")
                     if p.name in {"index.json", "report.json", "report.json.capture.json", "aggregate.json.capture.json"})
    assert len(paths) <= 12, "per-cell native report file budget exceeded"
    for number, path in enumerate(paths):
        assert path.stat().st_size <= 4 * LIMIT, "native JSON report exceeds budget"
        (destination / f"native-{number:02d}-{path.name}").write_text(redact(path.read_text()))
    assert native.is_file(), "canonical JSON report missing (setup or execution failure)"
    rows, totals = cases(json.loads(native.read_text()), source)
    originals = []
    captures = []
    for index_path in indexes:
        index = json.loads(index_path.read_text())
        assert index["complete"], "canonical report owner did not publish a complete aggregate"
        for entry in index["entries"]:
            accepted = entry["attempts"][entry["acceptedAttempt"] - 1]
            original, _ = cases(json.loads(Path(accepted["json"]).read_text()), source)
            originals.extend(original)
            captures.append(json.loads(Path(accepted["json"] + ".capture.json").read_text()))
    if indexes:
        assert inventory(rows) == inventory(originals), "aggregate differs from original assertion inventory"
    elif direct_capture.is_file():
        captures.append(json.loads(direct_capture.read_text()))
    if captures:
        assert all(capture.get("ended") and capture["ended"]["reason"] != "interrupted"
                   and not capture["processTimedOut"] for capture in captures), "native capture did not settle"
        totals["capture"] = {
            key: sum(capture["ended"][key] for capture in captures)
            for key in ("unhandledErrors", "failedModules", "suiteErrors")
        }
    assert rows and any(row["status"] in {"passed", "failed"} for row in rows), "no cases executed"
    assert totals["numTotalTests"] == len(rows), "native total differs from complete case inventory"
    for key, status in (("numPassedTests", "passed"), ("numFailedTests", "failed")):
        assert totals[key] == sum(row["status"] == status for row in rows), "native outcome totals differ from cases"
    return rows, totals


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--controller-sha", required=True)
    parser.add_argument("--phase", choices=("metadata", "execute"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    if args.phase == "metadata":
        out.mkdir(mode=0o700)
    else:
        assert out.is_dir(), "metadata admission must finish first"
    report = {"diagnosticComplete": False, "noNewRegression": False, "source": args.candidate_sha,
              "baselineSource": BASE, "inventoryKind": "current-derived-15", "tests": TESTS,
              "controller": args.controller_sha, "phase": args.phase, "runs": [], "staging": [],
              "settlementUncertain": False}
    candidate_bytes = None
    redact = lambda text: text
    deadline = time.monotonic() + 75 * 60

    def interrupt(signum, frame):
        report["settlementUncertain"] = True
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def save():
        data = redact(json.dumps(report, indent=2) + "\n")
        assert len(data.encode()) <= 4 * LIMIT, "summary exceeds budget"
        (out / "report.json").write_text(data)

    save()
    try:
        assert platform.system() == "Darwin" and platform.machine() == "arm64", "hosted native macOS ARM64 required"
        assert re.fullmatch("[0-9a-f]{40}", args.candidate_sha)
        assert re.fullmatch("[0-9a-f]{40}", args.controller_sha)
        if args.phase == "execute":
            assert "BUN_RELEASE_METADATA_TOKEN" not in os.environ, "metadata credentials reached execution phase"
        with ExitStack() as cleanup:
            root = Path(tempfile.mkdtemp(prefix="openclaw-repin-"))
            cleanup.callback(lambda: None if report["settlementUncertain"] else shutil.rmtree(root))
            node = Path(shutil.which("node")).resolve()
            tool_path = str(node.parent) + ":/usr/bin:/bin:/usr/sbin:/sbin"
            env = private_env(root / "control", tool_path)
            redact = lambda text: text.replace(str(root), "<private-cell>").replace(str(source), "<openclaw-source>")

            def git(*arguments):
                return subprocess.check_output(["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
                                                "-c", "core.hooksPath=/dev/null", "-C", str(source), *arguments],
                                               env=env, text=True, timeout=120).strip()

            assert git("rev-parse", "HEAD") == args.candidate_sha
            assert git("-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD") == args.controller_sha
            assert git("remote", "get-url", "origin").removesuffix(".git") == "https://github.com/openclaw/openclaw"
            assert not git("status", "--porcelain", "--untracked-files=no")
            if args.phase == "metadata":
                git("fetch", "--no-tags", "--no-auto-maintenance", "--depth=1", "origin", BASE)
            changes = git("diff", "--name-status", BASE, args.candidate_sha).splitlines()
            assert changes and all(line.startswith("M\t") and line[2:] in ALLOWED for line in changes)
            assert "M\t" + PIN in changes
            assert git("ls-tree", "HEAD", PIN).startswith("100644 blob ")
            candidate_bytes = (source / PIN).read_bytes()
            old_bytes = (git("show", BASE + ":" + PIN) + "\n").encode()
            pins = {"old": json.loads(old_bytes), "new": json.loads(candidate_bytes)}
            report.update(sourceTree=git("rev-parse", "HEAD^{tree}"), changedPaths=changes,
                          testSHA256={test: sha(source / test) for test in TESTS}, childEnvironmentKeys=sorted(env))
            binding = {"source": args.candidate_sha, "controller": args.controller_sha,
                       "sourceTree": report["sourceTree"], "baselineSource": BASE,
                       "pinSHA256": {"old": hashlib.sha256(old_bytes).hexdigest(),
                                     "new": hashlib.sha256(candidate_bytes).hexdigest()}}
            metadata_path = out / "metadata-admission.json"
            if args.phase == "metadata":
                token = os.environ["BUN_RELEASE_METADATA_TOKEN"]
                releases = {label: admit_release(label, pin, token) for label, pin in pins.items()}
                data = json.dumps({"binding": binding, "releases": releases}, indent=2) + "\n"
                assert len(data.encode()) <= LIMIT, "metadata receipt exceeds budget"
                metadata_path.write_text(data)
                report.update(metadataAdmitted=True, metadataSHA256=sha(metadata_path))
                return
            assert metadata_path.stat().st_size <= LIMIT, "metadata receipt exceeds budget"
            metadata = json.loads(metadata_path.read_text())
            assert metadata["binding"] == binding, "metadata receipt does not match this source/controller/pin pair"
            assert {label: release["pin"] for label, release in metadata["releases"].items()} == pins
            report.update(releases=metadata["releases"], metadataSHA256=sha(metadata_path))
            package = json.loads((source / "package.json").read_text())
            assert package["packageManager"].startswith("pnpm@12.15.0+sha512.")
            assert subprocess.check_output([str(node), "--version"], env=env, text=True).strip() == "v24.22.1"
            save()

            def checked(command, label, command_env=env, timeout=600):
                remaining = deadline - time.monotonic()
                assert remaining > 0, "diagnostic deadline reached before preparation"
                report["settlementUncertain"] = True
                outcome = run(command, source, command_env, out / (label + ".log"), redact, min(timeout, remaining))
                report.setdefault("preparation", []).append({"step": label, **outcome})
                report["settlementUncertain"] = outcome["settlementUncertain"] or outcome["exitCode"] != 0
                save()
                assert not report["settlementUncertain"], label + " failed; state retained for runner teardown"

            binaries = {}
            for label in ("new", "old"):
                (source / PIN).write_bytes(candidate_bytes if label == "new" else old_bytes)
                report["activePin"] = label
                for target in TARGETS if label == "new" else ("darwin-arm64",):
                    destination = root / (label + "-" + target)
                    platform_name, arch = target.split("-")
                    stage_env = {**env, "OPENCLAW_BUN_CACHE_ROOT": str(root / "archives")}
                    checked(["/bin/bash", "scripts/stage-openclaw-bun.sh", str(destination), platform_name, arch],
                            "stage-" + label + "-" + target, stage_env)
                    binary = destination / "bin/bun"
                    assert binary.is_file() and not binary.is_symlink()
                    published = next(item for item in report["releases"][label]["manifest"]["assets"] if item["target"] == target)
                    assert sha(binary) == pins[label]["artifacts"][target]["executableSha256"]
                    assert binary.stat().st_size == published["executable"]["size"]
                    archive = root / "archives" / pins[label]["tag"] / published["name"]
                    assert archive.stat().st_size == published["size"]
                    receipt = {"runtime": label, "target": target, "sha256": sha(binary), "bytes": binary.stat().st_size,
                               "archiveBytes": archive.stat().st_size, "archiveSHA256": published["sha256"],
                               "execution": "foreign-format-and-hash-only"}
                    report["settlementUncertain"] = True
                    executor = [] if target == "darwin-arm64" else ["/usr/bin/arch", "-x86_64"]
                    executable = target == "darwin-arm64" or (
                        target == "darwin-x64" and subprocess.run(
                            executor + ["/usr/bin/true"], env=env, capture_output=True, timeout=30,
                        ).returncode == 0
                    )
                    if executable:
                        probe = "console.log(JSON.stringify({version:Bun.version,revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))"
                        identity = json.loads(subprocess.check_output(
                            executor + [str(binary), "-e", probe], env=env, text=True, timeout=30,
                        ))
                        assert identity == {
                            "version": "1.4.4", "revision": RELEASES[label][0],
                            "webkit": RELEASES[label][2], "platform": "darwin", "arch": arch,
                        }
                        receipt.update(execution="native" if arch == "arm64" else "translated-rosetta", identity=identity)
                    report["settlementUncertain"] = False
                    report["staging"].append(receipt)
                    if target == "darwin-arm64":
                        binaries[label] = binary
                    save()
            (source / PIN).write_bytes(candidate_bytes)
            report["activePin"] = "new"
            env.update(COREPACK_HOME=str(root / "corepack"), COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
                       PNPM_CONFIG_FROZEN_LOCKFILE="true")
            bin_dir = root / "bin"
            bin_dir.mkdir(mode=0o700)
            checked(["corepack", "enable", "--install-directory", str(bin_dir)], "corepack-enable")
            env["PATH"] = str(bin_dir) + ":" + tool_path
            checked(["corepack", "prepare", package["packageManager"], "--activate"], "corepack-prepare")
            checked(["/bin/bash", ".github/actions/setup-node-env/install-dependencies.sh"], "dependencies",
                    {**env, "NODE_BIN": str(node.parent), "FROZEN_LOCKFILE": "true", "DEPENDENCY_CACHE": "false", "DEPENDENCY_CACHE_HIT": "false"}, 1200)
            assert not git("status", "--porcelain", "--untracked-files=no"), "dependency setup modified tracked source"
            for label in ("old", "new"):
                (source / PIN).write_bytes(candidate_bytes if label == "new" else old_bytes)
                report["activePin"] = label
                for number, test in enumerate(TESTS):
                    remaining = deadline - time.monotonic()
                    assert remaining > 0, "diagnostic deadline reached; unfinished cells are not proof"
                    name = f"{label}-{number:02d}"
                    cell = root / name
                    child_env = private_env(cell, env["PATH"])
                    child_env.update(COREPACK_HOME=env["COREPACK_HOME"], COREPACK_ENABLE_NETWORK="0",
                                     PNPM_CONFIG_FROZEN_LOCKFILE="true", OPENCLAW_VITEST_RUNTIME="bun",
                                     OPENCLAW_BUN_PATH=str(binaries[label]), BUN_BIN=str(binaries[label]),
                                     OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT=str(cell / "cache/vitest"),
                                     BUN_RUNTIME_TRANSPILER_CACHE_PATH=str(cell / "cache/bun"),
                                     OPENCLAW_TEST_PROJECTS_SERIAL="1", OPENCLAW_VITEST_MAX_WORKERS="1")
                    native = cell / "result.json"
                    evidence = out / name
                    evidence.mkdir()
                    print(f"{label}: {test}", flush=True)
                    report["settlementUncertain"] = True
                    outcome = run([str(node), "scripts/test-projects.mts", test, "--", "--maxWorkers=1",
                                   "--reporter=verbose", "--reporter=json", "--outputFile.json=" + str(native)],
                                  source, child_env, evidence / "verbose.log", redact, min(600, remaining))
                    result = {"runtime": label, "file": test, **outcome, "cases": [],
                              "environmentKeys": sorted(child_env)}
                    report["runs"].append(result)
                    try:
                        result["cases"], result["totals"] = collect_reports(native, evidence, source, redact)
                        assert not outcome["settlementUncertain"], "native settlement uncertain; state retained for runner teardown"
                        assert all(case["file"] == test for case in result["cases"]), \
                            "canonical selection executed a different test file"
                        assert outcome["exitCode"] in (0, 1) and not outcome["controllerFailure"], \
                            "setup, timeout or infrastructure failure"
                        assert result["totals"]["success"] == (outcome["exitCode"] == 0), \
                            "process and native report outcomes differ"
                        assert outcome["exitCode"] == 0 or any(case["status"] == "failed" for case in result["cases"]), \
                            "non-assertion process failure requires assessment"
                        report["settlementUncertain"] = False
                        if test.endswith("desktop/websocket-runtime.test.ts"):
                            expected = {f"preserves {mode} through the registered upgrade handler" for mode in (
                                "observer-close", "observer-backpressure", "observer-payload", "desktop", "portal",
                            )}
                            assert len(result["cases"]) == 5 and {case["title"] for case in result["cases"]} == expected
                            assert all(case["status"] == "passed" for case in result["cases"]), "five desktop runtime modes must pass"
                    except Exception as error:
                        result["evidenceError"] = str(error)
                        if report["settlementUncertain"]:
                            save()
                            raise
                    save()
            report["comparisons"] = [
                {"file": test, **compare(report["runs"][number], report["runs"][number + len(TESTS)])}
                for number, test in enumerate(TESTS)
            ]
            assert not any(run.get("evidenceError") for run in report["runs"]), "incomplete or invalid native test evidence"
            report["noNewRegression"] = all(item["noNewRegression"] for item in report["comparisons"])
            report["allCellsPassed"] = all(run["exitCode"] == 0 for run in report["runs"])
            report["diagnosticComplete"] = True
            assert report["noNewRegression"], "case/status/assertion differences require assessment"
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        if report["settlementUncertain"]:
            report.update(stateRetained=True, restoration="not-attempted-indeterminate-settlement",
                          scratchDisposition="retained-for-hosted-runner-teardown")
        elif candidate_bytes is not None:
            if args.phase == "execute":
                (source / PIN).write_bytes(candidate_bytes)
                report["candidatePinRestored"] = (source / PIN).read_bytes() == candidate_bytes
            status = git("status", "--porcelain", "--untracked-files=no")
            report["trackedSourceClean"] = not status
            if status:
                report["diagnosticComplete"] = False
                report["error"] = "tracked source modified: " + status
        save()
        assert candidate_bytes is None or report["settlementUncertain"] or report["trackedSourceClean"], \
            "candidate source not restored cleanly"


if __name__ == "__main__":
    main()
