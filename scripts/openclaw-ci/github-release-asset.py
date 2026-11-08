"""Download a public release asset through GitHub's API and verify its digest."""

import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path


def request(url, accept):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "openclaw-bun-ci"}),
        timeout=60,
    )


def main():
    if len(sys.argv) not in (5, 7):
        raise ValueError("expected repository, tag, asset, destination, and optional SHA-256 and size")
    repository, tag, name, destination = sys.argv[1:5]
    base = "https://api.github.com/repos/" + repository + "/releases/"
    release = "latest" if tag == "latest" else "tags/" + urllib.parse.quote(tag, safe="")
    with request(base + release, "application/vnd.github+json") as response:
        metadata = json.load(response)
    assets = [item for item in metadata["assets"] if item["name"] == name and item["state"] == "uploaded"]
    if len(assets) != 1:
        raise ValueError("expected one uploaded release asset: " + name)
    asset = assets[0]
    digest = asset.get("digest") or ""
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest) or asset["size"] <= 0 or asset["id"] <= 0:
        raise ValueError("release asset has no SHA-256, size, or ID: " + name)
    expected = digest.removeprefix("sha256:")
    if len(sys.argv) == 7 and (expected != sys.argv[5] or asset["size"] != int(sys.argv[6])):
        raise ValueError("release metadata differs from the pinned asset: " + name)

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=destination.name + ".", suffix=".partial", delete=False
        ) as output:
            temporary = Path(output.name)
            hashed = hashlib.sha256()
            size = 0
            with request(base + "assets/" + str(asset["id"]), "application/octet-stream") as response:
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    size += len(chunk)
                    if size > asset["size"]:
                        raise ValueError("release asset exceeds its recorded size: " + name)
                    hashed.update(chunk)
                    output.write(chunk)
        if size != asset["size"] or hashed.hexdigest() != expected:
            raise ValueError("release asset size or SHA-256 mismatch: " + name)
        os.replace(temporary, destination)
        print(f"verified {repository} {tag} {name}: {size} bytes, sha256:{expected}", flush=True)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
