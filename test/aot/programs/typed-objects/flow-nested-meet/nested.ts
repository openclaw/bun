export function nestedNumber(value: unknown, depth: number): boolean {
  if (depth === 0) return typeof value === "number";
  return typeof value === "object" && value !== null && "child" in value && nestedNumber(value.child, depth - 1);
}
