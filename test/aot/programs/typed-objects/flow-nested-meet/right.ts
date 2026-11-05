import { nestedNumber } from "./nested.ts";
import type { Base, Right } from "./types.ts";
function isRight(value: Base): value is Right {
  return value.a === "x" && nestedNumber(value.right, 6);
}
export function right(value: Base): Right {
  if (!isRight(value)) throw new Error("right");
  const saved: Right = value;
  saved.n += 2;
  return saved;
}
