import json
from pathlib import Path
import runpy
import unittest


controller = runpy.run_path(str(Path(__file__).with_name("openclaw-linux-repin.py")))
observe = controller["invitation_owner_cut_observations"]
observe_references = controller["invitation_references_observations"]
observe_operations = controller["invitation_operations_observations"]


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


class ReferenceEvidenceTests(unittest.TestCase):
    @staticmethod
    def marker(outcome, **changes):
        row = {"version": 1, "outcome": outcome, "preparationAlive": False, "guardAlive": outcome == "commit",
               "writeAlive": False, "sentinelAlive": outcome == "commit", "controlAlive": False}
        row.update(changes)
        return "[shard:bun:core-runtime-config-hosted-3] [invitation-references] " + json.dumps(row)

    def test_liveness_is_recorded_without_claiming_a_retainer_or_qualification(self):
        report = observe_references(self.marker("commit") + "\n" + self.marker("rollback"))
        self.assertTrue(report["cases"][0]["guardAlive"])
        self.assertFalse(report["cases"][1]["guardAlive"])
        self.assertTrue(report["diagnosticOnly"])
        self.assertFalse(report["qualifiesRepin"])

    def test_missing_duplicate_invalid_and_unexpected_fields_are_rejected(self):
        for lines in (
            self.marker("commit"),
            self.marker("commit") + "\n" + self.marker("commit"),
            self.marker("commit", guardAlive=None) + "\n" + self.marker("rollback"),
            self.marker("commit", writeAlive="false") + "\n" + self.marker("rollback"),
            self.marker("commit", privatePath="not-exportable") + "\n" + self.marker("rollback"),
        ):
            with self.subTest(lines=lines), self.assertRaises(AssertionError):
                observe_references(lines)


class OperationEvidenceTests(unittest.TestCase):
    @staticmethod
    def marker(outcome, operations):
        return "[invitation-operations] " + json.dumps({"version": 1, "outcome": outcome, "operations": operations})

    def test_operation_identity_liveness_is_diagnostic_only(self):
        operation = dict.fromkeys(("paramsAlive", "runAlive", "acknowledgedAlive", "committedAlive"), False)
        report = observe_operations(self.marker("commit", [operation]) + "\n" + self.marker("rollback", [operation]))
        self.assertEqual(report["cases"][0]["operations"], [operation])
        self.assertTrue(report["diagnosticOnly"])
        self.assertFalse(report["qualifiesRepin"])

    def test_missing_or_invalid_operation_witnesses_are_rejected(self):
        operation = dict.fromkeys(("paramsAlive", "runAlive", "acknowledgedAlive", "committedAlive"), False)
        rollback = self.marker("rollback", [operation])
        for operations in ([], [operation] * 9, [{**operation, "paramsAlive": None}], [{**operation, "privatePath": "invalid"}]):
            with self.subTest(operations=operations), self.assertRaises(AssertionError):
                observe_operations(self.marker("commit", operations) + "\n" + rollback)


if __name__ == "__main__":
    unittest.main()
