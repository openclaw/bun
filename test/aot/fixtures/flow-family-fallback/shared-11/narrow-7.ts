import type { Base, View7 } from "./types.ts";
let saved: View7 | undefined;
function isView7(value: Base): value is View7 {
  return value.f7 !== "two";
}
export function narrow7(value: Base): void {
  if (!isView7(value)) throw new Error("not narrowed 7");
  const alias: View7 = value;
  saved = alias;
  alias.value += 7;
}
export function read7(): number {
  if (saved === undefined) throw new Error("missing 7");
  return saved.value;
}
