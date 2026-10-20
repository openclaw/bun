import type { Base, View5 } from "./types.ts";
let saved: View5 | undefined;
function isView5(value: Base): value is View5 {
  return value.f5 !== "two";
}
export function narrow5(value: Base): void {
  if (!isView5(value)) throw new Error("not narrowed 5");
  const alias: View5 = value;
  saved = alias;
  alias.value += 5;
}
export function read5(): number {
  if (saved === undefined) throw new Error("missing 5");
  return saved.value;
}
