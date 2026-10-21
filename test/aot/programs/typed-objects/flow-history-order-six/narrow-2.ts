import type { Base, View2 } from "./types.ts";
let saved: View2 | undefined;
function isView2(value: Base): value is View2 {
  return value.f2 !== "two";
}
export function narrow2(value: Base): void {
  if (!isView2(value)) throw new Error("not narrowed 2");
  const alias: View2 = value;
  saved = alias;
  alias.value += 2;
}
export function read2(): number {
  if (saved === undefined) throw new Error("missing 2");
  return saved.value;
}
