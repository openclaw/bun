import type { Base } from "./types.ts";
import { left } from "./left.ts";
import { right } from "./right.ts";
const value = Bun.parse<Base>('{"payload":{"shared":"ok","f64":1},"value":0}');
left(value); right(value); console.log(value.value);
