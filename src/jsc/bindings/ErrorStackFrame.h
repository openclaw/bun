#include "root.h"
#include "headers-handwritten.h"
#include "JavaScriptCore/BytecodeIndex.h"

namespace Bun {

ZigStackFramePosition getAdjustedPositionForBytecode(JSC::CodeBlock* code, JSC::BytecodeIndex bc, bool isAsync);

ZigStackFramePosition getAdjustedLineColumnForBytecode(JSC::CodeBlock* code, JSC::BytecodeIndex bc, bool isAsync);

} // namespace Bun
