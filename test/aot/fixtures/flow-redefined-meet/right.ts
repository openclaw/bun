import type { Base, Right } from "./types.ts";
function isRight(value: Base): value is Right { return value.a === "x"; }
export function right(value: Base): void { if (!isRight(value)) throw new Error("right"); const saved: Right = value; saved.n += 2; }
