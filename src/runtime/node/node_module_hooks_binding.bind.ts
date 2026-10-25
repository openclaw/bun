import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::node::node_module_hooks_binding" });

export const setModuleHooksCounts = b.fn({
  args: { arg0: b.any, arg1: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
export const getBuiltinSpecifierForHooks = b.fn({
  args: { arg0: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
export const getDefaultConditionsForHooks = b.fn({
  args: { arg0: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
export const defaultResolveForHooks = b.fn({
  args: { arg0: b.any, arg1: b.any, arg2: b.any, arg3: b.any, arg4: b.any, arg5: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
export const getPackageTypeForHooks = b.fn({ args: { arg0: b.any }, returns: b.any, capability: "js", throws: true });
