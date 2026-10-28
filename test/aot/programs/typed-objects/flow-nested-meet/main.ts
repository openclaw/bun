// Two cross-module guards narrow different nested fields of the same record and retain both aliases.
import type { Base } from "./types.ts";
import { left } from "./left.ts";
import { right } from "./right.ts";
const value: Base = {
  a: "x",
  b: 2,
  n: 0,
  left: { child: { child: { child: { child: { child: { child: 1 } } } } } },
  right: { child: { child: { child: { child: { child: { child: 2 } } } } } },
};
const first = left(value);
const second = right(value);
console.log(
  first === value,
  second === first,
  value.n,
  first.n,
  first.left.child.child.child.child.child.child,
  second.right.child.child.child.child.child.child,
);
