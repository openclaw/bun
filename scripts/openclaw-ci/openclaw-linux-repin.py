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
DOCTOR_PHASE_PATCH_SHA256 = "033fdf2c27913a7b8fc23ffc09da536ab9f21052054090a42b8c387591aff800"
DOCTOR_PHASE_FILES = {
    DOCTOR_FILE: ("31af4b9968716bf8e4ccade9b184bd810bb4e3096df3488d4a6f66f3d1a34f2f", "a8f0f9d3f39d7c940f118e2c17a5abb671f5ce109481cea4c42ff539f495d3c0"),
    "src/commands/doctor-maintenance.admission.test-support.ts": ("c358cb66f0e72f5cbfc0a26b61527244bcede760241186e4115ef29c7a1e7ea0", "14d8caac91f0b61edb33f6c21a60d879c1315cbd543f08a43c37fa6fb419c0a2"),
}
DOCTOR_FIX_PATCH_SHA256 = "52547c05cb53bd50ec5651040dbb032e219d6cd8d49b9d47c5f0ec1972cc0769"
DOCTOR_FIX_FILES = {
    "src/commands/doctor-maintenance.admission.test-support.ts": ("c358cb66f0e72f5cbfc0a26b61527244bcede760241186e4115ef29c7a1e7ea0", "114b1ea7e442eb93dac9891a8ee0ba1593cc9ee023f0fd124f7c5e89196a8082"),
}
DOCTOR_FIXTURE_PHASE_FILES = {
    **DOCTOR_PHASE_FILES,
    "src/commands/doctor-maintenance.admission.test-support.ts": ("c358cb66f0e72f5cbfc0a26b61527244bcede760241186e4115ef29c7a1e7ea0", "7efacfdacbbdb03b362dff13bce168b074785cbab40e343116c614335f71c981"),
}
ANCHOR_FILE = "src/process/supervisor/service-child-group-anchor.preparation.test.ts"
ANCHOR_GROUP_SHA256 = "002349c7fe78370a021dec47798239fe9d9acedd9779dc9473699b7060db2c56"
ANCHOR_PATCH_SHA256 = "616e96a98212e57d6405656a043384d8d77199d6e6ea6529238ee6e61971ee75"
ANCHOR_FILES = {
    ANCHOR_FILE: ("c06787c77d9ff318112146538be08dea0e24d79ac473f7211278bfe5fa31ed66", "a787c516c259e84dc9fcb148fee0f30dd5e2812dd4c589c23257ed3d02c21bd4"),
    "src/process/supervisor/service-child-group-anchor.preparation.test-support.ts": ("0f17b08a5b9fd79cd3be8129f251ce48544c5c6448db6542b5ef445b0fb49538", "27d71cd9f4f539541582f3b6d8f978b6ffeab2996d6e1bba619fa192673f2c52"),
}
ANCHOR_FIX_COMMIT = "bbebe49faffb1adb286e53a977d078df91951a9d"
ANCHOR_FIX_FILE = "src/process/supervisor/service-child-group-anchor.preparation.test-support.ts"
ANCHOR_FIX_PATCH_SHA256 = "b77fd5687c6c58867bdc58786cccd584aefeb8101d2b0b9e7da65f6b0b7a5f2e"
ANCHOR_FIX_SHA256 = "288e3370a48cd5911e3f2bca77c07cc2eeaf225422414e008c23a0049beae485"
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
INVITATION_OWNER_CUT_SHA256 = "1538b03ef36b0f57b5fe62dc89de2de6524c44aa97b10cc0f74a5ef22ca353ae"
INVITATION_REFERENCES_SHA256 = "0cbb0453e94e48f51abd54ff708ccf5f636a7cccc3b186addae175c4b1819e7f"
INVITATION_OPERATIONS_SHA256 = "f51f94f08ab876f8c3a59396f876fa967ef7c1549f669a9904bd2b106d0209a4"
INVITATION_OPERATION_FILE = "src/config/sessions/session-entry-patch.ts"
INVITATION_OPERATION_SOURCE_SHA256 = "3b0a83b7733deb1269cb4ee406781ba870251b8a1f6797ee943f69f964d325ff"
INVITATION_OPERATION_PATCHED_SHA256 = "c9a98f8da836c79f49357d27801fd2c73bf32eca9a3a15c6c3da429ff5bcb0b7"
INVITATION_REDUCTION_SHA256 = "35ad033d173eb5e860395032eeb303c2527d3c9e623c72fb404ab01d002a8449"
INVITATION_REDUCTION_CASES = tuple(f"releases reduced invitation callbacks after {outcome}" for outcome in ("commit", "rollback"))
INVITATION_CALLBACK_SHA256 = "1775321fae85b26fca81575d9910aa3118e8e67955cd9d1774d8335e3f310fe7"
INVITATION_SNAPSHOT_PAYLOAD_SHA256 = "69473344a9e3a29e74c72552c9b43b98be691c274869ecd4a917bfe9d66cf67b"
INVITATION_SNAPSHOT_SHA256 = "f03c29b4b9b38678328ef5f0d63e593af4a7ca847095a41f86175cd23163b695"
READINESS_PATCH_SHA256 = "cb2aedd7cf89ae1298d1335fcc461ca932060a58b63a1489a128eef57ba94b4c"
READINESS_FILES = {
    "src/process/spawn-broker/resource-protocol.ts": ("3f66dcd70bc32b798930d3f11a8e575e0915206bb6ad5c0417a8ccb4975ed5c2", "89cdfbb498eb09cd6233459ac6d8c1ba74cd4c53e8f20bf79f7cc8ffce411d68"),
    "src/process/spawn-broker/host.ts": ("3360493ae2ad0488c4e480f4b7022fe37788d05b811c0fc075855a2a663047f1", "581988c7e085fa86738dc01011aafbd77fdaa7fe9ec22d521e12d2ded6bcf1fa"),
    "src/process/spawn-broker/worker.ts": ("a58c07435184a536344a893ca0a4696fc26f9b9b908d93ead996dbf931194e61", "068b39612a2d05811be9b317cc4691e5c09633a2f6b22a727124a23931531c24"),
    "src/process/spawn-broker/resource-server.ts": ("e3b812ccf3224078b8f5b1f740c19a3867b6fa4288c9f93264ee053a411660c0", "60b535bc8b9c208d98a941a718d8a69a425bdc8efe203bde44ae368c63450171"),
    "src/process/spawn-broker/resource-client.ts": ("7e81d67234b0ccf624c01907a6fc2b85df7b1c5d2f2f7e8358ce4f54da7657e9", "2eec3fd65fe93b8a1875206e34db13f2d6b6923e09086894b6097e6f51a20f50"),
    "src/process/spawn-broker/child-diagnostics.ts": ("d30543707f2e8b2c7aff2c26395c843a04d3b26189112f0d166987c1f45e6468", "8f9050ac05a303da04d810253fec5b65b18b531c51bc2f38a38bda582988b646"),
    "src/commands/doctor-maintenance.admission.test-support.ts": ("c358cb66f0e72f5cbfc0a26b61527244bcede760241186e4115ef29c7a1e7ea0", "b4e7af2bc382865152d6178185db17b66b46048259159ba4816ee4d747ede90b"),
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


def anchor_observations(log, exit_code, full_context=False):
    cases, summaries, frames = [], [], []
    prefix = "[shard:bun:core-runtime-infra-process-hosted-2]"
    events = set("fixture-created await-start await-complete child-exit child-disconnect fd-close closure-joined dispose-start kill-start kill-complete dispose-complete fact-received control-received overflow invalid".split())
    ops = set("first-fact loading duplicate-start ready-spawned root-result startup-error prepared closed dispose-closed lineage-loading lineage-loaded spawn command-exit ready closing stdin-closed worker-message result-error output output-end released loader-start-before-owner loader-start-after-owner loader-start-owner-unconfirmed loader-owner-listener-installed".split())
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
        assert match, "malformed anchor case row"
        if full_context and match[3] != ANCHOR_FILE:
            continue  # Other native cases remain in the original log and broad summaries.
        assert match[2] == "process" and match[3] == ANCHOR_FILE, "unexpected anchor case row"
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


def invitation_references_bytes(original, operations=False):
    assert hashlib.sha256(original).hexdigest() == INVITATION_SOURCE_SHA256
    additions = (
        (b"      async function settle() {", b"""      const references: Partial<Record<"preparation" | "guard" | "write", WeakRef<object>>> = {};
      function observePreparation<T extends { prepareMentionInvitation: object }>(value: T): T {
        references.preparation = new WeakRef(value.prepareMentionInvitation);
        return value;
      }
      function observePrepared<T extends { assertCurrent: object }>(value: T): T {
        references.guard = new WeakRef(value.assertCurrent);
        return value;
      }
      async function settle() {"""),
        (b"              workerPreparation: {\n                prepareMentionInvitation: () => {", b"""              workerPreparation: observePreparation({
                prepareMentionInvitation: () => {"""),
        (b"                  return {\n                    invitation: f.invitation(\"bob\"),", b"""                  return observePrepared({
                    invitation: f.invitation("bob"),"""),
        (b"                  };\n                },\n              },", b"""                  });
                },
              }),"""),
        (b'          updateMode: "none",\n        });\n        if (outcome === "rollback")', b'''          updateMode: "none",
        });
        references.write = new WeakRef(write);
        if (outcome === "rollback")'''),
        (b"      queryObjects(WeakRef);", b"""      queryObjects(WeakRef);
      process.stderr.write("[invitation-references] " + JSON.stringify({
        version: 1,
        outcome,
        preparationAlive: references.preparation ? references.preparation.deref() !== undefined : null,
        guardAlive: references.guard ? references.guard.deref() !== undefined : null,
        writeAlive: references.write ? references.write.deref() !== undefined : null,
        sentinelAlive: reference.deref() !== undefined,
        controlAlive: control.deref() !== undefined,
      }) + "\\n");"""),
    )
    patched = original
    for before, after in additions:
        assert patched.count(before) == 1
        patched = patched.replace(before, after)
    assert hashlib.sha256(patched).hexdigest() == INVITATION_REFERENCES_SHA256
    if operations:
        additions = (
            (b'import * as admission from "../../infra/sqlite-worker-operation-admission.js";',
             b'import * as admission from "../../infra/sqlite-worker-operation-admission.js";\nimport { invitationOperationReferences as operationReferences } from "./session-entry-patch.js";'),
            (b'      const references: Partial<Record<"preparation"', b'''      operationReferences.length = 0;
      const references: Partial<Record<"preparation"'''),
            (b"      expect(control.deref()).toBeUndefined();", b'''      process.stderr.write("[invitation-operations] " + JSON.stringify({
        version: 1,
        outcome,
        operations: operationReferences.map((operation) => ({
          paramsAlive: operation.params.deref() !== undefined,
          runAlive: operation.run.deref() !== undefined,
          acknowledgedAlive: operation.acknowledged ? operation.acknowledged.deref() !== undefined : null,
          committedAlive: operation.committed.deref() !== undefined,
        })),
      }) + "\\n");
      expect(control.deref()).toBeUndefined();'''),
        )
        for before, after in additions:
            assert patched.count(before) == 1
            patched = patched.replace(before, after)
        assert hashlib.sha256(patched).hexdigest() == INVITATION_OPERATIONS_SHA256
    return patched


def invitation_operation_bytes(original):
    assert hashlib.sha256(original).hexdigest() == INVITATION_OPERATION_SOURCE_SHA256
    before = b"export async function runSessionEntryWorkerOperation<"
    declaration = b"""export const invitationOperationReferences: Array<{
  params: WeakRef<object>;
  run: WeakRef<object>;
  acknowledged: WeakRef<object> | undefined;
  committed: WeakRef<object>;
}> = [];

export async function runSessionEntryWorkerOperation<"""
    entry = b"""}): Promise<Result> {
  if (params.candidateKind === "session-turn") {
    invitationOperationReferences.push({
      params: new WeakRef(params),
      run: new WeakRef(params.run),
      acknowledged: params.onAcknowledged ? new WeakRef(params.onAcknowledged) : undefined,
      committed: new WeakRef(params.onCommitted),
    });
  }
  let publication:"""
    assert original.count(before) == original.count(b"}): Promise<Result> {\n  let publication:") == 1
    patched = original.replace(before, declaration).replace(b"}): Promise<Result> {\n  let publication:", entry)
    assert hashlib.sha256(patched).hexdigest() == INVITATION_OPERATION_PATCHED_SHA256
    return patched


def invitation_references_observations(log):
    rows = []
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        match = re.fullmatch(r"(?:\[shard:bun:core-runtime-config-hosted-3\] )?\[invitation-references\] (.*)", line)
        if not match:
            continue
        assert len(line.encode()) <= 512, "reference marker exceeds byte budget"
        row = json.loads(match[1])
        assert set(row) == {"version", "outcome", "preparationAlive", "guardAlive", "writeAlive", "sentinelAlive", "controlAlive"}
        assert type(row["version"]) is int and row["version"] == 1 and row["outcome"] in {"commit", "rollback"}
        assert all(type(row[key]) is bool for key in ("preparationAlive", "guardAlive", "writeAlive", "sentinelAlive", "controlAlive"))
        rows.append(row)
    assert len(rows) == 2 and {row["outcome"] for row in rows} == {"commit", "rollback"}, "reference cases missing or duplicated"
    return {"cases": rows, "diagnosticOnly": True, "qualifiesRepin": False,
            "scope": "WeakRefs to original preparation, guard and persistence Promise; original timer, GC and assertions retained",
            "limit": "instrumentation changes allocation and closure layout; liveness alone does not identify a retainer"}


def invitation_operations_observations(log):
    rows = []
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        match = re.fullmatch(r"(?:\[shard:bun:core-runtime-config-hosted-3\] )?\[invitation-operations\] (.*)", line)
        if not match:
            continue
        assert len(line.encode()) <= 2048, "operation marker exceeds byte budget"
        row = json.loads(match[1])
        assert set(row) == {"version", "outcome", "operations"}
        assert type(row["version"]) is int and row["version"] == 1 and row["outcome"] in {"commit", "rollback"}
        assert isinstance(row["operations"], list) and 0 < len(row["operations"]) <= 8
        for operation in row["operations"]:
            assert set(operation) == {"paramsAlive", "runAlive", "acknowledgedAlive", "committedAlive"}
            assert all(type(value) is bool for value in operation.values())
        rows.append(row)
    assert len(rows) == 2 and {row["outcome"] for row in rows} == {"commit", "rollback"}, "operation cases missing or duplicated"
    return {"cases": rows, "diagnosticOnly": True, "qualifiesRepin": False,
            "scope": "direct operation-entry WeakRefs; original call, result and GC ordering retained without Promise observers",
            "limit": "allocation and module layout change; collection excludes these identities, not all internal continuations"}


def invitation_owner_cut_bytes(original):
    assert hashlib.sha256(original).hexdigest() == INVITATION_SOURCE_SHA256
    before = b"      const control = new WeakRef({});"
    after = b"""      const closedOwnerReferences = owners.map((owner) => new WeakRef(owner));
      owners.length = 0;
      transactionOwners.clear();
      const control = new WeakRef({});"""
    observation = b"""      queryObjects(WeakRef);
      process.stderr.write("[invitation-owner-cut] " + JSON.stringify({
        version: 1,
        outcome,
        ownerCount: closedOwnerReferences.length,
        survivingOwners: closedOwnerReferences.filter((owner) => owner.deref() !== undefined).length,
        sentinelAlive: reference.deref() !== undefined,
        controlAlive: control.deref() !== undefined,
      }) + "\\n");"""
    assert original.count(before) == original.count(b"      queryObjects(WeakRef);") == 1
    patched = original.replace(before, after).replace(b"      queryObjects(WeakRef);", observation)
    assert hashlib.sha256(patched).hexdigest() == INVITATION_OWNER_CUT_SHA256
    return patched


def invitation_owner_cut_observations(log):
    rows = []
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        match = re.fullmatch(r"(?:\[shard:bun:core-runtime-config-hosted-3\] )?\[invitation-owner-cut\] (.*)", line)
        if not match:
            continue
        assert len(line.encode()) <= 512, "owner-cut marker exceeds byte budget"
        row = json.loads(match[1])
        assert set(row) == {"version", "outcome", "ownerCount", "survivingOwners", "sentinelAlive", "controlAlive"}
        assert row["version"] == 1 and row["outcome"] in {"commit", "rollback"}
        assert type(row["ownerCount"]) is int and 0 < row["ownerCount"] <= 1024
        assert type(row["survivingOwners"]) is int and 0 <= row["survivingOwners"] <= row["ownerCount"]
        assert type(row["sentinelAlive"]) is bool and type(row["controlAlive"]) is bool
        rows.append(row)
    assert len(rows) == 2 and {row["outcome"] for row in rows} == {"commit", "rollback"}, "owner-cut cases missing or duplicated"
    return {"cases": rows, "diagnosticOnly": True, "qualifiesRepin": False,
            "scope": "closed admission roots removed after their original assertions; original timer, GC and assertions retained",
            "limit": "allocation and root removal can change collection; surviving admissions leave the owner hypothesis unresolved"}


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


def invitation_reduction_bytes(original):
    assert hashlib.sha256(original).hexdigest() == INVITATION_SOURCE_SHA256
    payload = Path(__file__).with_name("invitation-disposal-reduction.ts").read_bytes()
    assert hashlib.sha256(payload).hexdigest() == INVITATION_REDUCTION_SHA256
    return payload


def invitation_observations(log, exit_code, expected_cases=INVITATION_CASES):
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
        assert match[4] in expected_cases, "unexpected diagnostic case"
        marker = match[1].strip()
        if marker == "FAIL":
            continue  # Native failure summaries repeat the primary case result.
        assert marker in {"✓", "√", "×", "↓"}, "unsupported diagnostic case status"
        rows.append({"file": match[3], "fullName": match[4],
                     "status": {"✓": "passed", "√": "passed", "×": "failed", "↓": "skipped"}[marker]})
    assert len(rows) == len(expected_cases) and {row["fullName"] for row in rows} == set(expected_cases), "incomplete or duplicate diagnostic cases"
    assert all(row["status"] in {"passed", "failed"} for row in rows), "diagnostic case skipped"
    assert exit_code != 0 or all(row["status"] == "passed" for row in rows), "successful exit contradicts failed case"
    return {"cases": rows, "nativeSummaries": summaries}


def doctor_continuation_observations(log, exit_code, full_context=False):
    rows, summaries = [], []
    prefix = "[shard:bun:agentic-commands-doctor]"
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        if not line.startswith(prefix):
            continue
        body = line[len(prefix):].strip()
        if body.startswith(("Test Files ", "Tests ")):
            summaries.append(body)
        if full_context and DOCTOR_FILE + " > " not in body:
            continue
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


def doctor_phase_observations(log, exit_code):
    result = doctor_continuation_observations(log, exit_code, full_context=True)
    aliases = dict(zip(("cached-true", "cached-false"), DOCTOR_CASES))
    stages = set("fixture-create gateway-acquire maintenance-acquire service-gateway-release service-db-close before-state-mutation baseline-capture maintenance-read maintenance-release finally-maintenance-release finally-gateway-release finally-isolation after-each-db-async after-each-db-sync after-each-directories after-each-mocks after-each-env overflow".split())
    prefix = "[shard:bun:agentic-commands-doctor]"
    frames = []
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        if not line.startswith(prefix):
            continue
        body = line[len(prefix):].strip()
        if "[doctor-phases]" not in body:
            continue
        assert body.startswith("[doctor-phases] ") and len(line.encode()) <= 512, "invalid Doctor phase framing"
        row = json.loads(body.removeprefix("[doctor-phases] "))
        assert list(row) == ["v", "case", "seq", "stage", "event", "cycle"]
        assert type(row["v"]) is int and row["v"] == 1 and row["case"] in aliases
        assert row["stage"] in stages and row["event"] in {"enter", "returned", "overflow"}
        assert type(row["seq"]) is int and 1 <= row["seq"] <= 65
        assert type(row["cycle"]) is int and -1 <= row["cycle"] <= (1 if row["case"] == "cached-true" else 0)
        assert (row["event"] == "overflow") == (row["stage"] == "overflow") == (row["seq"] == 65)
        if row["stage"].startswith("after-each-") or row["stage"] in {"fixture-create", "overflow"}:
            assert row["cycle"] == -1
        frames.append(row)
        assert len(frames) <= 130, "Doctor phase count exceeded"
    coverage, complete = {}, True
    for alias, full_name in aliases.items():
        rows = [row for row in frames if row["case"] == alias]
        valid = (0 < len(rows) <= 64 and rows[0]["stage"] == "fixture-create" and rows[0]["event"] == "enter"
                 and [row["seq"] for row in rows] == list(range(1, len(rows) + 1))
                 and any(row["stage"] == "after-each-db-async" and row["event"] == "enter" for row in rows)
                 and not any(row["event"] == "overflow" for row in rows))
        pending = []
        for row in rows:
            if row["event"] == "enter":
                pending.append(row)
            elif row["event"] == "returned":
                matches = [i for i, entered in enumerate(pending) if (entered["stage"], entered["cycle"]) == (row["stage"], row["cycle"])]
                if matches:
                    pending.pop(matches[-1])
                else:
                    valid = False
        complete &= valid
        coverage[alias] = {"fullName": full_name, "frames": len(rows), "framingComplete": valid,
                           "lastUnmatchedBoundary": pending[-1] if pending else None,
                           "unmatchedEnterCount": len(pending), "last": rows[-1] if rows else None}
    result.update(frames=frames, frameCoverage=coverage, framingComplete=complete,
                  limit="enter without returned is an observed boundary only; no cause, absence or qualification inference; synchronous logging perturbs scheduling")
    return result


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
    events = set("bootstrap-send bootstrap-callback bootstrap-error host-ipc-ready worker-bootstrap guard-bootstrap-received worker-message-handler-installed server-listen server-listening attach-decoded attach-rejected attach-duplicate attach-capacity attach-accepted ready-queued ready-written client-connected client-attach-written client-ready client-timeout evidence-limit framing-loss".split())
    codes = set("none unknown EACCES EADDRINUSE EADDRNOTAVAIL EAGAIN ECANCELED ECONNREFUSED ECONNRESET EINTR EINVAL EISCONN EMFILE ENFILE ENOBUFS ENOENT ENOMEM ENOTSOCK EPERM EPIPE ETIMEDOUT".split())
    counts, brokers, timeouts = {}, {}, set()
    bootstraps, guards, installed = {}, {}, {}
    digest, total = hashlib.sha256(), 0
    incomplete = False
    for raw in log.splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
        match = re.match(r"^(?:\[shard:[^]]+\] )?\[doctor-readiness\] (.*)$", line)
        if not match:
            continue
        assert len(match[0].encode()) <= 1024, "oversized readiness frame"
        row = json.loads(match[1])
        assert list(row) == ["v", "event", "pid", "ppid", "key", "generation", "id", "peer", "attempts", "messageListenerCount", "disconnectListenerCount", "code"]
        assert row["v"] == 1 and row["event"] in events and row["code"] in codes
        assert all(type(row[key]) is int and -1 <= row[key] <= 2**53 - 1 for key in ("pid", "ppid", "key", "generation", "id", "peer", "attempts", "messageListenerCount", "disconnectListenerCount"))
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
        if row["event"] == "bootstrap-send":
            bootstraps.setdefault(identity, set()).add((row["pid"], row["peer"]))
        if row["event"] == "guard-bootstrap-received":
            guards.setdefault((row["pid"], row["ppid"], row["generation"]), []).append((total, row))
        if row["event"] == "worker-message-handler-installed":
            installed.setdefault((row["pid"], row["ppid"]), []).append((total, row))
    # Bind the failed Doctor error to its own timeout frame, not neighboring file output.
    bindings, cause_ids = [], set()
    for case in causes:
        if case.get("kind") != "case":
            continue
        assert case["fullName"] in DOCTOR_CASES
        case_ids = {tuple(map(int, values)) for values in re.findall(
            r"Spawn broker readiness deadline exceeded \[doctor-readiness pid=(\d+) key=(\d+) generation=(\d+) id=(\d+) ", json.dumps(case["errors"]))}
        incomplete |= not case_ids
        cause_ids.update(case_ids)
        for pid, key, generation, attachment in sorted(case_ids):
            hosts = bootstraps.get((key, generation), set())
            binding = {"fullName": case["fullName"], "pid": pid, "key": key, "generation": generation,
                       "id": attachment, "brokerPids": sorted(brokers.get((key, generation), set())),
                       "mappingComplete": False, "earlyDeliveryObserved": False}
            if len(hosts) == 1:
                parent, child = next(iter(hosts))
                receipts = guards.get((child, parent, generation), [])
                handlers = installed.get((child, parent), [])
                binding.update(parentPid=parent, childPid=child, guardReceipts=len(receipts), handlerReceipts=len(handlers))
                if parent > 0 and child > 0 and len(receipts) == len(handlers) == 1:
                    received_at, receipt = receipts[0]
                    installed_at, handler = handlers[0]
                    binding.update(guard=receipt, handlerInstalled=handler,
                        mappingComplete=(receipt["messageListenerCount"] >= 1 and handler["messageListenerCount"] >= 2
                                         and receipt["disconnectListenerCount"] >= 0 and handler["disconnectListenerCount"] >= 0))
                    binding["earlyDeliveryObserved"] = (binding["mappingComplete"]
                        and received_at < installed_at and receipt["messageListenerCount"] == 1)
            bindings.append(binding)
    # Shared case custody or fingerprint collisions cannot identify one failing broker.
    identities = [(row["pid"], row["key"], row["generation"], row["id"]) for row in bindings]
    complete = (total > 0 and not incomplete and bool(cause_ids) and cause_ids <= timeouts
                and all(len(item["brokerPids"]) == 1 for item in bindings)
                and all(len(pids) == 1 for pids in brokers.values())
                and len(identities) == len(set(identities))
                and all(item["mappingComplete"] for item in bindings))
    for binding in bindings:
        binding["earlyDeliveryObserved"] &= complete
    return {"frameCount": total, "framesSHA256": digest.hexdigest(), "eventCounts": counts,
            "causeBindings": bindings, "complete": complete, "rawEvidence": "native-shard.log",
            "earlyDeliveryObserved": complete and any(item["earlyDeliveryObserved"] for item in bindings),
            "correlationLimit": "noncryptographic 53-bit endpoint fingerprint; collisions remain possible; ordering only within one child's stderr; missing/false is not absence or a complete Doctor cause verdict"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--controller-sha", required=True)
    parser.add_argument("--group", choices=GROUPS, required=True)
    parser.add_argument("--pin", choices=("old", "new"), required=True)
    parser.add_argument("--doctor-causes", action="store_true")
    parser.add_argument("--doctor-readiness", action="store_true")
    parser.add_argument("--doctor-phases", action="store_true")
    parser.add_argument("--doctor-fixture-fix", action="store_true")
    parser.add_argument("--doctor-fixture-phases", action="store_true")
    parser.add_argument("--invitation-retention", action="store_true")
    parser.add_argument("--invitation-cache-code", action="store_true")
    parser.add_argument("--invitation-owner-cut", action="store_true")
    parser.add_argument("--invitation-references", action="store_true")
    parser.add_argument("--invitation-operations", action="store_true")
    parser.add_argument("--invitation-reduction", action="store_true")
    parser.add_argument("--invitation-native-callback", action="store_true")
    parser.add_argument("--invitation-snapshot", action="store_true")
    parser.add_argument("--anchor-preparation", action="store_true")
    parser.add_argument("--anchor-full-context", action="store_true")
    parser.add_argument("--anchor-fixture-fix", action="store_true")
    parser.add_argument("--doctor-continuation", action="store_true")
    args = parser.parse_args()
    assert not args.doctor_fixture_phases or ((args.group, args.pin) == ("large5", "new") and not any((
        args.doctor_causes, args.doctor_readiness, args.doctor_phases, args.doctor_fixture_fix, args.doctor_continuation,
        args.invitation_retention, args.invitation_cache_code, args.invitation_native_callback,
        args.invitation_snapshot, args.anchor_preparation, args.anchor_full_context, args.anchor_fixture_fix)))
    assert not args.doctor_fixture_fix or ((args.group, args.pin) == ("large5", "new") and not any((
        args.doctor_causes, args.doctor_readiness, args.doctor_phases, args.doctor_continuation,
        args.invitation_retention, args.invitation_cache_code, args.invitation_native_callback,
        args.invitation_snapshot, args.anchor_preparation, args.anchor_full_context, args.anchor_fixture_fix)))
    assert not args.doctor_phases or ((args.group, args.pin) == ("large5", "new") and not any((
        args.doctor_causes, args.doctor_readiness, args.doctor_continuation, args.invitation_retention,
        args.invitation_cache_code, args.invitation_native_callback, args.invitation_snapshot,
        args.anchor_preparation, args.anchor_full_context, args.anchor_fixture_fix)))
    assert not args.anchor_fixture_fix or ((args.group, args.pin) == ("large42_process", "new")
        and not any((args.anchor_preparation, args.anchor_full_context, args.doctor_causes,
                     args.doctor_readiness, args.doctor_continuation, args.invitation_retention,
                     args.invitation_cache_code, args.invitation_native_callback, args.invitation_snapshot)))
    assert not args.invitation_cache_code or (args.invitation_retention and args.pin == "new")
    assert not args.invitation_reduction or (args.invitation_retention and not any((
        args.invitation_references, args.invitation_operations, args.invitation_owner_cut,
        args.invitation_cache_code, args.invitation_native_callback, args.invitation_snapshot)))
    assert not args.invitation_operations or args.invitation_references
    assert not args.invitation_references or (args.invitation_retention and not args.invitation_owner_cut
                                            and not args.invitation_cache_code and not args.invitation_native_callback
                                            and not args.invitation_snapshot)
    assert not args.invitation_owner_cut or (args.invitation_retention and not args.invitation_cache_code
                                           and not args.invitation_native_callback and not args.invitation_snapshot)
    assert not args.anchor_full_context or args.anchor_preparation
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
    if args.doctor_causes or args.doctor_readiness or args.doctor_phases or args.doctor_fixture_fix or args.doctor_fixture_phases or args.invitation_retention or args.invitation_native_callback or args.invitation_snapshot or args.anchor_preparation or args.doctor_continuation or args.anchor_fixture_fix:
        report.update(diagnosticOnly=True, qualifiesRepin=False)
    candidate_bytes = None
    original_test_bytes = None
    original_operation_bytes = None
    doctor_originals = None
    anchor_originals = None
    fixture_original = None
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
        if args.anchor_fixture_fix:
            assert report["groupSHA256"] == ANCHOR_GROUP_SHA256
            report["anchorFix"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroupSHA256": report["groupSHA256"], "expectedCases": ANCHOR_CASES,
                "scope": "C plus one reviewed fixture fix, original 168-pattern group; native exit and all cases remain authoritative; not unchanged-C qualification"}
        if args.doctor_readiness or args.doctor_phases or args.doctor_fixture_fix or args.doctor_fixture_phases:
            assert report["groupSHA256"] == "3d18b3a8c52cd624cd953353f5949b487c54e3611e5ab3db45f690656a6c7224"
        if args.invitation_retention or args.invitation_native_callback or args.invitation_snapshot:
            assert len(selected["group"]["includePatterns"]) == 309 and INVITATION_FILE in selected["group"]["includePatterns"]
            effective_group = {**selected["group"], "includePatterns": [INVITATION_FILE]}
            group_json = json.dumps([effective_group], separators=(",", ":"))
            report["invitationRetention"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroup": effective_group, "effectiveGroupSHA256": hashlib.sha256(group_json.encode()).hexdigest(),
                "expectedCases": INVITATION_REDUCTION_CASES if args.invitation_reduction else INVITATION_CASES,
                "scope": "standalone file; a pass does not explain or waive the original 309-file failure"}
        if args.invitation_reduction:
            report["reduction"] = {
                "diagnosticOnly": True, "qualifiesRepin": False,
                "scope": "two-case async/disposal reduction through the original Vitest configuration; no database or publication owners",
                "limit": "a pass means the reduction lost a required condition; it does not qualify the original test or identify a retainer",
            }
        if args.anchor_preparation:
            assert len(selected["group"]["includePatterns"]) == 168 and ANCHOR_FILE in selected["group"]["includePatterns"]
            if args.anchor_full_context:
                assert report["groupSHA256"] == ANCHOR_GROUP_SHA256
            effective_group = selected["group"] if args.anchor_full_context else {**selected["group"], "includePatterns": [ANCHOR_FILE]}
            group_json = json.dumps([effective_group], separators=(",", ":"))
            report["anchorPreparation"] = {"originalGroupSHA256": report["groupSHA256"],
                "effectiveGroup": effective_group, "effectiveGroupSHA256": hashlib.sha256(group_json.encode()).hexdigest(),
                "expectedCases": ANCHOR_CASES,
                "scope": ("instrumented original 168-pattern group; native exit and broad summaries remain authoritative; a pass leaves the original failure unexplained"
                          if args.anchor_full_context else "instrumented ten-case standalone file; not unchanged-C or whole-group qualification")}
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
        if args.doctor_causes or args.doctor_readiness or args.doctor_phases:
            observer = Path(__file__).with_name("doctor-cause-reporter.mjs").resolve()
            assert observer.is_file() and not observer.is_relative_to(source)
            effective_args = ["--reporter=verbose", "--reporter=github-actions", "--reporter=" + str(observer)]
            report["observer"] = {"diagnosticOnly": True, "qualifiesRepin": False,
                                  "originalVitestArgs": [], "effectiveVitestArgs": effective_args,
                                  "sha256": common["sha"](observer)}
            env["OPENCLAW_NODE_TEST_VITEST_ARGS_JSON"] = json.dumps(effective_args)
        report.update(command=selected["nativeArgv"], childEnvironment=env)
        if args.anchor_fixture_fix:
            patch = Path(__file__).with_name("anchor-preparation-fixture-fix.patch").resolve()
            fixture_path, anchor_test = source / ANCHOR_FIX_FILE, source / ANCHOR_FILE
            assert common["sha"](patch) == ANCHOR_FIX_PATCH_SHA256
            assert fixture_path.is_file() and not fixture_path.is_symlink()
            assert common["sha"](fixture_path) == ANCHOR_FILES[ANCHOR_FIX_FILE][0]
            assert anchor_test.is_file() and not anchor_test.is_symlink()
            assert common["sha"](anchor_test) == ANCHOR_FILES[ANCHOR_FILE][0]
            assert not git("diff", "HEAD", "--name-only")
            git("apply", "--check", str(patch))
            fixture_original = fixture_path.read_bytes()
            report["fixtureProjection"] = {"state": "prepared", "sourceCommit": ANCHOR_FIX_COMMIT,
                "path": ANCHOR_FIX_FILE, "patchSHA256": ANCHOR_FIX_PATCH_SHA256,
                "originalSHA256": ANCHOR_FILES[ANCHOR_FIX_FILE][0], "patchedSHA256": ANCHOR_FIX_SHA256,
                "unchangedTestSHA256": ANCHOR_FILES[ANCHOR_FILE][0]}
            save()
            git("apply", "--whitespace=nowarn", str(patch))
            report["fixtureProjection"]["state"] = "applied"
            assert common["sha"](fixture_path) == ANCHOR_FIX_SHA256
            assert git("diff", "HEAD", "--name-only") == ANCHOR_FIX_FILE
        if args.doctor_readiness or args.doctor_phases or args.doctor_fixture_fix or args.doctor_fixture_phases:
            if args.doctor_fixture_phases:
                doctor_files = DOCTOR_FIXTURE_PHASE_FILES
                projection_key = "doctorFixturePhaseProjection"
                patch_sha = DOCTOR_PHASE_PATCH_SHA256
                patch = Path(__file__).with_name("doctor-phases.patch").resolve()
            elif args.doctor_fixture_fix:
                doctor_files = DOCTOR_FIX_FILES
                projection_key = "doctorFixtureProjection"
                patch_sha = DOCTOR_FIX_PATCH_SHA256
                patch = Path(__file__).with_name("doctor-fixture-fix.patch").resolve()
            else:
                doctor_files = DOCTOR_PHASE_FILES if args.doctor_phases else READINESS_FILES
                projection_key = "doctorPhaseProjection" if args.doctor_phases else "readinessProjection"
                patch_sha = DOCTOR_PHASE_PATCH_SHA256 if args.doctor_phases else READINESS_PATCH_SHA256
                patch = Path(__file__).with_name("doctor-phases.patch" if args.doctor_phases else "doctor-readiness.patch").resolve()
            patches = [(patch, patch_sha, DOCTOR_PHASE_FILES if args.doctor_fixture_phases else doctor_files)]
            if args.doctor_fixture_phases:
                patches.append((Path(__file__).with_name("doctor-fixture-fix.patch").resolve(), DOCTOR_FIX_PATCH_SHA256, doctor_files))
            assert all(common["sha"](path) == expected for path, expected, _ in patches)
            paths = {name: source / name for name in doctor_files}
            assert all(path.is_file() and not path.is_symlink() and common["sha"](path) == doctor_files[name][0]
                       for name, path in paths.items()), "Doctor diagnostic source differs from exact candidate"
            assert not git("diff", "HEAD", "--name-only")
            git("apply", "--check", str(patch))
            doctor_originals = {name: path.read_bytes() for name, path in paths.items()}
            report[projection_key] = {"state": "prepared", "patchSHA256": patch_sha,
                "files": {name: {"originalSHA256": hashes[0], "patchedSHA256": hashes[1]}
                          for name, hashes in doctor_files.items()},
                "egress": ("native verbose output only; whole native log32MiB" if args.doctor_fixture_fix else
                           "64 combined test/fixture frames per case plus one overflow; fixed schema below512B; whole native log32MiB"
                           if args.doctor_phases or args.doctor_fixture_phases else "4 guard receipts plus one overflow per guard; 2048 fixed frames plus one limit marker per loaded diagnostic module instance; each frame below512B; whole native log32MiB"),
                "scope": ("C plus existing phase writes and readonly fixture guard in original116-pattern group; no observation reporter; boundaries only, not cause or unchanged-C qualification" if args.doctor_fixture_phases else
                          "C plus one fixture IPC-observer ownership guard in original116-pattern group; no observation reporter or markers; not unchanged-C qualification" if args.doctor_fixture_fix else
                          "two test/fixture projections in original116-pattern group; stderr writes can perturb scheduling; observed operation boundaries only, no cause or qualification verdict"
                          if args.doctor_phases else "instrumented readiness diagnosis only; stderr writes and hashing can perturb scheduling; no added Promise continuation, wait, retry or timeout")}
            if args.doctor_fixture_phases:
                report[projection_key]["patches"] = [{"name": path.name, "sha256": expected, "state": "prepared",
                    "projectedSHA256": {name: hashes[1] for name, hashes in files.items()}}
                    for path, expected, files in patches]
            save()
            for index, (path, _, files) in enumerate(patches):
                if index:
                    git("apply", "--check", str(path))
                git("apply", "--whitespace=nowarn", str(path))
                report[projection_key]["state"] = "applied"
                assert all(common["sha"](paths[name]) == hashes[1] for name, hashes in files.items())
                assert set(git("diff", "HEAD", "--name-only").splitlines()) == set(files)
                if args.doctor_fixture_phases:
                    report[projection_key]["patches"][index]["state"] = "applied"
                    save()
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
        if args.invitation_native_callback or args.invitation_snapshot or args.invitation_owner_cut or args.invitation_references or args.invitation_reduction:
            test_path = source / INVITATION_FILE
            assert test_path.is_file() and not test_path.is_symlink()
            original = test_path.read_bytes()
            patched = (invitation_reduction_bytes(original) if args.invitation_reduction else
                       invitation_references_bytes(original, args.invitation_operations) if args.invitation_references else
                       invitation_owner_cut_bytes(original) if args.invitation_owner_cut else
                       invitation_snapshot_bytes(original) if args.invitation_snapshot else invitation_callback_bytes(original))
            patched_test_sha = (INVITATION_REDUCTION_SHA256 if args.invitation_reduction else
                                INVITATION_OPERATIONS_SHA256 if args.invitation_operations else
                                INVITATION_REFERENCES_SHA256 if args.invitation_references else
                                INVITATION_OWNER_CUT_SHA256 if args.invitation_owner_cut else
                                INVITATION_SNAPSHOT_SHA256 if args.invitation_snapshot else INVITATION_CALLBACK_SHA256)
            report["testProjection"] = {"path": INVITATION_FILE, "state": "prepared",
                "originalSHA256": INVITATION_SOURCE_SHA256, "patchedSHA256": patched_test_sha,
                "diff": "".join(difflib.unified_diff(original.decode().splitlines(True),
                    patched.decode().splitlines(True), fromfile="a/" + INVITATION_FILE, tofile="b/" + INVITATION_FILE)),
                "scope": "one immediate and one GC per retention case; Promise/closure roots and GC/resumption ordering differ; no qualification or leak-cause verdict"}
            if args.invitation_reduction:
                report["testProjection"]["scope"] = "replaced by two-case async/disposal reduction; same Vitest transform and one original nextTurn/queryObjects boundary; diagnostic only"
            if args.invitation_owner_cut:
                report["testProjection"]["scope"] = "remove test-held closed admissions after their assertions; retain original timer, GC and sentinel assertions; diagnostic only"
            if args.invitation_references:
                report["testProjection"]["scope"] = "WeakRefs to original functions and Promise; same identities, timer, GC and assertions; allocation/layout perturbation; diagnostic only"
            if args.invitation_operations:
                report["testProjection"]["scope"] += "; direct operation WeakRefs, no call wrapper or additional Promise reactions"
            if args.invitation_snapshot:
                report["testProjection"].update(payloadSHA256=INVITATION_SNAPSHOT_PAYLOAD_SHA256,
                    scope="commit-only address capture and one synchronous debug snapshot after original timer/queryObjects; extra full GC and allocation/root/layout perturbation; reported structure only, no strong-retainer, scanner, leak-cause or qualification verdict")
            if args.invitation_operations:
                operation_path = source / INVITATION_OPERATION_FILE
                assert operation_path.is_file() and not operation_path.is_symlink()
                operation_original = operation_path.read_bytes()
                operation_patched = invitation_operation_bytes(operation_original)
            original_test_bytes = original
            test_path.write_bytes(patched)
            report["testProjection"]["state"] = "applied"
            assert common["sha"](test_path) == patched_test_sha
            projected_files = {INVITATION_FILE}
            if args.invitation_operations:
                report["operationProjection"] = {"path": INVITATION_OPERATION_FILE, "state": "prepared",
                    "originalSHA256": INVITATION_OPERATION_SOURCE_SHA256, "patchedSHA256": INVITATION_OPERATION_PATCHED_SHA256,
                    "scope": "temporary direct WeakRefs only; no additional calls, Promise reactions, waits or changes to production decisions"}
                original_operation_bytes = operation_original
                operation_path.write_bytes(operation_patched)
                report["operationProjection"]["state"] = "applied"
                assert common["sha"](operation_path) == INVITATION_OPERATION_PATCHED_SHA256
                projected_files.add(INVITATION_OPERATION_FILE)
            if args.pin == "old":
                projected_files.add(common["PIN"])
            assert set(git("diff", "HEAD", "--name-only").splitlines()) == projected_files, "unexpected tracked source projection"
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
        if args.anchor_fixture_fix:
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            observations = anchor_observations(log, outcome["exitCode"], full_context=True)
            report["anchorFix"].update({key: observations[key] for key in ("cases", "nativeSummaries")})
            report["status"] = "DIAGNOSTIC"
        elif args.doctor_fixture_fix:
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            report["doctorFixtureFix"] = doctor_continuation_observations(log, outcome["exitCode"], full_context=True)
            report["status"] = "DIAGNOSTIC"
        elif args.doctor_phases or args.doctor_fixture_phases:
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            if args.doctor_phases:
                report["observer"]["records"] = doctor_observations(log)
            report["doctorPhases"] = doctor_phase_observations(log, outcome["exitCode"])
            assert report["doctorPhases"]["framingComplete"], "Doctor phase evidence missing, capped or unattributed"
            report["status"] = "DIAGNOSTIC"
        elif args.doctor_continuation:
            report["doctorContinuation"].update(doctor_continuation_observations(log, outcome["exitCode"]))
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            report["status"] = "DIAGNOSTIC"
        elif args.anchor_preparation:
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            report["anchorPreparation"].update(anchor_observations(log, outcome["exitCode"], args.anchor_full_context))
            assert report["anchorPreparation"]["framingComplete"], "anchor observation missing, capped, invalid or interrupted"
            report["status"] = "DIAGNOSTIC"
        elif args.invitation_retention or args.invitation_native_callback or args.invitation_snapshot:
            report["invitationRetention"].update(invitation_observations(log, outcome["exitCode"],
                INVITATION_REDUCTION_CASES if args.invitation_reduction else INVITATION_CASES))
            report["diagnosticNativeStatus"] = "PASS" if outcome["exitCode"] == 0 else "FAIL"
            if args.invitation_owner_cut:
                report["ownerCut"] = invitation_owner_cut_observations(log)
            if args.invitation_references:
                report["references"] = invitation_references_observations(log)
            if args.invitation_operations:
                report["operations"] = invitation_operations_observations(log)
            if args.invitation_snapshot:
                report["snapshot"] = snapshot_observations(log)
                assert report["snapshot"]["complete"] is True, "snapshot identity or reported structure incomplete; no absence inference"
            if args.invitation_cache_code:
                collector = Path(__file__).with_name("invitation-cache-code.py")
                report["transformedCode"] = runpy.run_path(str(collector))["capture"](source, root / "cache/vitest")
                report["transformedCode"]["collectorSHA256"] = common["sha"](collector)
                assert report["transformedCode"]["complete"], "post-native cache evidence incomplete; native outcome remains unchanged"
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
            if original_operation_bytes is not None:
                report["operationProjection"]["state"] = "retained-indeterminate-settlement"
            if doctor_originals is not None:
                report[projection_key]["state"] = "retained-indeterminate-settlement"
            if anchor_originals is not None:
                report["anchorProjection"]["state"] = "retained-indeterminate-settlement"
            if fixture_original is not None:
                report["fixtureProjection"]["state"] = "retained-indeterminate-settlement"
        elif candidate_bytes is not None:
            restore_allowed = original_test_bytes is None or (test_path.is_file() and not test_path.is_symlink()
                              and common["sha"](test_path) == patched_test_sha)
            if args.invitation_reduction and original_test_bytes is not None:
                expected_files = {INVITATION_FILE} | ({common["PIN"]} if args.pin == "old" else set())
                restore_allowed &= set(git("diff", "HEAD", "--name-only").splitlines()) == expected_files
            if original_operation_bytes is not None:
                restore_allowed &= (operation_path.is_file() and not operation_path.is_symlink()
                                    and common["sha"](operation_path) == INVITATION_OPERATION_PATCHED_SHA256)
                restore_allowed &= set(git("diff", "HEAD", "--name-only").splitlines()) == projected_files
            if fixture_original is not None:
                restore_allowed = (fixture_path.is_file() and not fixture_path.is_symlink()
                    and common["sha"](fixture_path) == ANCHOR_FIX_SHA256
                    and anchor_test.is_file() and not anchor_test.is_symlink()
                    and common["sha"](anchor_test) == ANCHOR_FILES[ANCHOR_FILE][0]
                    and git("diff", "HEAD", "--name-only") == ANCHOR_FIX_FILE)
                if restore_allowed:
                    fixture_path.write_bytes(fixture_original)
                    report["fixtureProjection"].update(state="restored", restoredSHA256=common["sha"](fixture_path))
                    assert report["fixtureProjection"]["restoredSHA256"] == ANCHOR_FILES[ANCHOR_FIX_FILE][0]
                else:
                    report["fixtureProjection"]["state"] = "retained-unexpected-source-bytes"
            if doctor_originals is not None:
                restore_allowed = all(path.is_file() and not path.is_symlink() and common["sha"](path) == doctor_files[name][1]
                                      for name, path in paths.items())
                restore_allowed &= set(git("diff", "HEAD", "--name-only").splitlines()) == set(report[projection_key]["files"])
                if restore_allowed:
                    for name, original in doctor_originals.items():
                        paths[name].write_bytes(original)
                    report[projection_key]["state"] = "restored"
                else:
                    report[projection_key]["state"] = "retained-unexpected-source-bytes"
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
                if original_operation_bytes is not None:
                    operation_path.write_bytes(original_operation_bytes)
                    report["operationProjection"].update(state="restored", restoredSHA256=common["sha"](operation_path))
                    assert report["operationProjection"]["restoredSHA256"] == INVITATION_OPERATION_SOURCE_SHA256
                if original_test_bytes is not None:
                    (source / INVITATION_FILE).write_bytes(original_test_bytes)
                    report["testProjection"].update(state="restored", restoredSHA256=common["sha"](source / INVITATION_FILE))
                    assert report["testProjection"]["restoredSHA256"] == INVITATION_SOURCE_SHA256
                (source / common["PIN"]).write_bytes(candidate_bytes)
                report["candidatePinRestored"] = (source / common["PIN"]).read_bytes() == candidate_bytes
            else:
                if original_operation_bytes is not None:
                    report["operationProjection"]["state"] = "retained-unexpected-source-bytes"
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
