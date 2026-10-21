type A = { kind: "a" | "b" | "c" | "d"; read(): number };
type B = { kind: "a" | "b" | "c"; read(): number };
type C = { kind: "b" | "c" | "d"; read(): number };
let saved: B | undefined;
function make(kind: A["kind"]): A {
  return {
    kind,
    read() {
      return 7;
    },
  };
}
function isB(value: A): value is B {
  return value.kind !== "d";
}
function isC(value: A): value is C {
  return value.kind !== "a";
}
function prepare(value: A) {
  if (isB(value)) saved = value;
}
function execute(value: A) {
  if (isC(value)) {
    const narrowed: C = value;
    if (narrowed !== saved) throw new Error("identity changed");
    console.log(narrowed.kind, narrowed.read());
  }
}
for (const kind of Bun.parse<A["kind"][]>('["b","c"]')) {
  const value = make(kind);
  prepare(value);
  execute(value);
}
