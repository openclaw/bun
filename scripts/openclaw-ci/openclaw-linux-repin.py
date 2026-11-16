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
DOCTOR_FILE = "src/commands/doctor-maintenance.continuation-scope.test.ts"
DOCTOR_CASES = tuple(f"keeps Doctor continuation with its repair scope (cached writer: {writer})"
                     for writer in ("true", "false"))
ANCHOR_FILE = "src/process/supervisor/service-child-group-anchor.preparation.test.ts"
ANCHOR_PATCH_SHA256 = "163c821c27cc2f3b06897b760c41661e86b8b26b6ff8be5b9df99c85afd379bc"
ANCHOR_FILES = {
    ANCHOR_FILE: ("c06787c77d9ff318112146538be08dea0e24d79ac473f7211278bfe5fa31ed66", "a787c516c259e84dc9fcb148fee0f30dd5e2812dd4c589c23257ed3d02c21bd4"),
    "src/process/supervisor/service-child-group-anchor.preparation.test-support.ts": ("0f17b08a5b9fd79cd3be8129f251ce48544c5c6448db6542b5ef445b0fb49538", "3244ec4274485413b249ba6ee56517f7008c5c9ec468adb1b82dd22d6cc069a3"),
}
ANCHOR_CASES = {
    "prepare": "POSIX anchor preparation > prepares before spawning once with the accepted identity despite a duplicate start",
    **{"authority:" + key: "POSIX anchor preparation > keeps " + action + " authoritative when preparation resumes before startup-error acknowledgement"
       for key, action in (("cancel-term", "cancel TERM"), ("cancel-kill", "cancel KILL"), ("worker-close", "worker-close"), ("sigterm", "SIGTERM"))},
    **{f"retire:{key}:{cancelled}": f"POSIX anchor preparation > joins preparation retirement after {action} (cancelled={str(bool(cancelled)).lower()})"
       for key, action, cancelled in (("control-eof", "control EOF", 0), ("ipc-disconnect", "IPC disconnect", 0),
                                      ("parent-loss", "parent-loss", 0), ("control-eof", "control EOF", 1), ("ipc-disconnect", "IPC disconnect", 1))},
}
INVITATION_FILE = "src/config/sessions/session-mention-invitation.test.ts"
INVITATION_SOURCE_SHA256 = "a3fe4f0f54f7daceaa7ce53e1df5525f067cb5699b0096a6c527e366b24a8cf4"
INVITATION_CALLBACK_SHA256 = "1775321fae85b26fca81575d9910aa3118e8e67955cd9d1774d8335e3f310fe7"
INVITATION_SNAPSHOT_PAYLOAD_SHA256 = "8825703db3d3641c766049d27b3f0de54f51aefaf480522d2439308b60ce17bb"
INVITATION_SNAPSHOT_SHA256 = "8dbfbe3d355aa5e2fd1ed51600773607b146d2985bb71edc5054708fbae82daa"
READINESS_PATCH_SHA256 = "60c3550aa310570c0321c41b8218e7f5ac546b1f08d22ebc7e95ea700c737f60"
READINESS_FILES = {
    "resource-protocol.ts": ("3f66dcd70bc32b798930d3f11a8e575e0915206bb6ad5c0417a8ccb4975ed5c2", "a2fba54300e08f7a5107ffc0ce2cb2be095bc3553359b4d991ff881c27fa4458"),
    "host.ts": ("3360493ae2ad0488c4e480f4b7022fe37788d05b811c0fc075855a2a663047f1", "581988c7e085fa86738dc01011aafbd77fdaa7fe9ec22d521e12d2ded6bcf1fa"),
    "worker.ts": ("a58c07435184a536344a893ca0a4696fc26f9b9b908d93ead996dbf931194e61", "771bebb238901e8f7cf1652f57abb5b8579089ea8c82ad917d07dbb9664d00cc"),
    "resource-server.ts": ("e3b812ccf3224078b8f5b1f740c19a3867b6fa4288c9f93264ee053a411660c0", "60b535bc8b9c208d98a941a718d8a69a425bdc8efe203bde44ae368c63450171"),
    "resource-client.ts": ("7e81d67234b0ccf624c01907a6fc2b85df7b1c5d2f2f7e8358ce4f54da7657e9", "2eec3fd65fe93b8a1875206e34db13f2d6b6923e09086894b6097e6f51a20f50"),
    "child-diagnostics.ts": ("d30543707f2e8b2c7aff2c26395c843a04d3b26189112f0d166987c1f45e6468", "8f9050ac05a303da04d810253fec5b65b18b531c51bc2f38a38bda582988b646"),
}
INVITATION_CASES = (
    *(f"commits a tag and its invitation together before any Inbox work, without regranting on reopen (first: {first})" for first in ("false", "true")),
    *(f"rolls back the tag, grant and watermark when commit authority changes (first: {first})" for first in ("false", "true")),
    "keeps each first-session message's own watermark when invitations are deferred until session creation",
    "does not grant access when a message hook removes the selected token",
    "releases invitation callbacks and closes admissions after commit",
    "releases invitation callbacks and closes admissions after rollback",
)
common = runpy.run_path(str(Path(__file__).with_name("openclaw-repin-regression.py")))


def anchor_observations(log, exit_code):
    cases, summaries, frames = [], [], []
    prefix = "[shard:bun:core-runtime-infra-process-hosted-2]"
    events = set("fixture-created await-start await-complete child-exit child-disconnect fd-close closure-joined dispose-start kill-start kill-complete dispose-complete fact-received control-received overflow invalid".split())
    ops = set("first-fact loading duplicate-start ready-spawned root-result startup-error prepared closed dispose-closed lineage-loading lineage-loaded spawn command-exit ready closing stdin-closed worker-message result-error output output-end released".split())
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        if not line.startswith(prefix):
            continue
        body = line[len(prefix):].strip()
        if "[anchor-preparation-observer]" in body:
            assert body.startswith("[anchor-preparation-observer] "), "malformed anchor marker framing"
            assert len(line.encode()) <= 512, "anchor marker byte limit exceeded"
            row = json.loads(body.removeprefix("[anchor-preparation-observer] "))
            assert {"v", "case", "seq", "event"} <= set(row) <= {"v", "case", "seq", "event", "op", "fd", "code", "signal"}
            assert row["v"] == 1 and row["case"] in ANCHOR_CASES and row["event"] in events
            assert type(row["seq"]) is int and 1 <= row["seq"] <= 65
            assert "op" not in row or row["op"] in ops
            assert "fd" not in row or (type(row["fd"]) is int and 0 <= row["fd"] <= 6)
            assert "code" not in row or row["code"] is None or type(row["code"]) is int
            assert "signal" not in row or row["signal"] in {None, "SIGTERM", "SIGKILL"}
            if row["event"] == "fd-close":
                assert "fd" in row
            if row["event"] == "child-exit":
                assert {"code", "signal"} <= set(row)
            if row["event"] in {"await-start", "await-complete", "fact-received", "control-received"}:
                assert "op" in row
            frames.append(row)
            assert len(frames) <= 650, "anchor marker count exceeded"
            continue
        if body.startswith(("Test Files ", "Tests ")):
            summaries.append(body)
        if not re.search(r"\|[^|]+\|.* >(?: |$)", body):
            continue
        match = re.fullmatch(r"(.*?)\|([^|]+)\|\s+(.+?) > (.+?)(?: \d+(?:\.\d+)?ms)?", body)
        assert match and match[2] == "process" and match[3] == ANCHOR_FILE, "unexpected anchor case row"
        assert match[4] in ANCHOR_CASES.values(), "unexpected anchor case"
        marker = match[1].strip()
        if marker == "FAIL":
            continue
        assert marker in {"✓", "√", "×", "↓"}, "unsupported anchor case status"
        cases.append({"fullName": match[4], "status": {"✓": "passed", "√": "passed", "×": "failed", "↓": "skipped"}[marker]})
    assert len(cases) == 10 and {row["fullName"] for row in cases} == set(ANCHOR_CASES.values()), "incomplete or duplicate anchor cases"
    assert all(row["status"] in {"passed", "failed"} for row in cases), "anchor case skipped"
    assert exit_code != 0 or all(row["status"] == "passed" for row in cases), "successful exit contradicts failed anchor case"
    coverage, complete = {}, True
    for case in ANCHOR_CASES:
        rows = [row for row in frames if row["case"] == case]
        valid = (0 < len(rows) <= 64 and rows[0]["event"] == "fixture-created"
                 and [row["seq"] for row in rows] == list(range(1, len(rows) + 1))
                 and not any(row["event"] in {"overflow", "invalid"} for row in rows))
        complete &= valid
        coverage[case] = {"frames": len(rows), "framingComplete": valid, "last": rows[-1] if rows else None}
    return {"cases": cases, "nativeSummaries": summaries, "frames": frames,
            "frameCoverage": coverage, "framingComplete": complete,
            "limit": "bounded client-observed transitions; missing completion marker does not prove an event never occurred; logging perturbs timing"}


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


def invitation_snapshot_bytes(original):
    assert hashlib.sha256(original).hexdigest() == INVITATION_SOURCE_SHA256
    payload = Path(__file__).with_name("invitation-retainer-snapshot.ts").read_bytes()
    assert hashlib.sha256(payload).hexdigest() == INVITATION_SNAPSHOT_PAYLOAD_SHA256
    assert payload.count(b"export function ") == 3
    additions = (
        (b'import { queryObjects } from "node:v8";',
         b'import { queryObjects } from "node:v8";\nimport { generateHeapSnapshotForDebugging, jscDescribe } from "bun:jsc";'),
        (b"function fixture() {", payload.replace(b"export function ", b"function ") + b"\nfunction fixture() {"),
        (b"      async function settle() {", b"      let snapshotAddress: bigint | undefined;\n      async function settle() {"),
        (b'        const captured = { sentinel: "synthetic invitation callback" };', b'''        const captured = { sentinel: "synthetic invitation callback" };
        if (outcome === "commit") {
          try {
            snapshotAddress = invitationSnapshotAddress(jscDescribe(captured));
          } catch {
            // Missing address remains inconclusive; preserve the original assertions.
          }
        }'''),
        (b"      queryObjects(WeakRef);", b'''      queryObjects(WeakRef);
      if (outcome === "commit") {
        try {
          emitInvitationRetainerSnapshot(generateHeapSnapshotForDebugging(), snapshotAddress);
        } catch {
          emitInvitationRetainerSnapshot(undefined, snapshotAddress);
        }
      }'''),
    )
    patched = original
    for before, after in additions:
        assert patched.count(before) == 1
        patched = patched.replace(before, after)
    assert hashlib.sha256(patched).hexdigest() == INVITATION_SNAPSHOT_SHA256
    return patched


def snapshot_observations(log):
    rows = []
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        match = re.match(r"^(?:\[shard:[^]]+\] )?\[invitation-snapshot\] (.*)$", line)
        if match:
            assert len(line.encode()) <= 64 * 1024, "snapshot text budget exceeded"
            rows.append(json.loads(match[1]))
    assert len(rows) == 1, "snapshot evidence missing or duplicated"
    row = rows[0]
    assert row["version"] == 1 and row["kind"] == "commit-retainer-snapshot"
    assert row["diagnosticOnly"] is True and row["qualifiesRepin"] is False
    return row


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


def doctor_continuation_observations(log, exit_code):
    rows, summaries = [], []
    prefix = "[shard:bun:agentic-commands-doctor]"
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
        assert match[2] == "commands" and match[3] == DOCTOR_FILE, "unexpected diagnostic file"
        assert match[4] in DOCTOR_CASES, "unexpected diagnostic case"
        marker = match[1].strip()
        if marker == "FAIL":
            continue  # Native failure summaries repeat the primary case result.
        assert marker in {"✓", "√", "×", "↓"}, "unsupported diagnostic case status"
        rows.append({"file": match[3], "fullName": match[4],
                     "status": {"✓": "passed", "√": "passed", "×": "failed", "↓": "skipped"}[marker]})
    assert len(rows) == 2 and {row["fullName"] for row in rows} == set(DOCTOR_CASES), "incomplete or duplicate diagnostic cases"
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


def readiness_observations(log, causes):
    events = set("bootstrap-send bootstrap-callback bootstrap-error host-ipc-ready worker-bootstrap server-listen server-listening attach-decoded attach-rejected attach-duplicate attach-capacity attach-accepted ready-queued ready-written client-connected client-attach-written client-ready client-timeout evidence-limit framing-loss".split())
    codes = set("none unknown EACCES EADDRINUSE EADDRNOTAVAIL EAGAIN ECANCELED ECONNREFUSED ECONNRESET EINTR EINVAL EISCONN EMFILE ENFILE ENOBUFS ENOENT ENOMEM ENOTSOCK EPERM EPIPE ETIMEDOUT".split())
    counts, brokers, timeouts = {}, {}, set()
    digest, total = hashlib.sha256(), 0
    incomplete = False
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        match = re.match(r"^(?:\[shard:[^]]+\] )?\[doctor-readiness\] (.*)$", line)
        if not match:
            continue
        assert len(match[0].encode()) <= 1024, "oversized readiness frame"
        row = json.loads(match[1])
        assert list(row) == ["v", "event", "pid", "key", "generation", "id", "peer", "attempts", "code"]
        assert row["v"] == 1 and row["event"] in events and row["code"] in codes
        assert all(type(row[key]) is int and -1 <= row[key] <= 2**53 - 1 for key in ("pid", "key", "generation", "id", "peer", "attempts"))
        total += 1
        digest.update((match[1] + "\n").encode())
        counts[row["event"]] = counts.get(row["event"], 0) + 1
        incomplete |= row["event"] in {"evidence-limit", "framing-loss"}
        identity = (row["key"], row["generation"])
        if row["event"] in {"bootstrap-send", "host-ipc-ready", "worker-bootstrap", "server-listening"}:
            pid = row["peer"] if row["event"] in {"bootstrap-send", "host-ipc-ready"} else row["pid"]
            if pid > 0:
                brokers.setdefault(identity, set()).add(pid)
        if row["event"] == "client-timeout":
            timeouts.add((row["pid"], row["key"], row["generation"], row["id"]))
    # Bind the failed Doctor error to its own timeout frame, not neighboring file output.
    cause_ids = {tuple(map(int, values)) for values in re.findall(
        r"Spawn broker readiness deadline exceeded \[doctor-readiness pid=(\d+) key=(\d+) generation=(\d+) id=(\d+) ", json.dumps(causes))}
    bindings = [{"pid": pid, "key": key, "generation": generation, "id": attachment,
                 "brokerPids": sorted(brokers.get((key, generation), set()))}
                for pid, key, generation, attachment in sorted(cause_ids)]
    complete = (total > 0 and not incomplete and bool(cause_ids) and cause_ids <= timeouts
                and all(len(item["brokerPids"]) == 1 for item in bindings)
                and all(len(pids) == 1 for pids in brokers.values()))
    return {"frameCount": total, "framesSHA256": digest.hexdigest(), "eventCounts": counts,
            "causeBindings": bindings, "complete": complete, "rawEvidence": "native-shard.log",
            "correlationLimit": "noncryptographic 53-bit endpoint fingerprint; collisions remain possible; no global ordering or IPC-cause inference"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--controller-sha", required=True)
    parser.add_argument("--group", choices=GROUPS, required=True)
    parser.add_argument("--pin", choices=("old", "new"), required=True)
    parser.add_argument("--doctor-causes", action="store_true")
    parser.add_argument("--doctor-readiness", action="store_true")
    parser.add_argument("--invitation-retention", action="store_true")
    parser.add_argument("--invitation-native-callback", action="store_true")
    parser.add_argument("--invitation-snapshot", action="store_true")
    parser.add_argument("--anchor-preparation", action="store_true")
    parser.add_argument("--doctor-continuation", action="store_true")
    args = parser.parse_args()
    assert not args.doctor_continuation or (args.group == "large5" and not any((
        args.doctor_causes, args.doctor_readiness, args.invitation_retention,
        args.invitation_native_callback, args.invitation_snapshot, args.anchor_preparation)))
    assert not args.anchor_preparation or ((args.group, args.pin) == ("large42_process", "new")
                                          and not any((args.doctor_causes, args.doctor_readiness, args.invitation_retention,
                                                       args.invitation_native_callback, args.invitation_snapshot)))
    assert not args.invitation_snapshot or ((args.group, args.pin) == ("small4", "new")
                                           and not any((args.doctor_causes, args.doctor_readiness,
                                                        args.invitation_retention, args.invitation_native_callback)))
    assert not args.doctor_causes or (args.group, args.pin) == ("large5", "new")
    assert not args.doctor_readiness or ((args.group, args.pin) == ("large5", "new")
                                         and not args.doctor_causes and not args.invitation_retention
                                         and not args.invitation_native_callback)
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
    if args.doctor_causes or args.doctor_readiness or args.invitation_retention or args.invitation_native_callback or args.invitation_snapshot or args.anchor_preparation or args.doctor_continuation:
        report.update(diagnosticOnly=True, qualifiesRepin=False)
    candidate_bytes = None
    original_test_bytes = None
    readiness_originals = None
    anchor_originals = None
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
        if args.invitation_retention or args.invitation_native_callback or args.invitation_snapshot:
            assert len(selected["group"]["includePatterns"]) == 309 and INVITATION_FILE in selected["group"]["includePatterns"]
            effective_group = {**selected["group"], "includePatterns": [INVITATION_FILE]}
            group_json = json.dumps([effective_group], separators=(",", ":"))
            report["invitationRetention"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroup": effective_group, "effectiveGroupSHA256": hashlib.sha256(group_json.encode()).hexdigest(),
                "expectedCases": INVITATION_CASES,
                "scope": "standalone file; a pass does not explain or waive the original 309-file failure"}
        if args.anchor_preparation:
            assert len(selected["group"]["includePatterns"]) == 168 and ANCHOR_FILE in selected["group"]["includePatterns"]
            effective_group = {**selected["group"], "includePatterns": [ANCHOR_FILE]}
            group_json = json.dumps([effective_group], separators=(",", ":"))
            report["anchorPreparation"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroup": effective_group, "effectiveGroupSHA256": hashlib.sha256(group_json.encode()).hexdigest(),
                "expectedCases": ANCHOR_CASES,
                "scope": "instrumented ten-case standalone file; not unchanged-C or whole-group qualification"}
        if args.doctor_continuation:
            assert len(selected["group"]["includePatterns"]) == 116 and DOCTOR_FILE in selected["group"]["includePatterns"]
            effective_group = {**selected["group"], "includePatterns": [DOCTOR_FILE]}
            group_json = json.dumps([effective_group], separators=(",", ":"))
            report["doctorContinuation"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroup": effective_group, "effectiveGroupSHA256": hashlib.sha256(group_json.encode()).hexdigest(),
                "sourceFileSHA256": common["sha"](source / DOCTOR_FILE), "expectedCases": DOCTOR_CASES,
                "scope": "unchanged standalone two-case file; both-pass leaves context or timing unresolved and does not waive the original 116-file failure"}
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
        if args.doctor_causes or args.doctor_readiness:
            observer = Path(__file__).with_name("doctor-cause-reporter.mjs").resolve()
            assert observer.is_file() and not observer.is_relative_to(source)
            effective_args = ["--reporter=verbose", "--reporter=github-actions", "--reporter=" + str(observer)]
            report["observer"] = {"diagnosticOnly": True, "qualifiesRepin": False,
                                  "originalVitestArgs": [], "effectiveVitestArgs": effective_args,
                                  "sha256": common["sha"](observer)}
            env["OPENCLAW_NODE_TEST_VITEST_ARGS_JSON"] = json.dumps(effective_args)
        report.update(command=selected["nativeArgv"], childEnvironment=env)
        if args.doctor_readiness:
            patch = Path(__file__).with_name("doctor-readiness.patch").resolve()
            assert common["sha"](patch) == READINESS_PATCH_SHA256
            paths = {name: source / "src/process/spawn-broker" / name for name in READINESS_FILES}
            assert all(path.is_file() and not path.is_symlink() and common["sha"](path) == READINESS_FILES[name][0]
                       for name, path in paths.items()), "readiness source differs from exact candidate"
            assert not git("diff", "HEAD", "--name-only")
            git("apply", "--check", str(patch))
            readiness_originals = {name: path.read_bytes() for name, path in paths.items()}
            report["readinessProjection"] = {"state": "prepared", "patchSHA256": READINESS_PATCH_SHA256,
                "files": {"src/process/spawn-broker/" + name: {"originalSHA256": hashes[0], "patchedSHA256": hashes[1]}
                          for name, hashes in READINESS_FILES.items()},
                "egress": "2048 fixed frames plus one limit marker per loaded diagnostic module instance; each frame below512B; whole native log32MiB",
                "scope": "instrumented readiness diagnosis only; stderr writes and hashing can perturb scheduling; no added Promise continuation, wait, retry or timeout"}
            save()
            git("apply", "--whitespace=nowarn", str(patch))
            report["readinessProjection"]["state"] = "applied"
            assert all(common["sha"](path) == READINESS_FILES[name][1] for name, path in paths.items())
            assert set(git("diff", "HEAD", "--name-only").splitlines()) == set(report["readinessProjection"]["files"])
        if args.anchor_preparation:
            patch = Path(__file__).with_name("anchor-preparation-observer.patch").resolve()
            assert common["sha"](patch) == ANCHOR_PATCH_SHA256
            anchor_paths = {name: source / name for name in ANCHOR_FILES}
            assert all(path.is_file() and not path.is_symlink() and common["sha"](path) == ANCHOR_FILES[name][0]
                       for name, path in anchor_paths.items()), "anchor source differs from exact candidate"
            assert not git("diff", "HEAD", "--name-only")
            git("apply", "--check", str(patch))
            anchor_originals = {name: path.read_bytes() for name, path in anchor_paths.items()}
            report["anchorProjection"] = {"state": "prepared", "patchSHA256": ANCHOR_PATCH_SHA256,
                "files": {name: {"originalSHA256": hashes[0], "patchedSHA256": hashes[1]} for name, hashes in ANCHOR_FILES.items()},
                "egress": "64 fixed markers per case plus one overflow; no raw payload, path or stderr; native log32MiB",
                "scope": "temporary test/fixture observer only; no additional waits, listeners, promise reactions, ACKs or cleanup; production anchor unchanged"}
            save()
            git("apply", "--whitespace=nowarn", str(patch))
            report["anchorProjection"]["state"] = "applied"
            assert all(common["sha"](path) == ANCHOR_FILES[name][1] for name, path in anchor_paths.items())
            assert set(git("diff", "HEAD", "--name-only").splitlines()) == set(ANCHOR_FILES)
        if args.invitation_native_callback or args.invitation_snapshot:
            test_path = source / INVITATION_FILE
            assert test_path.is_file() and not test_path.is_symlink()
            original = test_path.read_bytes()
            patched = invitation_snapshot_bytes(original) if args.invitation_snapshot else invitation_callback_bytes(original)
            patched_test_sha = INVITATION_SNAPSHOT_SHA256 if args.invitation_snapshot else INVITATION_CALLBACK_SHA256
            report["testProjection"] = {"path": INVITATION_FILE, "state": "prepared",
                "originalSHA256": INVITATION_SOURCE_SHA256, "patchedSHA256": patched_test_sha,
                "diff": "".join(difflib.unified_diff(original.decode().splitlines(True),
                    patched.decode().splitlines(True), fromfile="a/" + INVITATION_FILE, tofile="b/" + INVITATION_FILE)),
                "scope": "one immediate and one GC per retention case; Promise/closure roots and GC/resumption ordering differ; no qualification or leak-cause verdict"}
            if args.invitation_snapshot:
                report["testProjection"].update(payloadSHA256=INVITATION_SNAPSHOT_PAYLOAD_SHA256,
                    scope="commit-only address capture and one synchronous debug snapshot after original timer/queryObjects; extra full GC and allocation/root/layout perturbation; reported structure only, no strong-retainer, scanner, leak-cause or qualification verdict")
            original_test_bytes = original
            test_path.write_bytes(patched)
            report["testProjection"]["state"] = "applied"
            assert common["sha"](test_path) == patched_test_sha
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
        if args.doctor_continuation:
            report["doctorContinuation"].update(doctor_continuation_observations(log, outcome["exitCode"]))
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            report["status"] = "DIAGNOSTIC"
        elif args.anchor_preparation:
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            report["anchorPreparation"].update(anchor_observations(log, outcome["exitCode"]))
            assert report["anchorPreparation"]["framingComplete"], "anchor observation missing, capped, invalid or interrupted"
            report["status"] = "DIAGNOSTIC"
        elif args.invitation_retention or args.invitation_native_callback or args.invitation_snapshot:
            report["invitationRetention"].update(invitation_observations(log, outcome["exitCode"]))
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            if args.invitation_snapshot:
                report["snapshot"] = snapshot_observations(log)
                assert report["snapshot"]["complete"] is True, "snapshot identity or reported structure incomplete; no absence inference"
            report["status"] = "DIAGNOSTIC"
        elif args.doctor_causes or args.doctor_readiness:
            report["observer"]["records"] = doctor_observations(log)
            if args.doctor_readiness:
                report["readiness"] = readiness_observations(log, report["observer"]["records"])
                assert report["readiness"]["complete"], "readiness evidence missing, capped, conflicting or not reproduced"
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
            if readiness_originals is not None:
                report["readinessProjection"]["state"] = "retained-indeterminate-settlement"
            if anchor_originals is not None:
                report["anchorProjection"]["state"] = "retained-indeterminate-settlement"
        elif candidate_bytes is not None:
            restore_allowed = original_test_bytes is None or (test_path.is_file() and not test_path.is_symlink()
                              and common["sha"](test_path) == patched_test_sha)
            if readiness_originals is not None:
                restore_allowed = all(path.is_file() and not path.is_symlink() and common["sha"](path) == READINESS_FILES[name][1]
                                      for name, path in paths.items())
                restore_allowed &= set(git("diff", "HEAD", "--name-only").splitlines()) == set(report["readinessProjection"]["files"])
                if restore_allowed:
                    for name, original in readiness_originals.items():
                        paths[name].write_bytes(original)
                    report["readinessProjection"]["state"] = "restored"
                else:
                    report["readinessProjection"]["state"] = "retained-unexpected-source-bytes"
            if anchor_originals is not None:
                restore_allowed = all(path.is_file() and not path.is_symlink() and common["sha"](path) == ANCHOR_FILES[name][1]
                                      for name, path in anchor_paths.items())
                restore_allowed &= set(git("diff", "HEAD", "--name-only").splitlines()) == set(ANCHOR_FILES)
                if restore_allowed:
                    for name, original in anchor_originals.items():
                        anchor_paths[name].write_bytes(original)
                    report["anchorProjection"]["state"] = "restored"
                else:
                    report["anchorProjection"]["state"] = "retained-unexpected-source-bytes"
            if restore_allowed:
                if original_test_bytes is not None:
                    (source / INVITATION_FILE).write_bytes(original_test_bytes)
                    report["testProjection"].update(state="restored", restoredSHA256=common["sha"](source / INVITATION_FILE))
                    assert report["testProjection"]["restoredSHA256"] == INVITATION_SOURCE_SHA256
                (source / common["PIN"]).write_bytes(candidate_bytes)
                report["candidatePinRestored"] = (source / common["PIN"]).read_bytes() == candidate_bytes
            else:
                if original_test_bytes is not None:
                    report["testProjection"]["state"] = "retained-unexpected-test-bytes"
                report.update(status="INCONCLUSIVE", error="diagnostic source changed unexpectedly; no restoration attempted")
            report["trackedSourceClean"] = not git("status", "--porcelain", "--untracked-files=no")
            if not report["trackedSourceClean"]:
                report.update(status="INCONCLUSIVE", error="tracked source changed")
        save()
        assert report.get("trackedSourceClean", True), "tracked source changed"


if __name__ == "__main__":
    main()
