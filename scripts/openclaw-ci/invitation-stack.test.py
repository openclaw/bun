import copy
import json
from pathlib import Path
import runpy
import struct
import unittest


stack = runpy.run_path(str(Path(__file__).with_name("invitation_stack.py")))
controller = runpy.run_path(str(Path(__file__).with_name("openclaw-linux-repin.py")))


def snapshot():
    return {"version": 3, "type": "GCDebugging", "nodeClassNames": ["<root>", "Object", "Function", "String"],
            "nodes": [0, 0, 0, 0, 0, "0x0", "0x0",
                      1, 8, 1, 0, 0, "0x1000", "0x0",
                      2, 8, 2, 0, 0, "0x2000", "0x0",
                      3, 8, 3, 0, 0, "0x3000", "0x0"],
            "edges": [2, 1, 0, 1, 1, 3, 0, 0], "edgeTypes": ["Property"],
            "edgeNames": ["sentinel", "captured"], "roots": []}


class StackEvidenceTests(unittest.TestCase):
    def test_reverse_graph_maps_stack_words_to_cells_without_exporting_addresses(self):
        cells, records = stack["snapshot_plan"](snapshot(), 0x1000)
        matches = stack["stack_matches"](struct.pack("<QQQQ", 0, 0x2000, 0x1000, 0x2000), 128,
                                          cells, [(0, 128, 144), (1, 144, 160)])
        self.assertEqual(matches, [
            {"cell": "n1", "occurrences": 2, "firstStackOffset": 8, "matchingFrames": [0]},
            {"cell": "n0", "occurrences": 1, "firstStackOffset": 16, "matchingFrames": [1]}])
        self.assertEqual(records[0]["incomingCells"], ["n1"])
        self.assertNotIn("0x", json.dumps([records, matches]))

    def test_rejects_invalid_identity_root_class_index_and_edge(self):
        for mutate in (lambda s: s["nodes"].__setitem__(5, "0x1"),
                       lambda s: s["nodes"].__setitem__(9, -1),
                       lambda s: s["nodes"].__setitem__(12, "0x2000"),
                       lambda s: s["edges"].__setitem__(0, 999),
                       lambda s: s.__setitem__("roots", [999, 0, 0]),
                       lambda s: s["edgeNames"].__setitem__(0, "other")):
            data = snapshot()
            mutate(data)
            with self.assertRaises(AssertionError):
                stack["snapshot_plan"](data, 0x1000)

    def test_incomplete_detach_timeout_or_missing_parent_marker_is_not_success(self):
        receipt = {key: True for key in ("attached", "identityQualified", "mainThreadQualified", "captured", "detached")}
        good = {"version": 1, "parentContinued": True, "debuggerExitCode": 0, "debuggerSignal": None, "receipt": receipt}
        observe = lambda row: controller["stack_observations"]("[invitation-stack] " + json.dumps(row))["complete"]
        self.assertTrue(observe(good))
        for key, value in (("debuggerExitCode", 124), ("debuggerSignal", "SIGKILL"), ("parentContinued", False)):
            self.assertFalse(observe({**good, key: value}))
        for key in receipt:
            changed = copy.deepcopy(good)
            changed["receipt"][key] = False
            self.assertFalse(observe(changed))
        with self.assertRaises(AssertionError):
            controller["stack_observations"]("")


if __name__ == "__main__":
    unittest.main()
