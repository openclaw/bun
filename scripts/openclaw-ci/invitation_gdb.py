"""Bounded GDB observation; no inferior expressions, calls or memory writes."""

import hashlib
import json
import os
import re
import runpy
from pathlib import Path

import gdb


PROFILE_SHA256 = "522fdc6d7f2a627d891195dadd2ee8a8e416efecde6be249cda965d8f5d752fb"
root = Path(os.environ["OPENCLAW_INVITATION_STACK_DIR"])
receipt = {"version": 1, "attached": False, "detached": False, "captured": False,
           "diagnosticOnly": True, "qualifiesRepin": False}
inferior = gdb.selected_inferior()


def capture():
    phase = lambda name: (root / "phase.txt").write_text(name)
    phase("collector-entered")
    assert inferior.is_valid() and inferior.pid > 0
    receipt["attached"] = True
    path = root / "snapshot.json"
    attach_only = os.environ.get("OPENCLAW_INVITATION_STACK_ATTACH_ONLY") == "1"
    assert path.stat().st_size <= (4096 if attach_only else 128 * 1024 * 1024)
    identity = json.loads(path.read_text())
    pid = identity["pid"]
    assert type(pid) is int and pid > 0 and inferior.pid == pid
    assert identity["revision"] == "9debcc4b9db331d8ea8be404754baf1ffd0c7175"
    assert identity["startTime"] == Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
    with Path(f"/proc/{pid}/exe").open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    assert digest == PROFILE_SHA256
    receipt.update(identityQualified=True, executableSHA256=digest)
    phase("identity-qualified")
    receipt["captureMode"] = "attachment-only" if attach_only else "stack"
    if attach_only:
        return
    helpers = runpy.run_path(str(Path(__file__).with_name("invitation_stack.py")))
    cells, records = helpers["snapshot_plan"](identity["snapshot"], int(identity["address"], 16))
    receipt["snapshotCells"] = records
    phase("snapshot-indexed")
    threads = inferior.threads()
    assert threads and all(thread.is_stopped() for thread in threads)
    main = [thread for thread in threads if thread.ptid[:2] == (pid, pid)]
    assert len(main) == 1
    main[0].switch()
    assert inferior.architecture().name() == "i386:x86-64"
    receipt.update(mainThreadQualified=True, omittedThreadCount=len(threads) - 1)
    with Path(f"/proc/{pid}/maps").open("rb") as stream:
        data = stream.read(1024 * 1024 + 1)
    assert len(data) <= 1024 * 1024
    mappings = []
    for line in data.decode().splitlines():
        fields = line.split(maxsplit=5)
        lo, hi = (int(value, 16) for value in fields[0].split("-"))
        assert 0 <= lo < hi
        mappings.append((lo, hi, fields[1], int(fields[2], 16), fields[5] if len(fields) == 6 else ""))
    frame = gdb.newest_frame()
    assert frame is not None
    start = int(frame.read_register("rsp")) & ~7
    stack_maps = [item for item in mappings if item[0] <= start < item[1] and "r" in item[2]]
    assert len(stack_maps) == 1
    end = stack_maps[0][1] & ~7
    assert 0 < end - start <= 8 * 1024 * 1024
    frames = []
    while frame is not None and len(frames) < 64:
        pc = frame.pc()
        locations = [item for item in mappings if item[0] <= pc < item[1]]
        assert len(locations) <= 1
        location = locations[0] if locations else None
        file_backed = location is not None and location[4].startswith("/")
        module = Path(location[4]).name if file_backed else "<anonymous>"
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", module):
            module = "<unrepresented>"
        name = frame.name() or "<unavailable>"
        if len(name) > 256 or not re.fullmatch(r"[A-Za-z0-9_:~<>,*&()\[\] .+\-=]+", name):
            name = "<unrepresented>"
        frames.append({"index": len(frames), "function": name, "module": module,
                       "mappingFileOffset": location[3] + pc - location[0] if file_backed else None,
                       "unwindStopReason": frame.unwind_stop_reason()})
        frame = frame.older()
    receipt.update(frames=frames, framesCapped=frame is not None)
    phase("frames-read")
    memory = bytes(inferior.read_memory(start, end - start))
    assert len(memory) == end - start
    receipt.update(stackBytes=len(memory), matches=helpers["stack_matches"](memory, start, cells, []))
    receipt["registerMatches"] = []
    top = gdb.newest_frame()
    for name in ("rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp",
                 "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"):
        cell = cells.get(int(top.read_register(name)))
        if cell is not None:
            receipt["registerMatches"].append({"cell": cell, "register": name})
    receipt.update(captured=True,
                   limitation="Post-GC occurrences only, not GC-scanned roots or frame ownership. Main stack starts at RSP; red zone and other threads omitted. Native unwinding and JIT symbols may be incomplete.")
    phase("memory-read")


try:
    capture()
except Exception as error:
    receipt["errorCategory"] = type(error).__name__
finally:
    try:
        if inferior.is_valid() and inferior.pid > 0:
            gdb.execute("detach", to_string=True)
            receipt["detached"] = gdb.selected_inferior().pid == 0
            if receipt["detached"]:
                (root / "phase.txt").write_text("detached")
    except Exception as error:
        receipt["detachErrorCategory"] = type(error).__name__
    data = json.dumps(receipt) + "\n"
    assert len(data.encode()) <= 64 * 1024
    (root / "receipt.json").write_text(data)
