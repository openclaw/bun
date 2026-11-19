import hashlib
import json
from pathlib import Path
import runpy
import unittest


root = Path(__file__).parent
controller = runpy.run_path(str(root / "openclaw-linux-repin.py"))
observe = controller["resident_receipt_observations"]
prefix = "[shard:bun:core-runtime-infra-storage-state-hosted-25] "


def case(before, failed=False):
    name = controller["RESIDENT_CASES"][0 if before else 1]
    return prefix + ("×" if failed else "✓") + " infra " + controller["RESIDENT_FILE"] + " > " + name + " 1927ms"


def frame(before, **changes):
    row = {"v": 1, "case": "before" if before else "after", "truncated": False,
           "steps": [{"kind": "predecessor-stop", "completed": True, "inProgress": False,
                      "expectedSuccessor": True, "detailPresent": False}]}
    row.update(changes)
    return prefix + "[resident-receipt] " + json.dumps(row)


class ResidentReceiptEvidenceTests(unittest.TestCase):
    def test_bar_delimited_projects_and_source_excerpt_are_not_receipt_frames(self):
        log = "\n".join((
            case(True, True).replace(" infra ", " |infra| "),
            case(False).replace(" infra ", " |infra| "),
            frame(True),
            prefix + '     213| process.stderr.write("[resident-receipt] " + JSON.stringify({',
        ))
        self.assertTrue(observe(log, 1)["reproduced"])

    def test_failed_outcome_preserves_classification_without_inferring_write_failure(self):
        report = observe("\n".join((case(True, True), case(False), frame(True))), 1)
        self.assertTrue(report["reproduced"])
        self.assertTrue(report["returnedStepFrames"][0]["steps"][0]["expectedSuccessor"])

    def test_passing_targets_can_coexist_with_an_unrelated_native_failure(self):
        report = observe(case(True) + "\n" + case(False), 1)
        self.assertTrue(report["otherGroupFailure"])
        self.assertEqual(report["returnedStepFrames"], [])

    def test_missing_duplicate_capped_and_private_evidence_is_rejected(self):
        failed = case(True, True) + "\n" + case(False)
        valid = failed + "\n" + frame(True)
        for log, code in ((failed, 1), (valid, 0), (valid + "\n" + frame(True), 1),
                          (failed + "\n" + frame(True, truncated=True), 1),
                          (failed + "\n" + frame(True, rawKey="private"), 1),
                          (failed + "\n" + frame(True, steps=[{"rawKey": "private"}]), 1),
                          (case(True) + "\n" + case(False) + "\n" + frame(True), 0)):
            with self.subTest(log=log), self.assertRaises(AssertionError):
                observe(log, code)

    def test_manifest_and_patch_bind_the_original_group_and_current_source(self):
        path = root / "resident-receipt-ci-group.json"
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), controller["RESIDENT_MANIFEST_SHA256"])
        manifest = json.loads(path.read_text())
        self.assertEqual(len(manifest["group"]["includePatterns"]), 64)
        group = json.dumps([manifest["group"]], separators=(",", ":")).encode()
        self.assertEqual(hashlib.sha256(group).hexdigest(), manifest["groupSha256"])
        self.assertEqual(manifest["env"]["OPENCLAW_CI_TEST_RUNTIME"], "bun")
        self.assertEqual(hashlib.sha256((root / "resident-receipt.patch").read_bytes()).hexdigest(),
                         controller["RESIDENT_PATCH_SHA256"])


if __name__ == "__main__":
    unittest.main()
