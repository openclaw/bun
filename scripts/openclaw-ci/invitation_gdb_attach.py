"""Prepared GDB attachment-only preflight; no inferior expressions or calls."""

import hashlib
import json
import os
from pathlib import Path

import gdb


PROFILE_SHA256 = "522fdc6d7f2a627d891195dadd2ee8a8e416efecde6be249cda965d8f5d752fb"
root = Path(os.environ["OPENCLAW_INVITATION_STACK_DIR"])
receipt = {"version": 1, "attached": False, "detached": False, "captured": False,
           "captureMode": "attachment-only", "diagnosticOnly": True, "qualifiesRepin": False}
inferior = gdb.selected_inferior()
try:
    assert inferior.is_valid() and inferior.pid > 0
    receipt["attached"] = True
    path = root / "snapshot.json"
    assert path.stat().st_size <= 4096
    identity = json.loads(path.read_text())
    pid = identity["pid"]
    assert type(pid) is int and pid > 0 and inferior.pid == pid
    assert identity["revision"] == "9debcc4b9db331d8ea8be404754baf1ffd0c7175"
    assert identity["startTime"] == Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
    with Path(f"/proc/{pid}/exe").open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    assert digest == PROFILE_SHA256
    receipt.update(identityQualified=True, executableSHA256=digest)
except Exception as error:
    receipt["errorCategory"] = type(error).__name__
finally:
    try:
        if inferior.is_valid() and inferior.pid > 0:
            gdb.execute("detach", to_string=True)
            receipt["detached"] = gdb.selected_inferior().pid == 0
    except Exception as error:
        receipt["detachErrorCategory"] = type(error).__name__
    (root / "receipt.json").write_text(json.dumps(receipt) + "\n")
