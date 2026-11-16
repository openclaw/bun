"""Inspect a published profile ELF without executing it or exporting raw debug data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import signal
import stat
import tempfile
import time
import urllib.request
import zipfile


common = runpy.run_path(str(Path(__file__).with_name("openclaw-repin-regression.py")))
COMMIT, TAG, WEBKIT = common["RELEASES"]["new"]
MANIFEST_SHA = "d9697322a7abfdbedbc2e31609ff490ac2615fbc917151247e60a961f8ea2540"
ARCHIVE = "bun-linux-x64-profile.zip"
ARCHIVE_SHA = "0c96a08dc49a1515aeec13380732a8e7ef153bd7d236e97ea6800f7711e56ccb"
ARCHIVE_SIZE = 236890790
MEMBER = "bun-linux-x64-profile/bun-profile"
SIDECARS = {"bun-linux-x64-profile/" + name for name in
            ("bun-profile.linker-map", "features.json", "sections.txt", "retained.txt")}
MEMBER_LIMIT = 900 * 1024 * 1024
RAW_LIMIT = 8 * 1024 * 1024
REPORT_LIMIT = 64 * 1024
URL = "https://github.com/openclaw/bun/releases/download/" + TAG + "/" + ARCHIVE
TYPES = ("JSC::JSFunction", "JSC::FunctionRareData", "JSC::FunctionExecutable",
         "JSC::ScriptExecutable", "JSC::SourceCode", "JSC::UnlinkedSourceCode", "WTF::String")
FIELDS = {"JSC::JSFunction": ("m_executableOrRareData",), "JSC::ScriptExecutable": ("m_source",)}
SECTIONS = (".debug_info", ".debug_abbrev", ".debug_str", ".debug_line", ".debug_types",
            ".symtab", ".dynsym", ".gnu_debuglink", ".note.gnu.build-id")


def binding(controller):
    return {"controller": controller, "source": COMMIT, "tag": TAG, "webkit": WEBKIT,
            "manifestSHA256": MANIFEST_SHA, "archive": ARCHIVE, "archiveSHA256": ARCHIVE_SHA,
            "archiveBytes": ARCHIVE_SIZE, "member": MEMBER}


def admission(controller):
    token = os.environ["BUN_RELEASE_METADATA_TOKEN"]
    release = common["release_api_json"]("releases/tags/" + TAG, token)
    assert release["tag_name"] == TAG and release["prerelease"] and not release["draft"] and release["published_at"]
    obj = common["release_api_json"]("git/ref/tags/" + TAG, token)["object"]
    if obj["type"] == "tag":
        obj = common["release_api_json"]("git/tags/" + obj["sha"], token, obj["sha"])["object"]
    assert obj["type"] == "commit" and obj["sha"] == COMMIT
    assets = {a["name"]: a for a in release["assets"]}
    assert len(assets) == len(release["assets"])
    manifest_url = "https://github.com/openclaw/bun/releases/download/" + TAG + "/manifest.json"
    assert assets["manifest.json"]["browser_download_url"] == manifest_url
    manifest, digest = common["public_json"](manifest_url)
    assert digest == MANIFEST_SHA and assets["manifest.json"]["digest"] == "sha256:" + digest
    assert (manifest["repository"], manifest["tag"], manifest["bun"]["commit"],
            manifest["webkit"]["repository"], manifest["webkit"]["version"]) == (
                "openclaw/bun", TAG, COMMIT, "openclaw/WebKit", WEBKIT)
    rows = [a for a in manifest["assets"] if a["target"] == "linux-x64"]
    assert len(rows) == 1
    assert rows[0]["debugSymbols"] == {"name": ARCHIVE, "url": URL, "size": ARCHIVE_SIZE, "sha256": ARCHIVE_SHA}
    asset = assets[ARCHIVE]
    assert (asset["id"], asset["state"], asset["browser_download_url"], asset["size"], asset["digest"]) == (
        753367614, "uploaded", URL, ARCHIVE_SIZE, "sha256:" + ARCHIVE_SHA)
    return {"binding": binding(controller), "releaseId": release["id"], "profileAssetId": asset["id"],
            "publishedAt": release["published_at"], "prerelease": True}


def number(value):
    match = re.fullmatch(r"\((0x[0-9a-fA-F]+|[0-9]+)\)", value or "")
    return int(match[1], 16 if match[1].startswith("0x") else 10) if match else None


def quoted(value):
    match = re.fullmatch(r'\("([^"\\]*)"\)', value or "")
    return match[1] if match else None


def layout(text, qualified):
    """Read named type DIEs and immediate layout attributes; never resolve a type graph."""
    namespace, name = qualified.split("::")
    entries, stack = [], []
    current = None
    for line in text.splitlines():
        match = re.match(r"^0x[0-9a-fA-F]+:( +)(DW_TAG_\w+|NULL)\s*$", line)
        if match:
            depth = len(match[1])
            while stack and stack[-1]["depth"] >= depth:
                stack.pop()
            current = None
            if match[2] != "NULL":
                current = {"tag": match[2], "depth": depth, "attrs": {}, "parents": tuple(stack), "children": []}
                if stack:
                    stack[-1]["children"].append(current)
                entries.append(current)
                assert len(entries) <= 8192 and len(stack) <= 128, "debug entry budget"
                stack.append(current)
            continue
        assert "DW_TAG_" not in line, "unsupported debug entry format"
        attr = re.match(r"^\s+(DW_AT_\w+)\s+(.*)$", line)
        if attr and current is not None:
            assert attr[1] not in current["attrs"], "duplicate debug attribute"
            current["attrs"][attr[1]] = attr[2].strip()
    definitions, ambiguous, unsupported = [], False, False
    for item in entries:
        if item["tag"] not in ("DW_TAG_class_type", "DW_TAG_structure_type"):
            continue
        attrs = item["attrs"]
        if any(key in attrs for key in ("DW_AT_specification", "DW_AT_abstract_origin", "DW_AT_signature")) or quoted(attrs.get("DW_AT_name")) is None:
            unsupported = True
            continue
        if quoted(attrs["DW_AT_name"]) != name:
            continue
        scopes = [quoted(p["attrs"].get("DW_AT_name")) for p in item["parents"]
                  if p["tag"] in ("DW_TAG_namespace", "DW_TAG_class_type", "DW_TAG_structure_type")]
        if not scopes or None in scopes:
            ambiguous = True
            continue
        if scopes != [namespace]:
            continue
        declaration = attrs.get("DW_AT_declaration")
        if declaration is not None:
            assert declaration in ("(true)", "(false)") or number(declaration) in (0, 1), "unsupported declaration flag"
            if declaration == "(true)" or number(declaration) == 1:
                continue
        size = number(attrs.get("DW_AT_byte_size"))
        if not size or size > 1024 * 1024:
            ambiguous = True
            continue
        members = [c["attrs"] for c in item["children"] if c["tag"] == "DW_TAG_member"]
        bases = [c["attrs"] for c in item["children"] if c["tag"] == "DW_TAG_inheritance"]
        fields = {}
        for field in FIELDS.get(qualified, ()):
            matches = [a for a in members if quoted(a.get("DW_AT_name")) == field]
            location = number(matches[0].get("DW_AT_data_member_location")) if len(matches) == 1 else None
            if location is not None:
                assert location < size, "member offset outside type"
            fields[field] = {"present": len(matches) == 1, "byteOffset": location,
                             "typeReferencePresent": len(matches) == 1 and bool(re.match(r"\(0x[0-9a-fA-F]+(?:\s|\))", matches[0].get("DW_AT_type", "")))}
        definitions.append({"byteSize": size, "inheritanceCount": len(bases),
                            "inheritanceLocationsAvailable": all(number(a.get("DW_AT_data_member_location")) is not None for a in bases),
                            "inheritanceTypeReferencesAvailable": all(bool(re.match(r"\(0x[0-9a-fA-F]+(?:\s|\))", a.get("DW_AT_type", ""))) for a in bases),
                            "memberCount": len(members),
                            "memberLocationsAvailable": all(number(a.get("DW_AT_data_member_location")) is not None for a in members),
                            "requiredFields": fields})
    distinct = {json.dumps(item, sort_keys=True) for item in definitions}
    result = {"queryComplete": True, "definitionCount": len(definitions), "namespaceAmbiguous": ambiguous,
              "unsupportedTypeDefinition": unsupported, "reportedAttributesAgree": len(distinct) <= 1,
              "completeDefinitionPresent": bool(definitions)}
    if len(distinct) == 1:
        result.update(definitions[0])
    result["attributesSupported"] = not unsupported and (not definitions or (len(distinct) == 1
        and result["inheritanceLocationsAvailable"] and result["inheritanceTypeReferencesAvailable"]
        and result["memberLocationsAvailable"]
        and all(not f["present"] or (f["byteOffset"] is not None and f["typeReferencePresent"])
                for f in result.get("requiredFields", {}).values())))
    result["necessaryLayoutAvailable"] = bool(definitions) and not ambiguous and result["attributesSupported"] and len(distinct) == 1 and all(
        f["present"] and f["byteOffset"] is not None and f["typeReferencePresent"]
        for f in result.get("requiredFields", {}).values()) and result.get("inheritanceLocationsAvailable", False)
    return result


def elf_summary(text):
    assert re.search(r"Class:\s+ELF64\b", text) and re.search(r"Machine:\s+Advanced Micro Devices X86-64\b", text)
    assert re.search(r"Data:\s+2's complement, little endian", text)
    sections = {name: bool(re.search(r"\]\s+" + re.escape(name) + r"\s+", text)) for name in SECTIONS}
    ids = set(re.findall(r"Build ID:\s*([0-9a-fA-F]{16,128})\b", text))
    assert len(ids) <= 1
    return {"elf64": True, "x86_64": True, "littleEndian": True,
            "sections": sections, "buildID": next(iter(ids), None)}


def extract(archive, destination, deadline):
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        assert len(infos) <= 16 and len({i.filename for i in infos}) == len(infos)
        assert all(i.filename in SIDECARS | {MEMBER, "bun-linux-x64-profile/"} for i in infos)
        assert all(stat.S_IFMT(i.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR) for i in infos)
        info = z.getinfo(MEMBER)
        assert not info.is_dir() and not info.flag_bits & 1 and stat.S_IFMT(info.external_attr >> 16) in (0, stat.S_IFREG)
        assert 0 < info.file_size <= MEMBER_LIMIT
        size, digest = 0, hashlib.sha256()
        with z.open(info) as src, destination.open("xb") as out:
            os.chmod(destination, 0o600)
            while chunk := src.read(1024 * 1024):
                assert time.monotonic() < deadline, "controller deadline"
                size += len(chunk)
                assert size <= info.file_size
                digest.update(chunk)
                out.write(chunk)
        assert size == info.file_size
        return {"bytes": size, "sha256": digest.hexdigest(), "executablePermission": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("metadata", "inspect"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--controller-sha", required=True)
    args = parser.parse_args()
    assert re.fullmatch("[0-9a-f]{40}", args.controller_sha)
    out = args.out.resolve()
    out.mkdir(mode=0o700, exist_ok=True)
    report = {"binding": binding(args.controller_sha), "status": "INCONCLUSIVE", "diagnosticOnly": True,
              "qualifiesRepin": False, "binaryExecuted": False, "debuggerAttached": False, "debuggerReady": False,
              "remainingReferencedTypesUnqualified": True, "symbolsUnqualified": True, "liveCellIdentityMissing": True,
              "tools": [], "layouts": {}, "settlementUncertain": False, "phase": args.phase,
              "stateDisposition": "retained for hosted runner teardown"}
    def save():
        data = json.dumps(report, indent=2) + "\n"
        assert len(data.encode()) <= REPORT_LIMIT
        (out / "report.json").write_text(data)
    save()
    try:
        if args.phase == "metadata":
            receipt = admission(args.controller_sha)
            (out / "metadata.json").write_text(json.dumps(receipt) + "\n")
            report["status"] = "METADATA_ADMITTED"
            return
        assert platform.system() == "Linux" and platform.machine() == "x86_64"
        assert "BUN_RELEASE_METADATA_TOKEN" not in os.environ
        assert (out / "metadata.json").stat().st_size <= REPORT_LIMIT
        metadata = json.loads((out / "metadata.json").read_text())
        assert metadata["binding"] == binding(args.controller_sha)
        report["metadataSHA256"] = common["sha"](out / "metadata.json")
        root = Path(tempfile.mkdtemp(prefix="profile-layout-"))
        env = common["private_env"](root / "tools", os.environ["PATH"])
        env["LANG"] = "C"
        deadline = time.monotonic() + 15 * 60
        def expired(signum, frame):
            raise TimeoutError("controller deadline")
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(15 * 60)
        def checked(command, label):
            captured = []
            def withheld(text):
                captured.append(text)
                return "raw tool output withheld; parsed in private memory\n"
            report["step"] = label
            report["settlementUncertain"] = True
            result = common["run"](command, root, env, root / "withheld.log", withheld,
                                   timeout=min(60, max(1, int(deadline - time.monotonic()))), output_limit=RAW_LIMIT)
            report["tools"].append({"step": label, **{k: result[k] for k in ("exitCode", "controllerFailure", "settlementUncertain")}})
            report["settlementUncertain"] = result["settlementUncertain"]
            assert not result["settlementUncertain"] and result["exitCode"] == 0, "tool incomplete"
            assert len(captured) == 1 and "\ufffd" not in captured[0], "unsupported tool encoding"
            return captured[0]
        tools = {}
        report["toolVersions"] = {}
        for name in ("readelf", "llvm-dwarfdump"):
            choices = [name] + ([name + "-" + str(v) for v in range(23, 17, -1)] if name == "llvm-dwarfdump" else [])
            path = next((shutil.which(n) for n in choices if shutil.which(n)), None)
            assert path, "required installed tool missing"
            tools[name] = str(Path(path).resolve())
            version = checked([tools[name], "--version"], name + "-version")
            match = re.search(r"\b(\d+[.]\d+(?:[.]\d+)?)\b", version)
            assert match, "tool version unrecognized"
            report["toolVersions"][name] = match[1]
            help_text = checked([tools[name], "--help"], name + "-options")
            options = {"readelf": ("--wide", "--file-header", "--section-headers", "--notes"),
                       "llvm-dwarfdump": ("--debug-info", "--name", "--show-parents", "--show-children")}[name]
            assert all(option in help_text for option in options), "required tool option missing"
        report["toolPreflightComplete"] = True
        report["step"] = "archive-download"
        archive = root / "profile.zip"
        size, digest = 0, hashlib.sha256()
        request = urllib.request.Request(URL, headers={"User-Agent": "openclaw-profile-layout"})
        with urllib.request.urlopen(request, timeout=60) as response, archive.open("xb") as stream:
            while chunk := response.read(1024 * 1024):
                assert time.monotonic() < deadline, "controller deadline"
                size += len(chunk)
                assert size <= ARCHIVE_SIZE
                digest.update(chunk)
                stream.write(chunk)
        assert size == ARCHIVE_SIZE and digest.hexdigest() == ARCHIVE_SHA, "profile archive mismatch"
        report["archiveVerified"] = True
        binary = root / "profile-data"
        report["step"] = "single-member-extraction"
        report["member"] = extract(archive, binary, deadline)
        report["elf"] = elf_summary(checked([tools["readelf"], "--wide", "--file-header", "--section-headers", "--notes", str(binary)], "elf"))
        for name in TYPES:
            text = checked([tools["llvm-dwarfdump"], "--debug-info", "--name=" + name.split("::")[1],
                            "--show-parents", "--show-children", str(binary)], name)
            assert "file format elf64-x86-64" in text, "unsupported debug dump format"
            report["layouts"][name] = layout(text, name)
        layouts = report["layouts"].values()
        complete = all(not item["namespaceAmbiguous"] and item["reportedAttributesAgree"] and item["attributesSupported"] for item in layouts)
        if complete:
            report["status"] = ("NECESSARY_LAYOUTS_PRESENT" if all(item["necessaryLayoutAvailable"] for item in layouts)
                                else "LAYOUT_UNAVAILABLE")
    except Exception as error:
        # Foreign errors may contain build paths or transport URLs; only their category leaves this job.
        report["errorCategory"] = type(error).__name__
    finally:
        if args.phase == "inspect":
            signal.alarm(0)
        save()
    if report["status"] not in ("METADATA_ADMITTED", "NECESSARY_LAYOUTS_PRESENT", "LAYOUT_UNAVAILABLE"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
