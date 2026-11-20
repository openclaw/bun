import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "source_pair_icu", Path(__file__).with_name("source-pair-icu.py")
)
icu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icu)


class SourcePairIcuTest(unittest.TestCase):
    def test_exports_the_unchanged_icu_recipe_without_building_webkit(self):
        prefix = "FROM base as lane\nCOPY icu/ /icu-bun/\nRUN build-patched-icu\n\n"
        recipe = prefix + icu.MARKER + "\nRUN build-webkit\n"
        exported = icu.export_recipe(recipe)
        self.assertEqual(exported.split("FROM scratch")[0], prefix)
        self.assertIn("COPY --from=lane /output/include/unicode /include/unicode", exported)
        for library in icu.LIBRARIES:
            self.assertIn("/output/lib/" + library, exported)
        self.assertNotIn("build-webkit", exported)
        for invalid in (prefix, recipe + icu.MARKER):
            with self.assertRaises(ValueError):
                icu.export_recipe(invalid)

    def test_keeps_the_pinned_lane_arguments_and_output(self):
        command = [
            "docker", "buildx", "build", "-f", "Dockerfile", "--platform", "linux/amd64",
            "--build-arg", "ICU_VERSION=79.1", "--build-arg", "ICU_SHA256=pinned",
            "--target=artifact", "--output", "type=local,dest=/output", ".",
        ]
        expected = command.copy()
        expected[4] = "/temporary/Dockerfile"
        expected[11] = "--target=source-pair-icu"
        self.assertEqual(icu.export_command(command, Path(expected[4])), expected)
        with self.assertRaises(ValueError):
            icu.export_command(command + ["--target=artifact"], Path(expected[4]))


if __name__ == "__main__":
    unittest.main()
