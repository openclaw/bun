#pragma once

#include "BunString.h"
#include <JavaScriptCore/JSCJSValue.h>
#include <JavaScriptCore/ScriptFetchParameters.h>
#include <JavaScriptCore/Strong.h>

namespace JSC {
class JSModuleLoader;
}

namespace Zig {
class GlobalObject;
}

extern "C" bool Bun__hasModuleHooks(void*);
extern "C" bool Bun__moduleHooksNativeURL(void*, const BunString*);
extern "C" bool Bun__moduleHooksShouldIntercept(const BunString*);
extern "C" JSC::EncodedJSValue Bun__getModuleHooksBuiltin(Zig::GlobalObject*, const BunString*);
extern "C" JSC::EncodedJSValue Bun__runModuleResolveHooks(Zig::GlobalObject*, const BunString*, const BunString*, bool, bool, JSC::EncodedJSValue = JSC::JSValue::encode(JSC::jsUndefined()), bool = false);

extern "C" void Bun__discardModuleResolveContext(Zig::GlobalObject*, const BunString*);

namespace Bun {
RefPtr<JSC::ScriptFetchParameters> moduleHooksFetchParameters(Zig::GlobalObject*, const BunString*, RefPtr<JSC::ScriptFetchParameters>);
void validateModuleHooksStaticAttributes(Zig::GlobalObject*, const BunString*);

class ModuleHookFetchScope {
public:
    ModuleHookFetchScope(Zig::GlobalObject*, JSC::JSModuleLoader*, const String&, JSC::ScriptFetchParameters::Type, bool enabled);
    ~ModuleHookFetchScope();
    ModuleHookFetchScope(const ModuleHookFetchScope&) = delete;
    ModuleHookFetchScope& operator=(const ModuleHookFetchScope&) = delete;
    bool isActive() const { return m_globalObject != nullptr; }

    static bool rejectConflict(Zig::GlobalObject*, JSC::JSModuleLoader*, const String&, std::optional<JSC::ScriptFetchParameters::Type>, bool directRequire = false);
    static bool rejectBuiltinOverride(Zig::GlobalObject*, const BunString*, bool isCommonJSRequire);

private:
    static bool rejectConflictImpl(Zig::GlobalObject*, JSC::JSModuleLoader*, const String&, std::optional<JSC::ScriptFetchParameters::Type>, bool, ModuleHookFetchScope*, bool rejectCompleted = false);
    Zig::GlobalObject* m_globalObject;
    JSC::Strong<JSC::JSModuleLoader> m_loader;
    String m_key;
    JSC::ScriptFetchParameters::Type m_type;
    ModuleHookFetchScope* m_previous;
};
}
