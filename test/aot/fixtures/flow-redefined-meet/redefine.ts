import type { Meet } from "./types.ts";
export function redefine(value: Meet): void { Object.defineProperty(value, "a", { configurable: true, get() { return "x"; } }); }
