import type { Base, View10 } from "./types.ts";
let saved: View10 | undefined;
function isView10(value: Base): value is View10 {
  return value.f10 !== "two";
}
export function narrow10(value: Base): void {
  if (!isView10(value)) throw new Error("not narrowed 10");
  const alias: View10 = value;
  saved = alias;
  alias.value += 10;
}
export function read10(): number {
  if (saved === undefined) throw new Error("missing 10");
  return saved.value;
}
