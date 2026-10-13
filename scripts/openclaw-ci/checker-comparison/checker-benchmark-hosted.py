#!/usr/bin/env python3
"""Run beside hosted.py after its reviewed prepare_dependencies extraction."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

import hosted

DRIVER_SHA256 = "326dfb5fba65fa73d946316ee79adfea470daf4d06be6d0731cdbaf47c2e4f9f"
DRIVER_PATH = "tools/checker-compare.mts"


def write_status(output, status):
    temporary = output / "benchmark-status.json.part"
    temporary.write_text(json.dumps(status) + "\n")
    temporary.replace(output / "benchmark-status.json")


def run(source, output, receipt, receipt_sha256, status, parent_deadline):
    hosted.require(output.is_relative_to(Path("/work/crabbox")) and not output.is_relative_to(source), "output must be a separate task-owned work root")
    hosted.require(subprocess.check_output(["stat", "-f", "-c", "%T", str(output)], text=True).strip() != "tmpfs", "output is tmpfs")
    hosted.require(not receipt.is_relative_to(source), "completed matrix receipt must be external")
    hosted.require(receipt.stat().st_size <= 256 * 1024 ** 2 and hosted.sha(receipt) == receipt_sha256, "completed matrix receipt hash or size differs")
    proof = json.loads(receipt.read_bytes())
    hosted.require_complete(proof)
    manifest = hosted.verify(source, source / hosted.PREFIX, True)
    hosted.require(proof["identity"]["manifest"] == manifest, "completed matrix manifest differs")
    driver = Path(__file__).with_name("checker-compare.mts")
    hosted.require(driver.is_file() and not driver.is_symlink() and hosted.sha(driver) == DRIVER_SHA256, "comparator source differs")

    # Keep the matrix's dependency preparation unchanged. Only the comparator
    # owns source verification once its eighth transport is committed below.
    prepared_manifest, env, _dependency = hosted.prepare_dependencies(source, output)
    hosted.require(prepared_manifest == manifest, "prepared manifest differs")
    archive = output / "final-bun.tar.gz"
    shutil.copyfile(source / hosted.PREFIX / "binary.archive", archive)
    hosted.require(hosted.sha(archive) == manifest["bun"]["archiveSha256"], "external Bun archive differs")
    binary = output / "final-bun"
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        hosted.require(len(members) == 1 and members[0].name == "bun" and members[0].isfile(), "Bun archive entries differ")
        with bundle.extractfile(members[0]) as src, binary.open("xb") as dst:
            shutil.copyfileobj(src, dst)
    binary.chmod(0o755)
    hosted.require(hosted.sha(binary) == manifest["bun"]["binarySha256"], "Bun executable differs")

    target = source / DRIVER_PATH
    hosted.require(not target.exists() and not target.is_symlink(), "comparator target already exists")
    shutil.copyfile(driver, target)
    target.chmod(0o644)
    subprocess.run(["git", "-C", str(source), "add", "--", DRIVER_PATH], check=True)
    subprocess.run(["git", "-C", str(source), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Checker comparison", "-c", "user.email=checker-comparison@example.invalid", "commit", "--no-verify", "-m", "chore: materialize frozen comparator"], check=True, stdout=subprocess.DEVNULL)

    bun = manifest["bun"]
    command = [
        str(output / "runtime/node-v24.16.0-linux-x64/bin/node"), str(target),
        "--phase", "timing", "--graphs", "core,ui", "--repetitions", "3",
        "--driver-sha256", DRIVER_SHA256,
        "--discovery-receipt", str(receipt), "--discovery-receipt-sha256", receipt_sha256,
        "--bun-bin", str(binary), "--bun-sha256", bun["binarySha256"],
        "--bun-artifact", str(archive), "--bun-artifact-sha256", bun["archiveSha256"],
        "--bun-source", bun["source"], "--bun-revision", bun["revision"], "--bun-version", bun["version"],
    ]
    # Bun adds annotation lines under Actions; keep the strict compiler stream
    # while preserving CI and the outer job's hosted context.
    env = dict(env)
    env.pop("GITHUB_ACTIONS", None)
    env.update(CI="true", OPENCLAW_LOCAL_CHECK="0")
    cohort = status["cohort"]
    remaining = int(min(parent_deadline - 5, time.monotonic() + 3600) - time.monotonic())
    if remaining <= 0:
        cohort.update(outcome="not-run", reason="comparison budget exhausted")
        return 1
    cohort_output = output / "benchmark" / cohort["native"]
    cohort.update(outcome="running", budgetSeconds=remaining)
    write_status(output, status)
    result = subprocess.run([
        "timeout", "--signal=TERM", "--kill-after=5s", f"{remaining}s", *command,
        "--native", cohort["native"], "--out", str(cohort_output),
        "--budget-seconds", str(remaining),
    ], cwd=source, env=env).returncode
    summaries = list(cohort_output.glob("timing-*/summary.json"))
    completed = len(summaries) == 1 and json.loads(summaries[0].read_bytes()).get("completed") is True
    cohort.update(outcome="passed" if result == 0 and completed else "failed", runExitCode=result, completed=completed)
    write_status(output, status)
    return 0 if cohort["outcome"] == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--receipt-sha256", required=True)
    parser.add_argument("--native", choices=("current",), required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(strict=True), args.output.resolve(strict=True)
    status = {"phase": "benchmark", "source": hosted.SOURCE, "manifestSha256": hosted.MANIFEST, "driverSha256": DRIVER_SHA256, "matrixReceiptSha256": args.receipt_sha256, "runExitCode": None, "comparisonBudgetSeconds": 3600, "outerWatchdogSeconds": 4500, "cohort": {"native": args.native, "outcome": "pending"}, "hostedContext": {key: os.environ.get(key) for key in ("GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "GITHUB_SHA")}}
    parent_deadline = time.monotonic() + 4500
    try:
        result = run(source, output, args.receipt.resolve(strict=True), args.receipt_sha256, status, parent_deadline)
        status.update(runExitCode=result, adapterExitCode=result)
        return result
    except Exception as error:
        status.update(adapterExitCode=1, adapterFailure=str(error))
        if status["cohort"]["outcome"] == "pending":
            status["cohort"].update(outcome="not-run", reason="adapter failed before this cohort")
        raise
    finally:
        write_status(output, status)


if __name__ == "__main__":
    raise SystemExit(main())
