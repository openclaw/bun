"""Observe the isolated retention child's post-GC stack from hosted LLDB only."""

import hashlib
import json
import os
from pathlib import Path
import re
import signal
import struct
import time

import lldb


def __lldb_init_module(debugger, _internal_dict):
    path = Path(os.environ["SOCKET_RETENTION_SNAPSHOT"])
    output = path.with_name("retention-stack.json")
    target = debugger.GetSelectedTarget()
    process = target.GetProcess()
    receipt = {
        "captured": False,
        "limitation": "Post-GC instrumented observation, not proof that GC scanned a matching word. Absence does not exclude earlier roots or other threads/registers.",
    }
    debugger.SetAsync(True)
    deadline = time.monotonic() + 90
    finished = (lldb.eStateExited, lldb.eStateDetached)
    try:
        if not process.IsValid() or process.GetState() != lldb.eStateStopped:
            raise RuntimeError("Inferior was not launched stopped at entry")
        receipt["pid"] = process.GetProcessID()
        output.write_text(json.dumps(receipt) + "\n")
        entry_stop = process.GetStopID()
        error = process.Continue()
        if not error.Success():
            raise RuntimeError(f"Cannot start the diagnostic inferior: {error}")
        while process.GetState() not in finished:
            if process.GetState() == lldb.eStateStopped and process.GetStopID() != entry_stop:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Inferior did not reach its checkpoint within 90 seconds")
            time.sleep(0.1)
        snapshot = json.loads(path.read_text())
        if process.GetProcessID() != snapshot["pid"]:
            raise RuntimeError("Debugger inferior does not match the snapshot process")
        thread = process.GetSelectedThread()
        if (thread.GetStopReason() != lldb.eStopReasonSignal
                or thread.GetStopReasonDataAtIndex(0) != signal.SIGSTOP):
            raise RuntimeError("Inferior did not stop at the retention checkpoint's SIGSTOP")
        spec = target.GetExecutable()
        executable = Path(spec.GetDirectory()) / spec.GetFilename()
        hasher = hashlib.sha256()
        with executable.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        receipt.update(pid=process.GetProcessID(), revision=snapshot["revision"],
                       executableSHA256=hasher.hexdigest(), stopReason="SIGSTOP", thread=thread.GetThreadID())
        cells = {}
        nodes = snapshot["snapshot"]["nodes"]
        classes = snapshot["snapshot"]["nodeClassNames"]
        for at in range(0, len(nodes), 7):
            cells[int(nodes[at + 5], 16)] = {"id": nodes[at], "class": classes[nodes[at + 2]]}
        handles = {}
        for name, description in snapshot["descriptions"].items():
            found = re.search(r"0x[0-9a-fA-F]+", description)
            if not found:
                raise RuntimeError(f"Missing object address in {name} description")
            address = int(found[0], 16)
            if cells.get(address, {}).get("class") != "TLSSocket":
                raise RuntimeError(f"{name} description does not identify a snapshot TLSSocket")
            handles[address] = name
        receipt["handles"] = {hex(address): {"name": name, **cells[address],
                              "description": snapshot["descriptions"][name]} for address, name in handles.items()}
        frames = []
        for index in range(min(thread.GetNumFrames(), 128)):
            frame = thread.GetFrameAtIndex(index)
            frames.append({"index": index, "name": frame.GetFunctionName(),
                           "pc": hex(frame.GetPC()), "sp": frame.GetSP(), "cfa": frame.GetCFA(),
                           "module": frame.GetModule().GetFileSpec().GetFilename()})
        receipt["frames"] = frames
        frame = thread.GetFrameAtIndex(0)
        region = lldb.SBMemoryRegionInfo()
        error = process.GetMemoryRegionInfo(frame.GetSP(), region)
        if not error.Success() or not region.IsReadable():
            raise RuntimeError("Cannot read the stopped thread's stack mapping")
        start = frame.GetSP() & ~7
        end = region.GetRegionEnd()
        if target.GetAddressByteSize() != 8 or target.GetByteOrder() != lldb.eByteOrderLittle:
            raise RuntimeError("This diagnostic requires the admitted little-endian 64-bit target")
        if not 0 < end - start <= 16 * 1024 * 1024:
            raise RuntimeError("Stopped stack exceeds the 16 MiB observation budget")
        receipt["stack"] = {"mappingStart": hex(region.GetRegionBase()), "mappingEnd": hex(end),
                            "readStart": hex(start), "bytes": end - start}
        error = lldb.SBError()
        memory = process.ReadMemory(start, end - start, error)
        if not error.Success() or len(memory) != end - start:
            raise RuntimeError("Incomplete stopped-stack read")
        matches = []
        for offset in range(0, len(memory) - 7, 8):
            value = struct.unpack_from("<Q", memory, offset)[0]
            if value not in handles:
                continue
            word = start + offset
            owners = [f for f in frames if f["sp"] <= word < f["cfa"] <= end]
            matches.append({"handle": handles[value], "value": hex(value), "word": hex(word),
                            "frames": [f["index"] for f in owners]})
        receipt["matches"] = matches
        receipt["registers"] = []
        for group in frame.GetRegisters():
            if "general" not in (group.GetName() or "").lower():
                continue
            for register in group:
                value = register.GetValueAsUnsigned()
                receipt["registers"].append({"name": register.GetName(), "value": hex(value),
                                             "handle": handles.get(value)})
        receipt["captured"] = True
    except Exception as error:
        receipt["error"] = str(error)
    finally:
        # Resume/reap only the inferior launched for this diagnostic, including incomplete captures.
        if process.IsValid() and process.GetState() == lldb.eStateStopped:
            error = process.Continue()
            if not error.Success():
                receipt["continueError"] = str(error)
        while process.IsValid() and process.GetState() not in finished and time.monotonic() < deadline:
            time.sleep(0.1)
        if process.IsValid() and process.GetState() not in finished:
            error = process.Kill()
            if not error.Success():
                receipt["killError"] = str(error)
            kill_deadline = time.monotonic() + 5
            while process.GetState() not in finished and time.monotonic() < kill_deadline:
                time.sleep(0.1)
        receipt["inferiorExitCode"] = process.GetExitStatus()
        receipt["inferiorState"] = process.GetState()
        receipt["reaped"] = process.GetState() == lldb.eStateExited
        output.write_text(json.dumps(receipt, indent=2) + "\n")
