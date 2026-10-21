import type { Base, View8 } from "./types.ts";
let saved: View8 | undefined;
function isView8(value: Base): value is View8 {
  return value.f8 !== "two";
}
export function narrow8(value: Base): void {
  if (!isView8(value)) throw new Error("not narrowed 8");
  const alias: View8 = value;
  saved = alias;
  alias.value += 8;
}
export function read8(): number {
  if (saved === undefined) throw new Error("missing 8");
  return saved.value;
}
