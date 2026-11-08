"""Exercise release-API admission and atomic publication without network access."""

import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_asset", Path(__file__).with_name("github-release-asset.py"))
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


class ReleaseAssetTests(unittest.TestCase):
    def exercise(self, *, corrupt=False, wrong_pin=False):
        content = b"synthetic release asset"
        digest = hashlib.sha256(content).hexdigest()
        asset = {"id": 42, "name": "asset.zip", "state": "uploaded", "size": len(content), "digest": "sha256:" + digest}
        requests = []

        def respond(request, *, timeout):
            requests.append(request)
            self.assertEqual(timeout, 60)
            self.assertIsNone(request.get_header("Authorization"))
            if len(requests) == 1:
                self.assertEqual(request.full_url, "https://api.github.com/repos/example/project/releases/tags/v1%2Ftest")
                self.assertEqual(request.get_header("Accept"), "application/vnd.github+json")
                return io.BytesIO(json.dumps({"assets": [asset]}).encode())
            self.assertEqual(request.full_url, "https://api.github.com/repos/example/project/releases/assets/42")
            self.assertEqual(request.get_header("Accept"), "application/octet-stream")
            return io.BytesIO(b"!" * len(content) if corrupt else content)

        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "asset.zip"
            destination.write_bytes(b"previous complete asset")
            args = ["download", "example/project", "v1/test", "asset.zip", str(destination), "0" * 64 if wrong_pin else digest, str(len(content))]
            with (
                patch("sys.argv", args),
                patch("urllib.request.urlopen", side_effect=respond),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                if wrong_pin:
                    with self.assertRaisesRegex(ValueError, "differs from the pinned asset"):
                        downloader.main()
                elif corrupt:
                    with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                        downloader.main()
                else:
                    downloader.main()
            self.assertEqual(destination.read_bytes(), b"previous complete asset" if corrupt or wrong_pin else content)
            self.assertEqual(list(Path(folder).glob("*.partial")), [])
            self.assertEqual(len(requests), 1 if wrong_pin else 2)

    def test_verified_asset_replaces_existing_file(self):
        self.exercise()

    def test_corrupt_download_preserves_existing_file(self):
        self.exercise(corrupt=True)

    def test_manifest_mismatch_stops_before_download(self):
        self.exercise(wrong_pin=True)

    def test_transient_api_failure_allows_the_normal_fetch(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "asset.zip"
            with (
                patch("sys.argv", ["download", "example/project", "latest", "asset.zip", str(destination)]),
                patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("https://api.github.com/", 503, "Unavailable", {}, None)),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(downloader.cli(), 75)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
