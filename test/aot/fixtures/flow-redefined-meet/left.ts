import type { Base, Left } from "./types.ts";
function isLeft(value: Base): value is Left { return typeof value.b === "number"; }
export function left(value: Base): void { if (!isLeft(value)) throw new Error("left"); const saved: Left = value; saved.n += 1; }
