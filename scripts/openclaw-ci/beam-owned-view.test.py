import json
from pathlib import Path
import runpy
import unittest


controller = runpy.run_path(str(Path(__file__).with_name("openclaw-linux-repin.py")))
cases = (
    "HTTP Visitor publications are privately readable by their initial publisher through admitted RPC",
    "preserves model admission and rolls back revoked owned Beam adoption",
)


def log_for(runtime, failed=False, frame=None):
    prefix = "[shard:" + ("bun:" if runtime == "bun" else "") + "agentic-control-plane-runtime-state] "
    lines = [prefix + ("×" if failed and index == 0 else "✓") + " |gateway-server| src/gateway/server.beam-owned-view.test.ts > " + name + " 123ms" for index, name in enumerate(cases)]
    if frame is not None:
        lines.append(prefix + "[beam-owned-failure] " + json.dumps(frame))
    return "\n".join(lines)


def frame(**changes):
    result = {"v": 1, "runtime": "bun", "sequence": 1, "errors": [
        {"edge": "root", "kind": "Error", "frames": [{"path": "src/state/read.ts", "line": 12, "column": 3}]},
        {"edge": "suppressed", "kind": "TypeError", "frames": []},
    ], "truncated": False, "overflow": False}
    result.update(changes)
    return result


class BeamOwnedEvidenceTests(unittest.TestCase):
    def observe(self, log, code):
        return controller["beam_owned_observations"](log, code)

    def test_both_runtimes_and_suppressed_locations(self):
        result = self.observe(log_for("node") + "\n" + log_for("bun", True, frame()), 1)
        self.assertTrue(result["reproduced"])
        self.assertEqual(result["failureFrames"][0]["errors"][1]["edge"], "suppressed")

    def test_both_pass_leaves_original_failure_unresolved(self):
        result = self.observe(log_for("node") + "\n" + log_for("bun"), 0)
        self.assertFalse(result["reproduced"])
        self.assertEqual(result["failureFrames"], [])

    def test_node_cannot_be_silently_omitted(self):
        with self.assertRaises(AssertionError):
            self.observe(log_for("bun", True, frame()), 1)

    def test_missing_or_overflowed_frames_are_incomplete(self):
        for value in (None, frame(overflow=True, sequence=9)):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                self.observe(log_for("node") + "\n" + log_for("bun", True, value), 1)

    def test_private_fields_and_outside_paths_are_refused(self):
        for value in (frame(message="private"), frame(errors=[{"edge": "root", "kind": "Error", "frames": [{"path": "/private/file.ts", "line": 1, "column": 2}]}]), frame(errors=[{"edge": "root", "kind": "Error", "frames": [{"path": "src/../private.ts", "line": 1, "column": 2}]}])):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                self.observe(log_for("node") + "\n" + log_for("bun", True, value), 1)

    def test_unrelated_group_failure_and_bounded_truncation_remain_visible(self):
        result = self.observe(log_for("node") + "\n" + log_for("bun"), 1)
        self.assertTrue(result["otherGroupFailure"])
        result = self.observe(log_for("node") + "\n" + log_for("bun", True, frame(truncated=True)), 1)
        self.assertTrue(result["failureFrames"][0]["truncated"])


if __name__ == "__main__":
    unittest.main()
