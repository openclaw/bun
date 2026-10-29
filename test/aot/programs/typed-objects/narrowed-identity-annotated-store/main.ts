// Annotated stores retain both tested views of the same object and its nested state.
type Payload = { id: string; state: { count: number; label: string } };
type A = { type: "a" | "b" | "c" | "d" | "e" | "f"; payload: Payload };
type B = { type: "a" | "b" | "c"; payload: Payload };
type C = { type: "b" | "c" | "d"; payload: Payload };
function isB(value: A): value is B {
  return value.type === "a" || value.type === "b" || value.type === "c";
}
function isC(value: A): value is C {
  return value.type === "b" || value.type === "c" || value.type === "d";
}
function exercise(value: A, reverse: boolean): string {
  const original = value;
  const state = value.payload.state;
  let savedB: B;
  let savedC: C;
  if (reverse) {
    if (!isC(value)) return "outside";
    savedC = value;
    if (!isB(original)) return "outside";
    savedB = original;
  } else {
    if (!isB(value)) return "outside";
    savedB = value;
    if (!isC(original)) return "outside";
    savedC = original;
  }
  if (savedB !== original || savedC !== original) throw new Error("identity changed");
  savedB.payload.state.count += 1;
  savedC.payload.state.count += 1;
  if (state.count !== 2 || original.payload.state !== state) throw new Error("alias lost write");
  return `${original.type}:${state.count}`;
}
for (const reverse of [false, true]) {
  for (const type of ["b", "c"]) {
    const value: A = JSON.parse(
      JSON.stringify({ type, payload: { id: "shared", state: { count: 0, label: "fresh" } } }),
    );
    console.log(reverse ? "C-B" : "B-C", exercise(value, reverse));
  }
}
