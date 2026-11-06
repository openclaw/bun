"""Qualify frozen consumers using this run's primary Linux x64 release ZIP."""

import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

CONSUMERS = {
    "openclaw": ("7c26e8cccd19b74c3443fb3f0ed6fbf9d7d410a3", "24.22.1"),
    "birdclaw": ("59c9ee27f39238654efc93ff7862b27ad474c044", "26.12.1"),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(path.read_text())


def require_vitest_result(result, expected):
    require(
        result["success"] is True
        and result["numTotalTests"] == result["numPassedTests"] == expected
        and all(result[key] == 0 for key in ("numFailedTests", "numPendingTests", "numTodoTests")),
        f"all {expected} selected consumer cases must execute and pass",
    )


def admit(dist, destination, commit, webkit, run_url):
    manifest = read(dist / "manifest.json")
    require(
        re.fullmatch(r"[0-9a-f]{40}", commit) and re.fullmatch(r"[0-9a-f]{40}", webkit),
        "full source revisions required",
    )
    require(
        manifest["schemaVersion"] == 1 and manifest["repository"] == "openclaw/bun",
        "unexpected release manifest",
    )
    require(
        manifest["bun"]["commit"] == commit and manifest["webkit"]["version"] == webkit,
        "release source mismatch",
    )
    require(
        manifest["workflowRun"] == run_url,
        "release belongs to a different workflow run",
    )
    assets = [asset for asset in manifest["assets"] if asset["target"] == "linux-x64"]
    require(len(assets) == 1, "one primary Linux x64 asset required")
    asset = assets[0]
    require(
        (asset["name"], asset["os"], asset["arch"], asset["libc"]) == ("bun-linux-x64.zip", "linux", "x64", "glibc"),
        "primary glibc archive required",
    )
    executable = asset["executable"]
    require(executable["path"] == "bun-linux-x64/bun", "unexpected executable path")
    sums = {}
    for line in (dist / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\]+)", line)
        require(
            match is not None and match[2] not in sums,
            "invalid or duplicate checksum entry",
        )
        sums[match[2]] = match[1]
    archive = dist / asset["name"]
    require(
        sha(dist / "manifest.json") == sums.get("manifest.json"),
        "manifest checksum mismatch",
    )
    require(0 < asset["size"] == archive.stat().st_size <= 1024**3, "archive size mismatch")
    require(
        sha(archive) == asset["sha256"] == sums.get(asset["name"]),
        "archive checksum mismatch",
    )
    require(0 < executable["size"] <= 1024**3, "invalid executable size")
    # Read only the primary executable; never extract archive-controlled paths.
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        require(
            [member.filename for member in members] == ["bun-linux-x64/", executable["path"]],
            "unexpected primary archive members",
        )
        require(members[0].is_dir(), "invalid primary archive directory")
        member = members[1]
        require(
            member.file_size == executable["size"] and (member.external_attr >> 16) & 0o170000 != 0o120000,
            "invalid executable member",
        )
        with package.open(member) as source, destination.open("xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
    require(
        destination.stat().st_size == executable["size"] and sha(destination) == executable["sha256"],
        "executable checksum mismatch",
    )
    destination.chmod(0o755)
    return {
        "commit": commit,
        "webkit": webkit,
        "workflowRun": run_url,
        "archive_sha256": asset["sha256"],
        "executable_sha256": executable["sha256"],
        "executable_size": executable["size"],
        "manifest_sha256": sha(dist / "manifest.json"),
    }


def qualify(name, dist, repo, output):
    source, node_version = CONSUMERS[name]
    output.mkdir()
    tools = output / "tools"
    tools.mkdir()
    binary = tools / "bun"
    report = {"passed": False, "consumer": name, "source": source, "steps": []}
    config = repo / "toolchains/bun-canary.conf"
    original_config = None

    def save():
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    # Dependency scripts and consumer processes receive no Actions/GitHub capabilities.
    env = {
        "PATH": str(tools) + ":" + os.environ["PATH"],
        "HOME": str(tools),
        "CI": "1",
        "LANG": "C.UTF-8",
        "NO_COLOR": "1",
        "TERM": "dumb",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_COMMIT": source,
        "BUN_BIN": str(binary),
        "BIRDCLAW_NODE_BIN": shutil.which("node"),
        "OPENCLAW_TEST_BUN_LAUNCHER": "1",
        "OPENCLAW_HOME": str(tools / "openclaw-home"),
        "OPENCLAW_STATE_DIR": str(tools / "openclaw-state"),
        "OPENCLAW_CONFIG_PATH": str(tools / "openclaw-state/openclaw.json"),
        "BIRDCLAW_HOME": str(tools / "birdclaw-home"),
        "BIRDCLAW_BACKUP_AUTO_SYNC": "0",
        "BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP": "1",
        "BIRDCLAW_DISABLE_LIVE_WRITES": "1",
        "DO_NOT_TRACK": "1",
        "PUPPETEER_SKIP_DOWNLOAD": "1",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
    }
    for key in (
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "npm_config_cache",
        "BUN_INSTALL_CACHE_DIR",
    ):
        path = tools / key.lower()
        path.mkdir()
        env[key] = str(path)

    def check_source():
        require(
            subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, env=env, text=True).strip() == source,
            "consumer source moved",
        )
        require(
            subprocess.check_output(["git", "diff", "HEAD", "--name-only"], cwd=repo, env=env, text=True).strip() == "",
            "tracked consumer source changed",
        )

    def run(label, args, extra=None):
        print("consumer step: " + label, flush=True)
        row = {"name": label, "passed": False}
        report["steps"].append(row)
        save()
        log = output / (label + ".log")
        with (
            log.open("x") as stream,
            (output / (label + ".stderr.log")).open("x") as errors,
        ):
            child = subprocess.Popen(
                list(map(str, args)),
                cwd=repo,
                env=env | (extra or {}),
                stdin=subprocess.DEVNULL,
                stdout=stream,
                stderr=errors,
                start_new_session=True,
            )
            try:
                row["exitCode"] = child.wait(timeout=1800)
            finally:
                # Only this command's process group, including any owned servers.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                row["exitCode"] = child.wait()
                row["passed"] = row["exitCode"] == 0
                stream.flush()
                errors.flush()
                row["log_sha256"] = sha(log)
                save()
        require(row["passed"], "consumer step failed: " + label)
        return log

    def identity(label):
        admission = report["admission"]
        require(sha(binary) == admission["executable_sha256"], "candidate binary changed")
        script = "console.log(JSON.stringify({bun:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))"
        observed = read(run(label, [binary, "--no-env-file", "-e", script]))
        require(
            observed
            == {
                "bun": admission["commit"],
                "webkit": admission["webkit"],
                "platform": "linux",
                "arch": "x64",
            },
            "candidate runtime mismatch",
        )

    try:
        report["admission"] = admit(
            dist,
            binary,
            os.environ["EXPECTED_COMMIT"],
            os.environ["EXPECTED_WEBKIT"],
            os.environ["EXPECTED_RUN"],
        )
        check_source()
        identity("identity-before")
        require(
            run("node-version", ["node", "--version"]).read_text().strip() == "v" + node_version,
            "Node version mismatch",
        )
        revision = run("bun-revision", [binary, "--revision"]).read_text().strip()
        require(
            revision.endswith("+" + report["admission"]["commit"][:9]),
            "CLI revision mismatch",
        )
        if name == "openclaw":
            require(Path("/usr/bin/google-chrome").is_file(), "real Chrome is required")
            run(
                "namespace-prerequisite",
                ["sudo", "-n", "unshare", "--mount", "--fork", "true"],
            )
            npm = run("npm-version", ["npm", "--version"]).read_text().strip()
            require(
                tuple(map(int, npm.split(".")[:3])) >= (11, 19, 0),
                "frozen npm cooldown policy requires npm 11.19+",
            )
            manager = read(repo / "package.json")["packageManager"]
            require(
                manager
                == "pnpm@12.15.0+sha512.b3951d6d6ff4a9f13dc7cf56cd28d2b8eb37dbcc9c68e52e1e1191873ea9f82a017287ab50baadc5ccc494f036c67c0e47eb13608c2fa36f47711b61ea128e61",
                "frozen package manager changed",
            )
            env["COREPACK_HOME"] = str(tools / "corepack")
            env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
            run("corepack-enable", ["corepack", "enable", "--install-directory", tools])
            run("pnpm-setup", ["corepack", "prepare", manager, "--activate"])
            require(
                run("pnpm-version", ["pnpm", "--version"]).read_text().strip() == "12.15.0",
                "pnpm version mismatch",
            )
            run("install", ["pnpm", "install", "--frozen-lockfile"])
            run("clean-dist", ["pnpm", "clean:dist"])
            run("build", ["pnpm", "build:ci-artifacts"])
            run(
                "declarations",
                [
                    "node",
                    "--import",
                    "./scripts/tsx.mjs",
                    "scripts/write-unified-entry-dts.ts",
                ],
                {"OPENCLAW_RUN_NODE_SKIP_DTS_BUILD": "0"},
            )
            package_dir = output / "package"
            run(
                "package",
                [
                    "node",
                    "scripts/package-openclaw-for-docker.mjs",
                    "--skip-build",
                    "--allow-unreleased-changelog",
                    "--output-dir",
                    package_dir,
                    "--output-name",
                    "candidate.tgz",
                ],
            )
            package = package_dir / "candidate.tgz"
            package_sha = sha(package)
            with tarfile.open(package) as packed:
                package_info = json.load(packed.extractfile("package/package.json"))
                build_info = json.load(packed.extractfile("package/dist/build-info.json"))
                ai_info = json.load(packed.extractfile("package/node_modules/@openclaw/ai/package.json"))
            version = read(repo / "package.json")["version"]
            require(
                package_info["name"] == "openclaw"
                and package_info["version"] == version
                and build_info["commit"] == source
                and build_info["version"] == version,
                "packaged consumer source/version mismatch",
            )
            require(
                ai_info["name"] == "@openclaw/ai" and ai_info["version"] == version,
                "matching bundled AI runtime required",
            )
            run(
                "bun-only-smoke",
                ["/bin/bash", "scripts/e2e/bun-only-runtime-smoke.sh"],
                {
                    "OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ": str(package),
                    "OPENCLAW_BUN_ONLY_SMOKE_ARTIFACT_DIR": str(output / "smoke"),
                    "OPENCLAW_BUN_ONLY_SMOKE_HIDE_SYSTEM_NODE": "1",
                },
            )
            smoke = read(output / "smoke/report.json")
            require(
                smoke["ok"] is True
                and not smoke.get("fatalError")
                and Path(smoke["bun"]).resolve() == binary
                and smoke["bunRevision"] == revision,
                "Bun-only smoke failed or used another binary",
            )
            require(
                [row["name"] for row in smoke["steps"]]
                == [
                    "preconditions",
                    "install",
                    "cli",
                    "gateway",
                    "node-host",
                    "agent",
                    "doctor",
                    "terminals",
                    "browser",
                    "cleanup",
                ],
                "missing smoke steps",
            )
            require(
                all(
                    row["status"] == "passed"
                    and row.get("exitCode", 0) == 0
                    and all(cmd["exitCode"] == 0 and cmd["timedOut"] is False for cmd in row["commands"])
                    for row in smoke["steps"]
                ),
                "smoke step failed or timed out",
            )
            require(
                all(
                    smoke[key] == []
                    for key in (
                        "blockers",
                        "attempts",
                        "unexpectedAttempts",
                        "staleBlockers",
                        "failedSteps",
                    )
                ),
                "smoke accepted a blocker or Node attempt",
            )
            require(
                all(
                    (output / "smoke" / file).read_text().strip() == ""
                    for file in ("sentinel-ledger.jsonl", "spawn-trace.jsonl")
                ),
                "Node launch attempted",
            )
            require(sha(package) == package_sha, "package changed during smoke")
            run(
                "sqlite",
                [
                    "pnpm",
                    "test",
                    "src/infra/sqlite-existing-database.bun.test.ts",
                    "src/infra/sqlite-worker-input.bun.test.ts",
                    "--",
                    "--reporter=json",
                    "--outputFile=" + str(output / "sqlite.json"),
                ],
            )
            require_vitest_result(read(output / "sqlite.json"), 2)
            pin = repo / "scripts/lib/openclaw-bun.json"
            original_pin = pin.read_bytes()
            projected_pin = json.loads(original_pin)
            require(projected_pin["revision"] == "1.4.4-canary.1+191755ec1", "unexpected frozen Bun revision")
            projected_pin["revision"] = revision
            try:
                # Explicit candidate selection still checks the frozen revision in CI.
                pin.write_text(json.dumps(projected_pin, indent=2) + "\n")
                run(
                    "before-tool-call",
                    [
                        "pnpm",
                        "test",
                        "src/plugins/hooks.before-tool-call.test.ts",
                        "--",
                        "--reporter=json",
                        "--outputFile=" + str(output / "before-tool-call.json"),
                    ],
                    {"OPENCLAW_VITEST_RUNTIME": "bun", "OPENCLAW_BUN_PATH": str(binary)},
                )
                require_vitest_result(read(output / "before-tool-call.json"), 31)
            finally:
                pin.write_bytes(original_pin)
            resolver = read(
                run(
                    "handoff-path",
                    [
                        binary,
                        "--no-env-file",
                        "-e",
                        """
import { spawnSync } from 'node:child_process';
import { resolveManagedUpdateLeaseDatabasePath } from './src/infra/update-managed-service-handoff-lease.ts';
const child = spawnSync(process.execPath, ['--no-env-file', '-e', `
  import { resolveManagedUpdateLeaseDatabasePath } from './src/infra/update-managed-service-handoff-lease.ts';
  console.log(JSON.stringify({executable:process.execPath,databasePath:resolveManagedUpdateLeaseDatabasePath()}));
`], {env:process.env,encoding:'utf8'});
if (child.error) throw child.error;
if (child.status !== 0 || child.signal !== null || child.stderr !== '')
  throw new Error('descendant resolver failed: ' + child.stderr);
console.log(JSON.stringify({
  parent:{executable:process.execPath,databasePath:resolveManagedUpdateLeaseDatabasePath()},
  child:JSON.parse(child.stdout),
}));
""",
                    ],
                )
            )
            database = Path(env["TMPDIR"]) / f"openclaw-{os.getuid()}" / "managed-update-handoffs.sqlite"
            require(
                resolver["parent"] == resolver["child"] == {"executable": str(binary), "databasePath": str(database)}
                and not database.exists(),
                "parent and descendant must resolve the same private handoff path without opening its database",
            )
            report["package_sha256"] = package_sha
        else:
            for label in ("install", "check", "coverage", "build"):
                args = (
                    [binary, "--no-env-file", "install", "--frozen-lockfile"]
                    if label == "install"
                    else [binary, "--no-env-file", "run", "--bun", label]
                )
                # Coverage mocks the lookup transports and must exercise them.
                extra = {"BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP": "0"} if label == "coverage" else None
                log = run(label, args, extra)
                if label == "coverage":
                    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log.read_text())
                    tests = re.search(r"\bTests\s+([0-9,]+)\s+passed", text)
                    require(
                        tests is not None
                        and int(tests[1].replace(",", "")) > 0
                        and not re.search(r"\bTests[^\n]*[1-9][0-9,]* failed", text),
                        "coverage must execute passing tests with repository thresholds",
                    )
            run(
                "demo",
                [binary, "--no-env-file", "src/cli.ts", "--json", "init", "--demo"],
            )
            runtime = read(
                run(
                    "runtime",
                    [
                        binary,
                        "--no-env-file",
                        "scripts/runtime-perf.mjs",
                        "--label=shipping-candidate",
                        "--runtime=" + str(binary),
                        "--runtime-arg=--no-env-file",
                        "--entry=bin/birdclaw.mjs",
                        "--home=" + env["BIRDCLAW_HOME"],
                        "--iterations=1",
                    ],
                )
            )
            require(
                runtime["gitSha"] == source
                and runtime["iterations"] == 1
                and runtime["runtime"]
                == {
                    "executable": str(binary),
                    "args": ["--no-env-file"],
                    "identity": revision,
                },
                "runtime used different source or binary",
            )
            require(
                runtime["inputDatabaseLogicalSha256"] == runtime["finalDatabaseLogicalSha256"],
                "runtime changed logical database",
            )
            require(
                len(runtime["samples"]["cliMs"]) == len(runtime["samples"]["server"]) == 1,
                "runtime samples missing",
            )
            require(
                all(math.isfinite(value) and value >= 0 for value in runtime["samples"]["cliMs"]),
                "invalid CLI timing",
            )
            for key, path in (
                ("launcherSha256", "bin/birdclaw.mjs"),
                ("cliSha256", "dist/cli/birdclaw.js"),
                ("serverSha256", "dist/server/server.js"),
            ):
                require(
                    runtime["artifacts"][key] == sha(repo / path),
                    "runtime artifact mismatch",
                )
            # The frozen consumer's installed-package smoke compares its old pin.
            # Project only that expectation; restore it even if smoke fails.
            original_config = config.read_bytes()
            old = b"BUN_CANARY_REVISION='1.4.4-canary.1+191755ec1'"
            require(
                original_config.count(old) == 1 and re.fullmatch(r"[A-Za-z0-9.+_-]+", revision),
                "unexpected frozen revision expectation",
            )
            config.write_bytes(original_config.replace(old, ("BUN_CANARY_REVISION='" + revision + "'").encode()))
            packed = read(
                run(
                    "package",
                    [binary, "--no-env-file", "scripts/package-smoke.mjs", "--json"],
                )
            )
            require(
                packed["ok"] is True
                and packed["bunRevision"] == revision
                and packed["nodeVersion"] == "v" + node_version
                and packed["files"] > 0,
                "installed package smoke failed",
            )
            require(
                len(packed["runtimes"]) == 2
                and {row["name"] for row in packed["runtimes"]} == {"bun", "node"}
                and next(row for row in packed["runtimes"] if row["name"] == "bun")["executable"] == str(binary),
                "package must exercise Bun and Node",
            )
            config.write_bytes(original_config)
        check_source()
        identity("identity-after")
        report["passed"] = True
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        if original_config is not None:
            config.write_bytes(original_config)
        try:
            check_source()
            report["source_preserved"] = True
            if "admission" in report:
                require(
                    sha(binary) == report["admission"]["executable_sha256"],
                    "binary bytes changed",
                )
        except BaseException:
            report["passed"] = False
            raise
        finally:
            save()


if __name__ == "__main__":

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    qualify(
        sys.argv[1],
        Path(sys.argv[2]).resolve(),
        Path(sys.argv[3]).resolve(),
        Path(sys.argv[4]).resolve(),
    )
