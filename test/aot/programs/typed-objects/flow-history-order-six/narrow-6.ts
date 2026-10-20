import type { Base, View6 } from "./types.ts";
let saved: View6 | undefined;
function isView6(value: Base): value is View6 {
  return value.f6 !== "two";
}
export function narrow6(value: Base): void {
  if (!isView6(value)) throw new Error("not narrowed 6");
  const alias: View6 = value;
  saved = alias;
  alias.value += 6;
}
export function read6(): number {
  if (saved === undefined) throw new Error("missing 6");
  return saved.value;
}
