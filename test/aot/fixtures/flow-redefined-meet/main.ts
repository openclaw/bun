import type { Base, Meet } from "./types.ts";
import { left } from "./left.ts";
import { right } from "./right.ts";
import { redefine } from "./redefine.ts";
const value = Bun.parse<Base>('{"a":"x","b":2,"n":0}');
left(value); right(value);
const other: Meet = { a: "x", b: 4, n: 0 };
redefine(other);
console.log(value.n, other.a);
