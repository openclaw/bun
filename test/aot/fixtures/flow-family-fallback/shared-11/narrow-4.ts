import type { Base, View4 } from "./types.ts";
let saved: View4 | undefined;
function isView4(value: Base): value is View4 {
  return value.f4 !== "two";
}
export function narrow4(value: Base): void {
  if (!isView4(value)) throw new Error("not narrowed 4");
  const alias: View4 = value;
  saved = alias;
  alias.value += 4;
}
export function read4(): number {
  if (saved === undefined) throw new Error("missing 4");
  return saved.value;
}
