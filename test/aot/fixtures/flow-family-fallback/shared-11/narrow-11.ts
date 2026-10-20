import type { Base, View11 } from "./types.ts";
let saved: View11 | undefined;
function isView11(value: Base): value is View11 {
  return value.f11 !== "two";
}
export function narrow11(value: Base): void {
  if (!isView11(value)) throw new Error("not narrowed 11");
  const alias: View11 = value;
  saved = alias;
  alias.value += 11;
}
export function read11(): number {
  if (saved === undefined) throw new Error("missing 11");
  return saved.value;
}
