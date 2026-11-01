import json, lldb, re
from pathlib import Path
target = lldb.debugger.GetSelectedTarget()
assert target.IsValid(), "missing diagnostic target"
module = target.FindModule(target.GetExecutable())
assert module.IsValid(), "missing executable module"
uuid = re.sub("[^0-9a-fA-F]", "", module.GetUUIDString() or "").lower()
expected = re.findall(r"Build ID: (\w+)", Path("/work/diagnostics/bun-build-id.txt").read_text())
assert len(expected) == 1 and uuid == expected[0], "LLDB module identity mismatch"
types = {}
for name in ("JSC::JSCell", "JSC::Heap", "JSC::SlotVisitor", "JSC::ConservativeRoots"):
    candidates = target.FindTypes(name)
    complete = []
    for i in range(candidates.GetSize()):
        value = candidates.GetTypeAtIndex(i).GetCanonicalType()
        fields = value.GetNumberOfFields()
        if value.IsTypeComplete() and value.GetByteSize() > 0 and fields > 0:
            layout = [{"name": value.GetFieldAtIndex(j).GetName(), "offset_bits": value.GetFieldAtIndex(j).GetOffsetInBits()} for j in range(fields)]
            complete.append({"bytes": value.GetByteSize(), "fields": fields, "layout": layout})
    assert complete, "incomplete type: " + name
    types[name] = complete
functions = {}
for name in ("JSC::Collector::runEndPhase", "JSC::MachineThreads::gatherConservativeRoots"):
    contexts = module.FindFunctions(name, lldb.eFunctionNameTypeAny)
    functions[name] = []
    for i in range(contexts.GetSize()):
        context = contexts.GetContextAtIndex(i)
        function = context.GetFunction()
        unit = context.GetCompileUnit()
        if not function.IsValid() or not unit.IsValid():
            continue
        address = function.GetStartAddress().GetFileAddress()
        if address not in (0, lldb.LLDB_INVALID_ADDRESS):
            functions[name].append({"address": address, "name": function.GetName(), "compile_unit": str(unit.GetFileSpec())})
    assert functions[name], "missing debug function: " + name
Path("/work/diagnostics/symbol-capability.json").write_text(json.dumps({"module_uuid": uuid, "types": types, "functions": functions}, indent=2) + "\n")
