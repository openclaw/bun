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


if __name__ == "__main__":
    unittest.main()
