"""Read a snapshot-bound stack from the invitation test's own stopped worker."""

import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import struct
import time
import urllib.request


PROFILE_SHA256 = "522fdc6d7f2a627d891195dadd2ee8a8e416efecde6be249cda965d8f5d752fb"
CLASSES = {"<root>", "Object", "FinalObject", "Function", "JSFunction", "AsyncFunction", "Array",
           "JSLexicalEnvironment", "JSModuleEnvironment", "Promise", "InternalPromise",
           "JSGenerator", "AsyncGenerator", "FunctionExecutable", "UnlinkedFunctionExecutable"}


def packet_tail(data):
    assert len(data) <= 65536
    records, rejected = [], 0
    lines = data.decode("utf-8", errors="replace").splitlines()
    if data and not data.endswith(b"\n"):
        lines.pop()
        rejected += 1
    for line in lines:
        if "history[" in line:
            continue
        match = re.search(r"<\s*\d+(?::\d+)?> (send|read) packet: (.*)$", line)
        if not match:
            if "send packet:" in line or "read packet:" in line:
                rejected += 1
            continue
        direction, packet = match.groups()
        if len(packet) > 32768 or not packet:
            rejected += 1
            continue
        body = packet[1:].split("#", 1)[0] if packet[0] in "$%" else packet
        if direction == "send":
            kind = next((name for name in ("qSupported", "QStartNoAckMode", "vAttach", "qProcessInfo",
                "qfThreadInfo", "qsThreadInfo", "qThreadStopInfo", "qRegisterInfo", "qXfer",
                "qSymbol", "jModulesInfo", "jThreadsInfo") if body.startswith(name)), "other")
            if body == "qC":
                kind = "qC"
            elif body == "g" or re.fullmatch(r"p[0-9a-fA-F]+", body):
                kind = "register-read"
            elif re.match(r"[mx][0-9a-fA-F]+,", body):
                kind = "memory-read"
            elif body == "D" or body.startswith("D;"):
                kind = "detach"
        else:
            kind = ("ack" if packet == "+" else "nack" if packet == "-" else
                    "notification" if packet.startswith("%") else "unsupported" if not body else
                    "OK" if body == "OK" else "error" if re.fullmatch(r"E[0-9a-fA-F]{2}(?:;[0-9a-fA-F]*)?", body) else
                    "stop" if body.startswith(("T", "S")) else
                    "exit" if body.startswith(("W", "X")) else "data")
        records.append({"direction": direction, "class": kind})
    return {"tailRecords": records[-32:], "parsedRecords": len(records), "rejectedRecords": rejected,
            "limit": "observed log records only; missing records do not prove no write attempt or partial response"}


def packet_traces(root):
    directories = list(root.iterdir())
    assert len(directories) <= 2 and all(p.is_dir() and not p.is_symlink() for p in directories)
    reports = []
    for directory in directories:
        mode = (directory / "mode.txt").read_text()
        assert mode in {"attachment-only", "stack"}
        log = directory / "attach.log"
        if not log.exists():
            reports.append({"mode": mode, "logPresent": False})
            continue
        assert not log.is_symlink() and log.is_file()
        size = log.stat().st_size
        with log.open("rb") as stream:
            offset = max(0, size - 65536)
            stream.seek(offset)
            tail = stream.read(65536)
        if offset:
            tail = tail.partition(b"\n")[2]
        reports.append({"mode": mode, "logPresent": True, "fileBytes": size,
                        "tailTruncated": bool(offset), "fileLimitReached": size >= 8388608,
                        **packet_tail(tail)})
    return reports


def stage_profile(root, metadata_path, controller):
    profile = runpy.run_path(str(Path(__file__).with_name("profile-layout.py")))
    assert metadata_path.stat().st_size <= 64 * 1024
    metadata = json.loads(metadata_path.read_text())
    assert metadata["binding"] == profile["binding"](controller)
    archive = root / "profile.zip"
    deadline = time.monotonic() + 600
    size, digest = 0, hashlib.sha256()
    request = urllib.request.Request(profile["URL"], headers={"User-Agent": "openclaw-invitation-stack"})
    with urllib.request.urlopen(request, timeout=60) as response, archive.open("xb") as stream:
        while chunk := response.read(1024 * 1024):
            assert time.monotonic() < deadline
            size += len(chunk)
            assert size <= profile["ARCHIVE_SIZE"]
            digest.update(chunk)
            stream.write(chunk)
    assert size == profile["ARCHIVE_SIZE"] and digest.hexdigest() == profile["ARCHIVE_SHA"]
    binary = root / "profile-bin" / "bun"
    binary.parent.mkdir(mode=0o700)
    member = profile["extract"](archive, binary, deadline)
    assert member["sha256"] == PROFILE_SHA256
    binary.chmod(0o700)
    return binary, {"binding": metadata["binding"], "executableSHA256": PROFILE_SHA256,
                    "scope": "same revision, distinct published profile executable; diagnostic only"}


def snapshot_plan(snapshot, address):
    assert snapshot["version"] == 3 and snapshot["type"] == "GCDebugging"
    nodes, edges, roots = (snapshot[key] for key in ("nodes", "edges", "roots"))
    assert len(nodes) % 7 == len(edges) % 4 == len(roots) % 3 == 0
    assert len(nodes) <= 7_000_000 and len(edges) <= 16_000_000 and len(roots) <= 3_000_000
    cells, by_id = {}, {}
    for at in range(0, len(nodes), 7):
        node_id = nodes[at]
        assert type(node_id) is int and node_id >= 0 and node_id not in by_id
        class_index = nodes[at + 2]
        assert type(class_index) is int and 0 <= class_index < len(snapshot["nodeClassNames"])
        class_name = snapshot["nodeClassNames"][class_index]
        assert isinstance(class_name, str)
        if node_id == 0:
            assert at == 0 and nodes[:7] == [0, 0, 0, 0, 0, "0x0", "0x0"]
            assert class_name == "<root>"
            by_id[node_id] = (0, "<root>")
            continue
        raw = nodes[at + 5]
        assert isinstance(raw, str) and re.fullmatch(r"0x[0-9a-fA-F]{1,16}", raw)
        cell = int(raw, 16)
        assert cell > 0 and cell not in cells
        by_id[node_id] = (cell, class_name)
        cells[cell] = node_id
    target = cells.get(address)
    assert target is not None and by_id[target][1] in {"Object", "FinalObject"}
    assert 0 in by_id
    selected, frontier = {target}, {target}
    reverse = {}
    sentinel_property = False
    for at in range(0, len(edges), 4):
        source, destination = edges[at:at + 2]
        assert type(source) is int and type(destination) is int and source in by_id and destination in by_id
        edge_type, name = edges[at + 2:at + 4]
        assert type(edge_type) is int and 0 <= edge_type < len(snapshot["edgeTypes"])
        assert type(name) is int and name >= 0
        if snapshot["edgeTypes"][edge_type] in {"Property", "Variable"}:
            assert name < len(snapshot["edgeNames"])
            if source == target and snapshot["edgeNames"][name] == "sentinel":
                sentinel_property = by_id[destination][1] in {"String", "string"}
        reverse.setdefault(destination, set()).add(source)
    assert sentinel_property, "sentinel shape missing"
    for _ in range(16):
        parents = {source for child in frontier for source in reverse.get(child, ())} - selected
        if not parents:
            break
        selected.update(parents)
        assert len(selected) <= 96, "reverse graph budget"
        frontier = parents
    assert not {source for child in frontier for source in reverse.get(child, ())} - selected, "reverse graph depth budget"
    order = [target] + sorted(selected - {target})
    local_ids = {node_id: f"n{index}" for index, node_id in enumerate(order)}
    addresses, records = {}, []
    root_ids = set(roots[::3])
    assert all(type(node_id) is int and node_id in by_id for node_id in root_ids)
    for node_id in order:
        cell, class_name = by_id[node_id]
        record = {"cell": local_ids[node_id], "class": class_name if class_name in CLASSES else "Other",
                  "reportedIncoming": len(reverse.get(node_id, ())), "reportedRoot": node_id in root_ids,
                  "incomingCells": sorted(local_ids[parent] for parent in reverse.get(node_id, ()))}
        records.append(record)
        if cell:
            addresses[cell] = record["cell"]
    return addresses, records


def stack_matches(memory, start, cells, bounds):
    assert len(memory) % 8 == 0 and len(memory) <= 8 * 1024 * 1024
    matches = {}
    for offset in range(0, len(memory), 8):
        cell = cells.get(struct.unpack_from("<Q", memory, offset)[0])
        if cell is None:
            continue
        record = matches.setdefault(cell, {"cell": cell, "occurrences": 0,
                                           "firstStackOffset": offset, "matchingFrames": []})
        record["occurrences"] += 1
        if record["occurrences"] == 1:
            word = start + offset
            record["matchingFrames"] = [index for index, sp, cfa in bounds if sp <= word < cfa]
    return list(matches.values())


def __lldb_init_module(debugger, _internal_dict):
    import lldb

    process = debugger.GetSelectedTarget().GetProcess()
    if not process.IsValid():
        print("openclaw-lldb-module-ready")
        return
    root = Path(os.environ["OPENCLAW_INVITATION_STACK_DIR"])
    phase = lambda name: (root / "phase.txt").write_text(name)
    phase("collector-entered")
    output = root / "receipt.json"
    receipt = {"version": 1, "attached": False, "detached": False, "captured": False,
               "diagnosticOnly": True, "qualifiesRepin": False,
               "jitModuleLoading": False,
               "limitation": "Post-GC stack occurrences only; frame bounds do not prove ownership, a root, or what GC scanned. Other threads are not inspected. JIT module names and unwinding are unqualified with the debugger JIT loader disabled."}
    try:
        assert process.IsValid() and process.GetState() == lldb.eStateStopped
        receipt["attached"] = True
        target = debugger.GetSelectedTarget()
        assert target.GetAddressByteSize() == 8 and target.GetByteOrder() == lldb.eByteOrderLittle
        assert "x86_64" in target.GetTriple() and "linux" in target.GetTriple()
        path = root / "snapshot.json"
        assert path.stat().st_size <= 128 * 1024 * 1024
        snapshot = json.loads(path.read_text())
        pid = snapshot["pid"]
        assert type(pid) is int and pid > 0 and process.GetProcessID() == pid
        assert snapshot["revision"] == "9debcc4b9db331d8ea8be404754baf1ffd0c7175"
        assert snapshot["startTime"] == Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
        spec = target.GetExecutable()
        executable = Path(spec.GetDirectory()) / spec.GetFilename()
        with executable.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        assert digest == PROFILE_SHA256
        receipt.update(identityQualified=True, executableSHA256=digest)
        phase("identity-qualified")
        if os.environ.get("OPENCLAW_INVITATION_STACK_ATTACH_ONLY") == "1":
            receipt["captureMode"] = "attachment-only"
            return
        receipt["captureMode"] = "stack"
        cells, records = snapshot_plan(snapshot["snapshot"], int(snapshot["address"], 16))
        phase("snapshot-indexed")
        receipt["snapshotCells"] = records
        thread = process.GetThreadByID(pid)
        assert thread.IsValid(), "Linux main thread missing"
        receipt.update(mainThreadQualified=True, omittedThreadCount=process.GetNumThreads() - 1)
        frames, bounds = [], []
        for index in range(min(thread.GetNumFrames(), 64)):
            frame = thread.GetFrameAtIndex(index)
            sp, cfa = frame.GetSP(), frame.GetCFA()
            if 0 < sp < cfa:
                bounds.append((index, sp, cfa))
            name = frame.GetFunctionName() or "<unavailable>"
            if len(name) > 256 or not re.fullmatch(r"[A-Za-z0-9_:~<>,*&()\[\] .+\-=]+", name):
                name = "<unrepresented>"
            module = frame.GetModule().GetFileSpec().GetFilename() or ""
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", module):
                module = "<unrepresented>"
            pc = frame.GetPCAddress().GetFileAddress()
            frames.append({"index": index, "function": name, "module": module,
                           "moduleFileAddress": None if pc == lldb.LLDB_INVALID_ADDRESS else pc,
                           "boundsAvailable": 0 < sp < cfa})
        receipt["frames"] = frames
        receipt["framesCapped"] = thread.GetNumFrames() > 64
        phase("frames-read")
        frame = thread.GetFrameAtIndex(0)
        start = frame.GetSP() & ~7
        region = lldb.SBMemoryRegionInfo()
        error = process.GetMemoryRegionInfo(start, region)
        assert error.Success() and region.IsReadable()
        end = region.GetRegionEnd() & ~7
        assert 0 < end - start <= 8 * 1024 * 1024
        error = lldb.SBError()
        memory = process.ReadMemory(start, end - start, error)
        assert error.Success() and len(memory) == end - start
        receipt["stackBytes"] = len(memory)
        receipt["matches"] = stack_matches(memory, start, cells, bounds)
        receipt["registerMatches"] = []
        for group in frame.GetRegisters():
            if "general" not in (group.GetName() or "").lower():
                continue
            for register in group:
                cell = cells.get(register.GetValueAsUnsigned())
                if cell is not None:
                    receipt["registerMatches"].append({"cell": cell, "register": register.GetName()})
        receipt["captured"] = True
        phase("memory-read")
    except Exception as error:
        receipt["errorCategory"] = type(error).__name__
    finally:
        if process.IsValid():
            error = process.Detach()
            receipt["detached"] = error.Success()
            if receipt["detached"]:
                phase("detached")
        data = json.dumps(receipt, indent=2) + "\n"
        assert len(data.encode()) <= 64 * 1024
        output.write_text(data)
