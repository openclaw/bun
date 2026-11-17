"""Read bounded transformed-code evidence only after the native test owner settles."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat


TARGET = "src/config/sessions/session-turn.ts"
SOURCE_SHA256 = "35a0a57ef09687a1b46aa8123f7c4a92c3355bccce808fa4820ef8c33dfb8ccc"
PATCH_SHA256 = "a2a78abe9470cc2ceb0d4eeb81acfc62d6180e9990bc866a7771ba60b1320ea6"
CHUNKS = {
    "cli-api.De07GUeT.js": "8b527adb355c8e7397939baece62749f3f334d1e",
    "index.1TqnEahn.js": "235714c7cbe244a81c1d6f775443ac36868ffc13",
}
FOOTER = b"\n//# vitestCache="
TAIL_LIMIT = 128 * 1024
TOTAL_TAIL_LIMIT = 64 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024
MATCHED_LIMIT = 16 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def metadata_fields(encoded):
    raw = base64.b64decode(encoded, validate=True)
    table = json.loads(raw.decode("utf-8"))
    assert isinstance(table, list) and table and isinstance(table[0], dict)
    fields = {}
    # Decode only these three FLATTED references; never revive or evaluate the table.
    for key in ("file", "id", "url"):
        ref = table[0][key]
        assert isinstance(ref, str) and re.fullmatch(r"0|[1-9][0-9]*", ref)
        index = int(ref)
        assert index < len(table) and isinstance(table[index], str)
        fields[key] = table[index]
    return fields, raw


def snippets(code, remaining):
    namespaces = set(re.findall(r"\b_usingCtx\d*\s*=\s*\(\s*0\s*,\s*(__vite_ssr_import_\d+__)\.default\s*\)\s*\(", code))
    native_disposal = r"^\s*(?:await\s+)?using\s+[A-Za-z_$][\w$]*\s*="
    lowered_disposal = r"__using|__dispose|__addDisposableResource|_using_ctx|Symbol\.(?:asyncDispose|dispose)|\b_usingCtx\d*\.d\s*\(\s*\)"
    anchors = {
        "function": r"\bfunction appendSessionTurnInWorker\b",
        "prepare-phase": r"persist\.turn\.prepare",
        "completion-phase": r"persist\.turn\.completion",
        "disposal": f"{native_disposal}|{lowered_disposal}",
        "helper-linkage": r"\b(?:const|let|var)\s+(__vite_ssr_import_\d+__)\s*=",
    }
    rows, counts, clipped = [], {}, False
    lines = code.splitlines()
    native_count = sum(bool(re.search(native_disposal, line)) for line in lines)
    lowered_count = sum(bool(re.search(lowered_disposal, line)) for line in lines)
    declarations = {i: match[1] for i, line in enumerate(lines)
                    if (match := re.search(anchors["helper-linkage"], line)) and match[1] in namespaces}
    for label, pattern in anchors.items():
        hits = list(declarations) if label == "helper-linkage" else [i for i, line in enumerate(lines) if re.search(pattern, line)]
        counts[label] = len(hits)
        chosen = hits[:2] + hits[-2:] if label == "disposal" and len(hits) > 4 else hits[:4]
        clipped |= len(hits) > len(chosen)
        for index in chosen:
            block = "\n".join(lines[max(0, index - 5):index + 9])
            linkage = {}
            if label == "helper-linkage":
                public = re.search(r"\b(?:const|let|var)\s+" + re.escape(declarations[index])
                    + r'''\s*=\s*await\s+__vite_ssr_import__\(\s*(["'])(@babel/runtime/helpers/(?:esm/)?usingCtx)\1\s*[,)]''', lines[index])
                linkage = {"declarationSHA256": sha(lines[index].encode()),
                           "publicModule": public[2] if public else "unresolved"}
            if any(max(0, index - 5) <= line < index + 9 for line in declarations):
                # Also redact overlapping excerpts, not just the helper's own anchor.
                block = re.sub(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`''',
                    lambda match: json.dumps(match[0][1:-1]) if match[0][1:-1] in {
                        "@babel/runtime/helpers/usingCtx", "@babel/runtime/helpers/esm/usingCtx"} else '"<redacted>"', block)
            block = "\n".join(line for line in block.splitlines()
                              if not re.search(r"//[#@]\s*(?:source(?:Mapping)?URL|vitestCache)=", line))
            # Only sanitized excerpts leave the private cell; raw hashes bind the original bytes.
            block = re.sub(r"(?:file://)?/(?:[^\s\"'`<>]+)", "<path>", block)
            block = re.sub(r"[A-Za-z]:[\\/][^\s\"'`<>]+", "<path>", block)
            block = re.sub(r"https?://[^\s\"'`<>]+", "<url>", block)
            encoded = block.encode("utf-8")
            budget = min(1600, remaining)
            truncated = len(encoded) > budget
            clipped |= truncated
            text = encoded[:budget].decode("utf-8", errors="ignore")
            remaining -= len(text.encode("utf-8"))
            rows.append({"anchor": label, "line": index + 1, "text": text, "truncated": truncated, **linkage})
    linkage_complete = (bool(namespaces) and len(declarations) == len(namespaces) <= 4
                        and set(declarations.values()) == namespaces
                        and all(row["publicModule"] != "unresolved" for row in rows if row["anchor"] == "helper-linkage"))
    form = ("mixed" if native_count and lowered_count else "native-using" if native_count
            else "lowered-helper" if lowered_count else "unknown")
    return {"anchorLineCounts": counts, "excerpts": rows, "excerptsTruncated": clipped,
            "helperNamespaceCount": len(namespaces), "helperLinkageComplete": linkage_complete,
            "disposalForm": form,
            "disposalEvidenceComplete": form == "native-using" or form == "lowered-helper" and linkage_complete}, remaining


def capture(source, cache):
    result = {"target": TARGET, "complete": False, "diagnosticOnly": True, "qualifiesRepin": False,
              "limitations": ["cache production does not prove evaluation, branch execution or retention cause",
                              "all matching variants are retained; no newest-variant selection",
                              "excerpts are sanitized and bounded; raw code and metadata are not exported"],
              "selectionGaps": [], "entries": 0, "tailBytes": 0, "matchedBytes": 0, "candidates": []}
    gaps = result["selectionGaps"]
    stage = "installed-contract"
    try:
        source = source.resolve(strict=True)
        target = source / TARGET
        original = target.read_bytes()
        assert sha(original) == SOURCE_SHA256
        assert sha((source / "patches/vitest@5.0.5.patch").read_bytes()) == PATCH_SHA256
        chunks = {}
        result["contract"] = {"patchSHA256": PATCH_SHA256, "chunks": chunks, "sourceSHA256": SOURCE_SHA256,
                              "metadata": "final vitestCache base64 FLATTED table; root file/id/url string references"}
        package = (source / "node_modules/vitest").resolve(strict=True)
        assert package.is_relative_to(source / "node_modules")
        assert json.loads((package / "package.json").read_text())["version"] == "5.0.5"
        result["contract"]["vitestVersion"] = "5.0.5"
        vite = (package.parent / "vite").resolve(strict=True)
        assert vite.is_relative_to(source / "node_modules")
        assert json.loads((vite / "package.json").read_text())["version"] == "8.3.5"
        result["contract"]["viteVersion"] = "8.3.5"
        for name, expected in CHUNKS.items():
            path = package / "dist/chunks" / name
            assert path.is_file() and not path.is_symlink() and path.stat().st_size <= FILE_LIMIT
            data = path.read_bytes()
            blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            chunks[name] = {"gitBlob": blob, "expectedGitBlob": expected, "sha256": sha(data)}
            assert blob == expected, "installed bytes differ from exact candidate patch target"
        stage = "private-cache"
        assert cache.is_dir() and not cache.is_symlink() and cache.resolve() == cache
        stack = [(cache, 0)]
        remaining = 32 * 1024
        stopped = False
        while stack and not stopped:
            directory, depth = stack.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    result["entries"] += 1
                    if result["entries"] >= 20_000:
                        gaps.append("entry-limit")
                        stopped = True
                        break
                    if entry.is_symlink():
                        gaps.append("symlink-entry")
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if depth == 8:
                            gaps.append("depth-limit")
                        else:
                            stack.append((Path(entry.path), depth + 1))
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        gaps.append("nonregular-entry")
                        continue
                    with os.fdopen(os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
                        info = os.fstat(stream.fileno())
                        assert stat.S_ISREG(info.st_mode)
                        size = min(info.st_size, TAIL_LIMIT)
                        if result["tailBytes"] + size > TOTAL_TAIL_LIMIT:
                            gaps.append("tail-byte-limit")
                            stopped = True
                            break
                        stream.seek(info.st_size - size)
                        tail = stream.read(size)
                        after = os.fstat(stream.fileno())
                        assert len(tail) == size and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                        result["tailBytes"] += len(tail)
                        offset = tail.rfind(FOOTER)
                        if offset < 0:
                            if info.st_size >= TAIL_LIMIT:
                                gaps.append("footer-window-limit")
                            continue
                        try:
                            fields, metadata = metadata_fields(tail[offset + len(FOOTER):])
                        except (AssertionError, ValueError, KeyError, UnicodeError):
                            gaps.append("metadata-format")
                            continue
                        if fields["file"] != str(target):
                            continue
                        if info.st_size > FILE_LIMIT or result["matchedBytes"] + info.st_size > MATCHED_LIMIT:
                            gaps.append("matched-byte-limit")
                            stopped = True
                            break
                        stream.seek(0)
                        data = stream.read(info.st_size + 1)
                        after = os.fstat(stream.fileno())
                        assert len(data) == info.st_size and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                    boundary = info.st_size - size + offset
                    code = data[:boundary]
                    evidence, remaining = snippets(code.decode("utf-8"), remaining)
                    result["matchedBytes"] += len(data)
                    result["candidates"].append({"variant": len(result["candidates"]) + 1,
                        "cacheFileSHA256": sha(data), "codeSHA256": sha(code), "metadataSHA256": sha(metadata),
                        "footerSHA256": sha(data[boundary:]),
                        "idSHA256": sha(fields["id"].encode()), "urlSHA256": sha(fields["url"].encode()),
                        "cacheFileBytes": len(data), "codeBytes": len(code), **evidence})
                    if len(result["candidates"]) == 16:
                        gaps.append("candidate-limit")
                        stopped = True
                        break
        if not result["candidates"]:
            gaps.append("no-matching-cache-entry")
        result["selectionGaps"] = sorted(set(gaps))
        result["codeGroups"] = [{"codeSHA256": digest,
            "variants": [row["variant"] for row in result["candidates"] if row["codeSHA256"] == digest],
            "metadataSHA256": [row["metadataSHA256"] for row in result["candidates"] if row["codeSHA256"] == digest]}
            for digest in dict.fromkeys(row["codeSHA256"] for row in result["candidates"])]
        result["selectionComplete"] = not gaps and bool(result["candidates"])
        result["complete"] = result["selectionComplete"] and all(
            not row["excerptsTruncated"] and row["disposalEvidenceComplete"]
            and all(row["anchorLineCounts"][name] for name in
                    ("function", "prepare-phase", "completion-phase", "disposal"))
            for row in result["candidates"])
    except Exception:
        result["selectionGaps"] = sorted(set(gaps + [stage + "-unverified"]))
    if len(json.dumps(result, ensure_ascii=False).encode()) > 64 * 1024:
        for candidate in result["candidates"]:
            candidate["excerpts"] = []
            candidate["excerptsTruncated"] = True
        result["complete"] = False
        result["selectionGaps"].append("output-byte-limit")
    return result
