#!/usr/bin/env python3
"""Stage the reviewed benchmark payload beside the existing native owners."""
import hashlib,json,shutil
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')
assert not (ROOT/'benchmark-prep').exists()
manifest=json.loads((HERE/'payload/payload-manifest.json').read_text())
for name,digest in manifest.items():assert hashlib.sha256((HERE/'payload'/name).read_bytes()).hexdigest()==digest,name
shutil.copytree(HERE/'payload',ROOT/'benchmark-prep')
