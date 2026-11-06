"""Exercise release admission without executing an engine or consumer."""

import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("consumers", Path(__file__).with_name("consumers.py"))
consumers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(consumers)


class VitestReceipt(unittest.TestCase):
    def test_only_complete_passing_selection_is_admitted(self):
        for count in (2, 31):
            result = {
                "success": True,
                "numTotalTests": count,
                "numPassedTests": count,
                "numFailedTests": 0,
                "numPendingTests": 0,
                "numTodoTests": 0,
            }
            consumers.require_vitest_result(result, count)
            for changes in (
                {"success": False},
                {"numTotalTests": 0, "numPassedTests": 0},
                {"numTotalTests": count - 1, "numPassedTests": count - 1},
                {"numPassedTests": count - 1, "numFailedTests": 1},
                {"numPassedTests": count - 1, "numPendingTests": 1},
                {"numPassedTests": count - 1, "numTodoTests": 1},
            ):
                with (
                    self.subTest(count=count, changes=changes),
                    self.assertRaisesRegex(ValueError, "must execute and pass"),
                ):
                    consumers.require_vitest_result(result | changes, count)


class ReleaseAdmission(unittest.TestCase):
    def test_primary_archive_identity_and_tampering(self):
        commit, webkit = "a" * 40, "b" * 40
        run = "https://github.com/openclaw/bun/actions/runs/123"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "bun-linux-x64.zip"
            executable = b"synthetic executable bytes; never executed"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("bun-linux-x64/", b"")
                package.writestr("bun-linux-x64/bun", executable)
            manifest = {
                "schemaVersion": 1,
                "repository": "openclaw/bun",
                "bun": {"commit": commit},
                "webkit": {"version": webkit},
                "workflowRun": run,
                "assets": [
                    {
                        "target": "linux-x64",
                        "name": archive.name,
                        "os": "linux",
                        "arch": "x64",
                        "libc": "glibc",
                        "size": archive.stat().st_size,
                        "sha256": consumers.sha(archive),
                        "executable": {
                            "path": "bun-linux-x64/bun",
                            "size": len(executable),
                            "sha256": hashlib.sha256(executable).hexdigest(),
                        },
                    }
                ],
            }

            def write_manifest():
                (root / "manifest.json").write_text(json.dumps(manifest))
                (root / "SHA256SUMS").write_text(
                    consumers.sha(root / "manifest.json")
                    + "  manifest.json\n"
                    + consumers.sha(archive)
                    + "  "
                    + archive.name
                    + "\n"
                )

            write_manifest()
            admitted = consumers.admit(root, root / "accepted", commit, webkit, run)
            self.assertEqual(admitted["executable_sha256"], hashlib.sha256(executable).hexdigest())
            self.assertEqual((root / "accepted").read_bytes(), executable)
            for field, value in (
                ("commit", "c" * 40),
                ("webkit", "d" * 40),
                ("run", run + "4"),
            ):
                with (
                    self.subTest(identity=field),
                    self.assertRaisesRegex(ValueError, "source mismatch|different workflow run"),
                ):
                    consumers.admit(
                        root,
                        root / "rejected",
                        value if field == "commit" else commit,
                        value if field == "webkit" else webkit,
                        value if field == "run" else run,
                    )
            manifest["assets"][0]["executable"]["sha256"] = "0" * 64
            write_manifest()
            with self.assertRaisesRegex(ValueError, "executable checksum mismatch"):
                consumers.admit(root, root / "bad-executable", commit, webkit, run)
            with archive.open("ab") as stream:
                stream.write(b"tampered")
            with self.assertRaisesRegex(ValueError, "archive size mismatch"):
                consumers.admit(root, root / "bad-archive", commit, webkit, run)

    def test_archive_member_cannot_escape_or_select_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ("../bun", "bun-linux-x64-profile/bun"):
                with self.subTest(path=path):
                    archive = root / "bun-linux-x64.zip"
                    with zipfile.ZipFile(archive, "w") as package:
                        package.writestr("bun-linux-x64/", b"")
                        package.writestr(path, b"fixture")
                    manifest = {
                        "schemaVersion": 1,
                        "repository": "openclaw/bun",
                        "bun": {"commit": "a" * 40},
                        "webkit": {"version": "b" * 40},
                        "workflowRun": "run",
                        "assets": [
                            {
                                "target": "linux-x64",
                                "name": archive.name,
                                "os": "linux",
                                "arch": "x64",
                                "libc": "glibc",
                                "size": archive.stat().st_size,
                                "sha256": consumers.sha(archive),
                                "executable": {
                                    "path": "bun-linux-x64/bun",
                                    "size": 7,
                                    "sha256": "0" * 64,
                                },
                            }
                        ],
                    }
                    (root / "manifest.json").write_text(json.dumps(manifest))
                    (root / "SHA256SUMS").write_text(
                        consumers.sha(root / "manifest.json")
                        + "  manifest.json\n"
                        + consumers.sha(archive)
                        + "  "
                        + archive.name
                        + "\n"
                    )
                    with self.assertRaisesRegex(ValueError, "unexpected primary archive members"):
                        consumers.admit(root, root / "rejected", "a" * 40, "b" * 40, "run")


if __name__ == "__main__":
    unittest.main()
