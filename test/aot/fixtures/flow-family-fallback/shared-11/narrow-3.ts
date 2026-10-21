import type { Base, View3 } from "./types.ts";
let saved: View3 | undefined;
function isView3(value: Base): value is View3 {
  return value.f3 !== "two";
}
export function narrow3(value: Base): void {
  if (!isView3(value)) throw new Error("not narrowed 3");
  const alias: View3 = value;
  saved = alias;
  alias.value += 3;
}
export function read3(): number {
  if (saved === undefined) throw new Error("missing 3");
  return saved.value;
}
