import hashlib
import json
from pathlib import Path
import runpy
import unittest


root = Path(__file__).parent
controller = runpy.run_path(str(root / "openclaw-linux-repin.py"))
observe = controller["doctor_failure_observations"]
prefix = "[shard:bun:agentic-commands-doctor-hosted-2] "


def case(writer, failed=False):
    name = controller["DOCTOR_CASES"][0 if writer else 1]
    return prefix + ("×" if failed else "✓") + "  commands  " + controller["DOCTOR_FILE"] + " > " + name + " 120020ms"


def frame(writer, **changes):
    row = {"v": 1, "case": "cached-true" if writer else "cached-false",
           "phase": "gateway-release", "cycle": 0, "cleanup": "not-started",
           "teardown": "close-async", "restore": "not-started"}
    row.update(changes)
    return prefix + "[doctor-failure-phase] " + json.dumps(row)


class DoctorFailureEvidenceTests(unittest.TestCase):
    def test_snapshot_routes_preserve_inner_work_and_cleanup_boundaries(self):
        for route in ("not-started", "reusable-lease", "active-reuse", "awaited-worker"):
            for phase in ("not-started", "reuse-check", "flight-wait", "producer-entered",
                          "staging-create", "allocation-returned", "copy-wait",
                          "copy-returned", "publishing", "producer-complete"):
                snapshot = {"route": route, "phase": phase, "cleanup": "directory-retire"}
                check = {"cycle": 0, "schemaMaintenance": True, "phase": "snapshot-prepare",
                         "cleanup": "not-started", "snapshot": snapshot}
                log = "\n".join((case(True, True), case(False),
                    frame(True, v=3, leaseChecks=[check], leaseOverflow=False)))
                self.assertEqual(observe(log, 1)["failureFrames"][0]["leaseChecks"][0]
                                 ["snapshot"], snapshot)

    def test_snapshot_records_reject_unknown_or_private_fields(self):
        valid = {"route": "awaited-worker", "phase": "copy-wait", "cleanup": "not-started"}
        check = {"cycle": 0, "schemaMaintenance": True, "phase": "snapshot-prepare",
                 "cleanup": "not-started", "snapshot": valid}
        invalid = [None, {}, {**valid, "route": "unknown"}, {**valid, "phase": "unknown"},
                   {**valid, "cleanup": "unknown"}, {**valid, "path": "private"}]
        for snapshot in invalid:
            with self.subTest(snapshot=snapshot), self.assertRaises(AssertionError):
                observe("\n".join((case(True, True), case(False), frame(True, v=3,
                    leaseChecks=[{**check, "snapshot": snapshot}], leaseOverflow=False))), 1)

    def test_repair_admission_frames_identify_legacy_and_schema_waits(self):
        for phase in ("legacy-owner-check", "lease-schema-preflight"):
            with self.subTest(phase=phase):
                log = "\n".join((case(True, True), case(False),
                    frame(True, v=2, phase=phase, leaseChecks=[], leaseOverflow=False)))
                self.assertEqual(observe(log, 1)["failureFrames"][0]["phase"], phase)

    def test_direct_lease_records_keep_completed_and_pending_cycles(self):
        checks = [
            {"cycle": 0, "schemaMaintenance": True, "phase": "complete", "cleanup": "complete"},
            {"cycle": 1, "schemaMaintenance": True, "phase": "query-complete", "cleanup": "transport-close"},
        ]
        log = "\n".join((case(True, True), case(False),
                         frame(True, v=2, phase="maintenance-acquire", cycle=1,
                               leaseChecks=checks, leaseOverflow=False)))
        self.assertEqual(observe(log, 1)["failureFrames"][0]["leaseChecks"], checks)

    def test_direct_lease_frames_reject_overflow_and_unbounded_or_unknown_fields(self):
        check = {"cycle": 1, "schemaMaintenance": True, "phase": "snapshot-prepare", "cleanup": "not-started"}
        base = {"v": 2, "leaseChecks": [check], "leaseOverflow": False}
        invalid = [
            {**base, "leaseOverflow": True},
            {**base, "leaseChecks": [check] * 9},
            {**base, "leaseChecks": [{**check, "cycle": True}]},
            {**base, "leaseChecks": [{**check, "schemaMaintenance": 1}]},
            {**base, "leaseChecks": [{**check, "phase": "unknown"}]},
            {**base, "leaseChecks": [{**check, "cleanup": "unknown"}]},
            {**base, "leaseChecks": [{**check, "privatePath": "private"}]},
        ]
        for row in invalid:
            with self.subTest(row=row), self.assertRaises(AssertionError):
                observe("\n".join((case(True, True), case(False), frame(True, **row))), 1)
        # No entry is meaningful when failure precedes the direct lease reader.
        empty = frame(True, v=2, leaseChecks=[], leaseOverflow=False)
        self.assertEqual(observe("\n".join((case(True, True), case(False), empty)), 1)
                         ["failureFrames"][0]["leaseChecks"], [])

    def test_bar_delimited_projects_and_source_excerpts_from_failed_native_run(self):
        log = "\n".join((
            case(True, True).replace("  commands  ", " |commands| "),
            case(False, True).replace("  commands  ", " |commands| "),
            frame(True, phase="maintenance-acquire", cycle=1),
            frame(False, phase="fixture", cycle=-1),
            prefix + '     57| process.stderr.write("[doctor-failure-phase] " + JSON.stringify({',
        ))
        report = observe(log, 1)
        self.assertEqual([row["status"] for row in report["cases"]], ["failed", "failed"])
        self.assertEqual([row["phase"] for row in report["failureFrames"]],
                         ["maintenance-acquire", "fixture"])

    def test_current_native_output_keeps_failed_boundary_and_ignores_node_and_tail(self):
        log = "\n".join((case(True, True), case(False), frame(True),
                         case(True).replace("shard:bun:", "shard:"),
                         case(True, True).replace("shard:bun:", "shard-failure:bun:")))
        report = observe(log, 1)
        self.assertTrue(report["reproduced"])
        self.assertEqual(report["failureFrames"][0]["phase"], "gateway-release")
        self.assertEqual(report["failureFrames"][0]["teardown"], "close-async")

    def test_passing_cases_do_not_hide_another_group_failure(self):
        log = case(True) + "\n" + case(False)
        self.assertFalse(observe(log, 0)["reproduced"])
        self.assertTrue(observe(log, 1)["otherGroupFailure"])

    def test_missing_duplicate_contradictory_and_unbounded_evidence_is_rejected(self):
        failed = case(True, True) + "\n" + case(False)
        valid = failed + "\n" + frame(True)
        for log, code in ((failed, 1), (valid + "\n" + frame(True), 1),
                          (valid + "\n" + case(True, True), 1), (valid, 0),
                          (case(True) + "\n" + case(False) + "\n" + frame(True), 0),
                          (case(False), 0),
                          (failed + "\n" + frame(True, cycle=True), 1),
                          (failed + "\n" + frame(True, phase="unknown"), 1),
                          (failed + "\n" + frame(True, privatePath="private"), 1),
                          (failed + "\n" + frame(True, restore="x" * 600), 1)):
            with self.subTest(log=log), self.assertRaises(AssertionError):
                observe(log, code)

    def test_manifest_and_projection_are_bound_to_the_frozen_native_group(self):
        manifest = root / "doctor-failure-ci-group.json"
        self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(),
                         controller["DOCTOR_FAILURE_MANIFEST_SHA256"])
        selected = json.loads(manifest.read_text())
        group_bytes = json.dumps([selected["group"]], separators=(",", ":")).encode()
        self.assertEqual(hashlib.sha256(group_bytes).hexdigest(), selected["groupSha256"])
        self.assertEqual(len(selected["group"]["includePatterns"]), 56)
        self.assertEqual(selected["candidate"], controller["DOCTOR_FAILURE_CANDIDATE"])
        self.assertEqual(selected["env"]["OPENCLAW_CI_TEST_RUNTIME"], "bun")
        patch = root / "doctor-failure-phases.patch"
        self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(),
                         controller["DOCTOR_FAILURE_PATCH_SHA256"])


class DoctorWarmEvidenceTests(unittest.TestCase):
    def observe(self, lines, code):
        return controller["doctor_warm_observations"]("\n".join(lines), code)

    def case(self, failed=False):
        return prefix + ("×" if failed else "✓") + " |commands| src/commands/doctor-maintenance.admission-warm.test.ts > observes readonly worker requests without adding IPC listeners to other children 120012ms"

    def frame(self, **changes):
        row = {"v": 1, "phase": "message-wait", "readerCleanup": "complete",
               "childCleanup": "close-wait", "closeObserved": False,
               "teardown": "complete", "restore": "complete"}
        row.update(changes)
        return prefix + "[doctor-warm-phase] " + json.dumps(row)

    def test_failure_keeps_primary_wait_separate_from_cleanup(self):
        result = self.observe([self.case(True), self.frame()], 1)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failureFrame"]["phase"], "message-wait")
        self.assertEqual(result["failureFrame"]["childCleanup"], "close-wait")

    def test_success_does_not_hide_another_group_failure(self):
        self.assertEqual(self.observe([self.case()], 0)["status"], "passed")
        self.assertIsNone(self.observe([self.case()], 1)["failureFrame"])

    def test_all_observed_boundaries_are_supported(self):
        for phase in ("fixture", "database-close", "snapshot-request", "sqlite-open",
                      "sqlite-query", "scope-callback-complete", "child-spawn",
                      "message-wait", "close-wait", "witness-assertions", "complete"):
            self.assertEqual(self.observe([self.case(True), self.frame(phase=phase)], 1)
                             ["failureFrame"]["phase"], phase)

    def test_missing_duplicate_inconsistent_or_unbounded_evidence_is_rejected(self):
        invalid = [([], 0), ([self.case(True)], 1),
                   ([self.case(), self.frame()], 0),
                   ([self.case(True), self.frame()], 0),
                   ([self.case(True), self.frame(), self.frame()], 1),
                   ([self.case(), self.case()], 0)]
        for changes in ({"v": True}, {"phase": "unknown"}, {"closeObserved": 1},
                        {"readerCleanup": "unknown"}, {"childCleanup": "unknown"},
                        {"teardown": "unknown"}, {"restore": "unknown"},
                        {"privatePath": "private"}, {"phase": "x" * 600}):
            invalid.append(([self.case(True), self.frame(**changes)], 1))
        for lines, code in invalid:
            with self.subTest(lines=lines), self.assertRaises(AssertionError):
                self.observe(lines, code)


if __name__ == "__main__":
    unittest.main()
