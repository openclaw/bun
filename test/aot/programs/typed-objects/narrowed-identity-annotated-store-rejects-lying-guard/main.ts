// A lying predicate cannot admit an object to an annotated store or allow its later write.
type Payload = { id: string; state: { count: number; label: string } };
type A = { type: "a" | "b" | "c" | "d" | "e" | "f"; payload: Payload };
type B = { type: "a" | "b" | "c"; payload: Payload };
type C = { type: "b" | "c" | "d"; payload: Payload };
function isB(value: A): value is B {
  return value.type === "a" || value.type === "b" || value.type === "c";
}
function liesAboutC(_value: A): _value is C { return true; }
function write(value: A): void {
  const original = value;
  let savedB: B;
  let savedC: C;
  if (!isB(value)) throw new Error("not B");
  savedB = value;
  if (!liesAboutC(original)) throw new Error("not C");
  savedC = original;
  savedC.payload.state.count += 100;
  if (!Object.is(savedB, original)) throw new Error("identity changed");
}
const value = Bun.parse<A>('{"type":"a","payload":{"id":"shared","state":{"count":0,"label":"fresh"}}}');
let rejected = false;
try { write(value); } catch (error) {
  if (!(error instanceof TypeError)) throw error;
  rejected = true;
}
if (!rejected || value.payload.state.count !== 0) throw new Error("invalid narrowed store admitted");
console.log("rejected:a:0");
