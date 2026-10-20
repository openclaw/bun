import type { Base, View1 } from "./types.ts";
let saved: View1 | undefined;
function isView1(value: Base): value is View1 {
  return value.f1 !== "two";
}
export function narrow1(value: Base): void {
  if (!isView1(value)) throw new Error("not narrowed 1");
  const alias: View1 = value;
  saved = alias;
  alias.value += 1;
}
export function read1(): number {
  if (saved === undefined) throw new Error("missing 1");
  return saved.value;
}
