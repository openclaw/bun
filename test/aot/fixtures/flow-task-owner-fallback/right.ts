import type { Base, Right } from "./types.ts";
export function isRight(value: Base): value is Right { return Bun.safeValidate<Right>(value).success; }
export function right(value: Base): void { if (!isRight(value)) throw new Error("right"); const saved: Right = value; saved.value += 2; }
