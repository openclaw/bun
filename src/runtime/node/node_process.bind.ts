import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::node::process" });

export const getActiveResourcesInfo = b.fn({
  export: "Bun__Process__getActiveResourcesInfo",
  returns: b.any,
  capability: "js",
  throws: true,
});
