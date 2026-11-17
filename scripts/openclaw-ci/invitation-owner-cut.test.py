import json
from pathlib import Path
import runpy
import unittest


controller = runpy.run_path(str(Path(__file__).with_name("openclaw-linux-repin.py")))
observe = controller["invitation_owner_cut_observations"]


def marker(outcome, **changes):
    row = {"version": 1, "outcome": outcome, "ownerCount": 3, "survivingOwners": 0,
           "sentinelAlive": outcome == "commit", "controlAlive": False}
    row.update(changes)
    return "[shard:bun:core-runtime-config-hosted-3] [invitation-owner-cut] " + json.dumps(row)


class OwnerCutEvidenceTests(unittest.TestCase):
    def test_surviving_owners_are_recorded_without_claiming_qualification(self):
        report = observe(marker("commit", survivingOwners=1) + "\n" + marker("rollback"))
        self.assertEqual(report["cases"][0]["survivingOwners"], 1)
        self.assertTrue(report["cases"][0]["sentinelAlive"])
        self.assertTrue(report["diagnosticOnly"])
        self.assertFalse(report["qualifiesRepin"])

    def test_incomplete_duplicate_and_invalid_observations_are_rejected(self):
        for lines in (
            marker("commit"),
            marker("commit") + "\n" + marker("commit"),
            marker("commit", survivingOwners=4) + "\n" + marker("rollback"),
            marker("commit", sentinelAlive="false") + "\n" + marker("rollback"),
            marker("commit", privatePath="not-exportable") + "\n" + marker("rollback"),
        ):
            with self.subTest(lines=lines), self.assertRaises(AssertionError):
                observe(lines)


if __name__ == "__main__":
    unittest.main()
