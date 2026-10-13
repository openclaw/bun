#!/usr/bin/env python3
"""Prepare and run the frozen OpenClaw checker comparison on a hosted runner."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

SOURCE = "aed6c05cc43d898daf4c82bf6cb64222e78bde7c"
MANIFEST = "9b6dbd59ac58d3f0f814612c2cb7b1cd7fa0ccb19a19290ef01cd362c31485b1"
NODE_ARCHIVE = "d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9"
NODE_BINARY = "b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd"
RECORDS = {
    "runner.mjs": "1a77a743776cd2f1c43f851242e83124e8f7d3bd",
    "manifest.json": "7b0875bce0b1a2a61cdad32f7b48cdc874042db6",
    "resume-receipt.json": "6a8e69d3c4b62c44dade149e006671fa8ad936fc",
    "semantic-cases.json": "d252c21f7ec0c1bc71d9245776d0603184a74576",
    "binary.archive": "c327030058bd41c681beada3fd340ce819729e6f",
    "upstream.archive": "f164058004a813f329fe73afbd6a0a98bbe5c479",
    "oracle.archive": "52ce00e26b2eeb223f32621b1bfb0302ce959dcb",
}
PREFIX = "tools/bun-checker-matrix-input/"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True, timeout=60).strip()


def verify(source, inputs, materialized):
    require(sha(inputs / "manifest.json") == MANIFEST, "manifest differs")
    manifest = json.loads((inputs / "manifest.json").read_text())
    require(manifest["source"] == SOURCE, "source binding differs")
    tree = subprocess.check_output(["git", "-C", str(source), "ls-tree", "-r", "--full-tree", "HEAD"], text=True)
    tree = "\n".join(line for line in tree.split("\n") if line.partition("\t")[2] not in {PREFIX + name for name in RECORDS})
    require(hashlib.sha256(tree.encode()).hexdigest() == manifest["sourceInventorySha256"], "source inventory differs")
    require(not git(source, "diff", "--name-only", "HEAD"), "source has tracked modifications")
    require(not git(source, "ls-files", "--others", "--exclude-standard"), "source has untracked inputs")
    require(sha(source / "pnpm-lock.yaml") == manifest["lockfileSha256"], "lock differs")
    for graph in manifest["graphs"]:
        require(sha(source / graph["config"]) == graph["configSha256"], "config differs: " + graph["name"])
    if materialized:
        for name, blob in RECORDS.items():
            file = inputs / name
            require(file.is_file() and not file.is_symlink(), "invalid transport file")
            require(git(source, "hash-object", str(file)) == blob, "transport blob differs: " + name)
            require(git(source, "ls-tree", "HEAD", "--", PREFIX + name) == "100644 blob " + blob + "\t" + PREFIX + name, "transport mode differs")
    return manifest


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        result = super().redirect_request(req, fp, code, msg, headers, newurl)
        # Artifact redirects leave api.github.com. Never forward its credential.
        result.remove_header("Authorization")
        return result


def download(url, target, expected, token=None):
    headers = {"User-Agent": "openclaw-checker-comparison"}
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    temporary = target.with_suffix(target.suffix + ".part")
    count = 0
    with urllib.request.build_opener(PublicRedirect()).open(urllib.request.Request(url, headers=headers), timeout=30) as response, temporary.open("xb") as sink:
        while data := response.read(1024 * 1024):
            count += len(data)
            require(count <= 256 * 1024 ** 2, "download exceeds bound")
            sink.write(data)
    require(sha(temporary) == expected, "download hash differs: " + target.name)
    temporary.replace(target)


def prepare(source, payload, output):
    def expired(signum, frame):
        raise TimeoutError("preparation deadline exceeded")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(1200)
    require(git(source, "rev-parse", "HEAD") == SOURCE, "checkout is not exact frozen source")
    verify(source, payload, False)
    inputs = source / PREFIX
    require(not inputs.exists(), "transport directory already exists")
    inputs.mkdir(parents=True)
    for name in ("runner.mjs", "manifest.json", "resume-receipt.json", "semantic-cases.json"):
        shutil.copyfile(payload / name, inputs / name)
    manifest = json.loads((inputs / "manifest.json").read_text())
    token = os.environ.get("GH_TOKEN")
    require(bool(token), "preparation needs the job-scoped artifact read token")
    outer = output / "final-bun.zip"
    download("https://api.github.com/repos/openclaw/bun/actions/artifacts/11801370289/zip", outer, manifest["bun"]["zipSha256"], token)
    with zipfile.ZipFile(outer) as archive:
        require(archive.namelist() == ["bun-linux-x64.tar.gz", "SHA256SUMS", "commit.txt"], "final archive entries differ")
        require(archive.read("commit.txt").decode().strip() == manifest["bun"]["source"], "artifact source differs")
        with archive.open("bun-linux-x64.tar.gz") as src, (inputs / "binary.archive").open("xb") as dst:
            shutil.copyfileobj(src, dst)
    require(sha(inputs / "binary.archive") == manifest["bun"]["archiveSha256"], "inner archive differs")
    download(manifest["upstream"]["url"], inputs / "upstream.archive", manifest["upstream"]["archiveSha256"])
    download(manifest["oracle"]["url"], inputs / "oracle.archive", manifest["oracle"]["archiveSha256"])
    for name, blob in RECORDS.items():
        (inputs / name).chmod(0o644)
        require(git(source, "hash-object", str(inputs / name)) == blob, "transport blob differs: " + name)
    subprocess.run(["git", "-C", str(source), "add", "--", *[PREFIX + name for name in RECORDS]], check=True)
    subprocess.run(["git", "-C", str(source), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Checker comparison", "-c", "user.email=checker-comparison@example.invalid", "commit", "--no-verify", "-m", "chore: materialize frozen comparison inputs"], check=True, stdout=subprocess.DEVNULL)
    verify(source, inputs, True)
    node_archive = output / "node.tar.xz"
    download("https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz", node_archive, NODE_ARCHIVE)
    runtime = output / "runtime"
    runtime.mkdir()
    with tarfile.open(node_archive) as archive:
        require(all(item.name == "node-v24.16.0-linux-x64" or item.name.startswith("node-v24.16.0-linux-x64/") for item in archive.getmembers()), "Node archive paths differ")
        archive.extractall(runtime, filter="data")
    require(sha(runtime / "node-v24.16.0-linux-x64/bin/node") == NODE_BINARY, "Node executable differs")
    signal.alarm(0)
    print("[bun-matrix:prepared] source=" + SOURCE + " manifest=" + MANIFEST, flush=True)


def require_complete(receipt):
    require(receipt["completed"] and receipt["sourceVerified"] and receipt["clean"] == 38 and receipt["failures"] == 0 and len(receipt["rows"]) == 38, "successful process has incomplete matrix")


def run(source, payload, output):
    step_started = int(time.time() * 1000)
    require(not os.environ.get("GH_TOKEN") and not os.environ.get("GITHUB_TOKEN"), "compiler step must not receive GitHub credentials")
    inputs = source / PREFIX
    manifest = verify(source, inputs, True)
    node_bin = output / "runtime/node-v24.16.0-linux-x64/bin"
    require(sha(node_bin / "node") == NODE_BINARY, "Node executable differs")
    env = dict(os.environ)
    env.update(PATH=str(node_bin) + os.pathsep + env["PATH"], NODE_OPTIONS="", CI="1", COREPACK_HOME=str(output / "corepack"), PNPM_HOME=str(output / "pnpm"), PNPM_CONFIG_STORE_DIR=str(output / "pnpm-store"), PNPM_CONFIG_CACHE_DIR=str(output / "pnpm-cache"), TMPDIR=str(output / "tmp"))
    for name in ("tmp", "results"):
        (output / name).mkdir()
    require(subprocess.check_output(["node", "--version"], env=env, text=True, timeout=30).strip() == "v24.16.0", "Node version differs")
    require(subprocess.check_output(["corepack", "--version"], env=env, text=True, timeout=30).strip() == "0.35.0", "Corepack version differs")
    require(not (source / "node_modules").is_symlink(), "refusing dependency install through symlink")
    require(subprocess.check_output(["corepack", "pnpm", "--version"], cwd=source, env=env, text=True, timeout=120).strip() == "12.9.0", "pnpm version differs")
    subprocess.run(["timeout", "--signal=TERM", "--kill-after=5s", "900s", "corepack", "pnpm", "install", "--frozen-lockfile"], cwd=source, env=env, check=True)
    verify(source, inputs, True)
    deps = (source / "node_modules").resolve(strict=True)
    require(deps.is_relative_to(source), "dependencies escape source")
    dependency = {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sourceRoot": str(source), "node": "v24.16.0", "nodeBinarySha256": NODE_BINARY, "nodeArchiveSha256": NODE_ARCHIVE, "pnpm": "12.9.0", "nodeModules": str(deps), "files": {name: sha(source / name) for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml")}, "qualification": "successful frozen-lockfile install; frozen source/config verification before and after"}
    (output / "dependency-receipt.json").write_text(json.dumps(dependency, indent=2) + "\n")
    deadline = min(int(time.time() * 1000) + manifest["budgetSeconds"] * 1000, step_started + 5_610_000)
    env.update(BUN_MATRIX_OUTPUT_ROOT=str(output / "results"), BUN_MATRIX_DEADLINE_MS=str(deadline))
    print("[bun-matrix:ready] deadline_ms=" + str(deadline), flush=True)
    timeout_seconds = max(1, (deadline - int(time.time() * 1000)) // 1000 + 15)
    result = subprocess.run(["timeout", "--signal=TERM", "--kill-after=5s", str(timeout_seconds) + "s", "node", str(inputs / "runner.mjs")], cwd=source, env=env).returncode
    context = {key: os.environ.get(key) for key in ("GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "GITHUB_SHA")}
    status = {"phase": "matrix", "runExitCode": result, "source": SOURCE, "manifestSha256": MANIFEST, "deadlineOrigin": "hosted-run-step-budget", "workDeadlineMs": deadline, "hostedContext": context}
    (output / "run-status.json").write_text(json.dumps(status) + "\n")
    # Keep collection bounded before the step timeout.
    def collection_expired(signum, frame):
        raise TimeoutError("receipt collection deadline exceeded")
    signal.signal(signal.SIGALRM, collection_expired)
    signal.alarm(60)
    receipts = list((output / "results").glob("bun-matrix-*/receipt.json"))
    require(len(receipts) == 1, "expected exactly one complete or partial receipt")
    require(receipts[0].stat().st_size <= 256 * 1024 ** 2, "receipt exceeds bound")
    receipt = json.loads(receipts[0].read_bytes())
    require(receipt["identity"]["manifest"] == manifest, "receipt manifest differs")
    require(receipt["identity"]["bun"]["binarySha256"] == manifest["bun"]["binarySha256"], "receipt candidate differs")
    receipt["dependencyReceipt"] = dependency
    receipt["executionContext"] = status
    data = (json.dumps(receipt, separators=(",", ":")) + "\n").encode()
    require(len(data) <= 256 * 1024 ** 2, "receipt envelope exceeds bound")
    compressed = gzip.compress(data, compresslevel=1, mtime=0)
    require(len(compressed) <= 64 * 1024 ** 2, "compressed receipt exceeds bound")
    temporary = output / "receipt.json.gz.part"
    temporary.write_bytes(compressed)
    temporary.replace(output / "receipt.json.gz")
    executions = receipts[0].parent / "executions.jsonl"
    require(executions.stat().st_size <= 256 * 1024 ** 2, "execution record exceeds bound")
    packed_executions = gzip.compress(executions.read_bytes(), compresslevel=1, mtime=0)
    require(len(packed_executions) <= 64 * 1024 ** 2, "compressed execution record exceeds bound")
    temporary = output / "executions.jsonl.gz.part"
    temporary.write_bytes(packed_executions)
    temporary.replace(output / "executions.jsonl.gz")
    print("[bun-matrix:receipt] rows=" + str(len(receipt["rows"])) + " completed=" + str(receipt["completed"]).lower() + " run_exit=" + str(result), flush=True)
    if result == 0:
        require_complete(receipt)
    signal.alarm(0)
    return result


def execute(mode, source, payload, output):
    status_path = output / "run-status.json"
    context = {key: os.environ.get(key) for key in ("GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "GITHUB_SHA")}
    try:
        if mode == "prepare":
            prepare(source, payload, output)
            result = 0
            status = {"phase": "prepared", "runExitCode": None, "source": SOURCE, "manifestSha256": MANIFEST}
        else:
            result = run(source, payload, output)
            status = json.loads(status_path.read_text())
        status["adapterExitCode"] = result
        status["hostedContext"] = context
        status_path.write_text(json.dumps(status) + "\n")
        return result
    except Exception as error:
        status = json.loads(status_path.read_text()) if status_path.exists() else {"runExitCode": None, "source": SOURCE, "manifestSha256": MANIFEST}
        status.update(phase=mode, adapterExitCode=1, adapterFailure=str(error), hostedContext=context)
        # Preserve completed compiler evidence when sealing failed. Publish only
        # the missing format, never duplicate normal gzip artifacts or workspace.
        try:
            for raw, sealed, recovery in (("receipt.json", "receipt.json.gz", "receipt.recovery.json"), ("executions.jsonl", "executions.jsonl.gz", "executions.recovery.jsonl")):
                candidates = list((output / "results").glob("bun-matrix-*/" + raw))
                if not (output / sealed).exists() and len(candidates) == 1:
                    file = candidates[0]
                    require(not file.is_symlink() and file.is_file() and file.stat().st_size <= 256 * 1024 ** 2, "recovery file exceeds bound")
                    temporary = output / (recovery + ".part")
                    shutil.copyfile(file, temporary)
                    temporary.replace(output / recovery)
                    status.setdefault("recoveryFiles", []).append(recovery)
        except Exception as recovery_error:
            status["recoveryFailure"] = str(recovery_error)
        status_path.write_text(json.dumps(status) + "\n")
        raise
    finally:
        signal.alarm(0)


def main():
    require(len(sys.argv) == 5 and sys.argv[1] in ("prepare", "run"), "expected prepare|run SOURCE PAYLOAD OUTPUT")
    source, payload, output = [Path(arg).resolve(strict=True) for arg in sys.argv[2:]]
    require(str(output).startswith("/work/crabbox/") and not output.is_relative_to(source), "output must be separate task-owned work root")
    require(subprocess.check_output(["stat", "-f", "-c", "%T", str(output)], text=True).strip() != "tmpfs", "output is tmpfs")
    return execute(sys.argv[1], source, payload, output)


if __name__ == "__main__":
    sys.exit(main())
