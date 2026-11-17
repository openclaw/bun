import runpy
from pathlib import Path
import unittest


snippets = runpy.run_path(str(Path(__file__).with_name("invitation-cache-code.py")))["snippets"]


class DisposalEvidenceTests(unittest.TestCase):
    def test_native_disposal_is_reported_without_a_lowered_helper(self):
        code = """function appendSessionTurnInWorker() {
  using phase = observeDiagnosticsTimelinePhases("persist.turn.prepare");
  await work();
  await using settlementPhase = observeDiagnosticsTimelinePhases("persist.turn.completion");
}"""
        evidence, _ = snippets(code, 32 * 1024)
        self.assertEqual(evidence["anchorLineCounts"]["disposal"], 2)
        self.assertEqual(evidence["disposalForm"], "native-using")
        self.assertTrue(evidence["disposalEvidenceComplete"])
        self.assertFalse(evidence["helperLinkageComplete"])

    def test_lowered_disposal_requires_its_public_helper_linkage(self):
        code = """const __vite_ssr_import_1__ = await __vite_ssr_import__("@babel/runtime/helpers/usingCtx");
function appendSessionTurnInWorker() {
  const _usingCtx = (0, __vite_ssr_import_1__.default)();
  work("persist.turn.prepare");
  work("persist.turn.completion");
  _usingCtx.d();
}"""
        for source, complete in ((code, True), (code.split("\n", 1)[1], False)):
            with self.subTest(helper_present=complete):
                evidence, _ = snippets(source, 32 * 1024)
                self.assertEqual(evidence["disposalForm"], "lowered-helper")
                self.assertEqual(evidence["disposalEvidenceComplete"], complete)


if __name__ == "__main__":
    unittest.main()
