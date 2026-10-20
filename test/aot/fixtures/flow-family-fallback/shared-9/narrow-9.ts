import type { Base, View9 } from "./types.ts";
let saved: View9 | undefined;
function isView9(value: Base): value is View9 {
  return value.f9 !== "two";
}
export function narrow9(value: Base): void {
  if (!isView9(value)) throw new Error("not narrowed 9");
  const alias: View9 = value;
  saved = alias;
  alias.value += 9;
}
export function read9(): number {
  if (saved === undefined) throw new Error("missing 9");
  return saved.value;
}
