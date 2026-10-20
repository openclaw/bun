import type { Base, Left } from "./types.ts";
export function isLeft(value: Base): value is Left { return Bun.safeValidate<Left>(value).success; }
export function left(value: Base): void { if (!isLeft(value)) throw new Error("left"); const saved: Left = value; saved.value += 1; }
