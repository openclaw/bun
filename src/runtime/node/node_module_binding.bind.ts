import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::node::node_module_binding" });

export const stripTypeScriptTypesNative = b.fn({
  args: { code: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
