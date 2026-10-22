type A = { kind: "a" | "b" | "c" | "d"; familyBrand: "family"; familyRead(): number };
type B = { kind: "a" | "b" | "c"; familyBrand: "family"; familyRead(): number };
type C = { kind: "b" | "c" | "d"; familyBrand: "family"; familyRead(): number };
let saved: B | undefined;
function make(kind: A["kind"]): A {
  return { kind, familyBrand: "family", familyRead() { return 7; } };
}
function isB(value: A): value is B { return value.kind !== "d"; }
function isC(value: A): value is C { return value.kind !== "a"; }
function prepare(value: A) { if (isB(value)) saved = value; }
function execute(value: A): string {
  if (isC(value)) {
    const narrowed: C = value;
    if (narrowed !== saved) throw new Error("family identity changed");
    return `${narrowed.kind}:${narrowed.familyRead()}`;
  }
  throw new Error("unexpected family kind");
}
export function runFamily(): string {
  const results: string[] = [];
  for (const kind of Bun.parse<A["kind"][]>('["b","c"]')) {
    const value = make(kind);
    prepare(value);
    results.push(execute(value));
  }
  return results.join(",");
}
