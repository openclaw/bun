import { nestedNumber } from "./nested.ts";
import type { Base, Left } from "./types.ts";
function isLeft(value: Base): value is Left {
  return typeof value.b === "number" && nestedNumber(value.left, 6);
}
export function left(value: Base): Left {
  if (!isLeft(value)) throw new Error("left");
  const saved: Left = value;
  saved.n += 1;
  return saved;
}
