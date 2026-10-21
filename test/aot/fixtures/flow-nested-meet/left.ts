import type { Base, Left } from "./types.ts";
function isLeft(value: Base): value is Left { return Bun.safeValidate<Left>(value).success; }
export function left(value: Base): Left {
  if (!isLeft(value)) throw new Error("left");
  const saved: Left = value;
  saved.n += 1;
  return saved;
}
