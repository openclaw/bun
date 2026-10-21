// Crossing Flow views retain a missing numeric field check at the consumed field.
type Left = { kind: "both" | "left"; input: { left: number } };
type Right = { kind: "both" | "right"; input: { right: number } };
function isRight(value: unknown): value is Right { return (value as { kind: unknown }).kind === "both"; }
function sum(value: Left): number {
  if (isRight(value)) return value.input.left + value.input.right;
  return value.input.left;
}
console.log("valid", sum(Bun.parse<Left & Right>('{"kind":"both","input":{"left":7,"right":2}}')));
try { console.log("missing", sum(Bun.parse<Left>('{"kind":"both","input":{"left":7}}'))); }
catch (error) { console.log("missing", error instanceof TypeError ? "TypeError" : "unexpected " + String(error)); }
