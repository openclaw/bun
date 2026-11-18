import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
from unittest.mock import patch


controller = runpy.run_path(str(Path(__file__).with_name("profile-layout.py")))
inventory = controller["symbol_inventory"]


class SymbolInventoryTests(unittest.TestCase):
    def test_reports_only_defined_symbol_family_input_without_return_types(self):
        report = inventory([b"unrelated_symbol\n", b"unrelated(int, JSC::Heap::Options)\n",
                            b"void JSC::JSFunction::visitChildren(JSC::SlotVisitor&)\n",
                            b"JSC::JSPromise::result() const\n"])
        self.assertEqual(report["families"]["JSFunction"]["names"],
                         ["JSC::JSFunction::visitChildren(JSC::SlotVisitor&)"])
        self.assertEqual(report["families"]["JSPromise"]["names"], ["JSC::JSPromise::result() const"])
        self.assertEqual(report["families"]["Heap"]["matches"], 0)

    def test_egress_excludes_paths_literals_and_overlong_names(self):
        report = inventory([b"JSC::JSFunction::bad(/private/source)\n",
                            b'JSC::JSFunction::bad("literal")\n',
                            b"JSC::JSFunction::" + b"x" * 256 + b"\n"])
        family = report["families"]["JSFunction"]
        self.assertEqual(family["names"], [])
        self.assertEqual(family["rejected"], 3)

    def test_duplicate_names_do_not_claim_capping_but_new_overflow_does(self):
        rows = [f"JSC::Heap::symbol{i}()\n".encode() for i in range(24)]
        report = inventory(rows * 2)
        self.assertFalse(report["families"]["Heap"]["namesCapped"])
        report = inventory(rows + [b"JSC::Heap::another()\n"])
        self.assertTrue(report["families"]["Heap"]["namesCapped"])
        self.assertEqual(len(report["families"]["Heap"]["names"]), 24)
        self.assertLess(len(json.dumps(report).encode()), controller["REPORT_LIMIT"])

    def test_oversized_input_record_is_rejected(self):
        with self.assertRaises(AssertionError):
            inventory([b"x" * (64 * 1024 + 1)])


class SymbolProcessTests(unittest.TestCase):
    def test_reads_and_reaps_the_symbol_tool(self):
        report = controller["collect_symbols"](
            [sys.executable, "-c", "print('JSC::JSFunction::visitChildren()')"])
        self.assertEqual(report["families"]["JSFunction"]["matches"], 1)

    def test_timeout_kills_and_reaps_a_tool_that_ignores_term(self):
        children = []
        popen = subprocess.Popen
        def start(*args, **kwargs):
            child = popen(*args, **kwargs)
            children.append(child)
            return child
        with patch.object(subprocess, "Popen", side_effect=start), self.assertRaises(TimeoutError):
            controller["collect_symbols"]([sys.executable, "-c",
                "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"], timeout=1)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)


if __name__ == "__main__":
    unittest.main()
