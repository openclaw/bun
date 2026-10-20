import { execute } from "./execute.ts";
import { prepare, preparedObject, preparedValue } from "./prepare.ts";
import type { A } from "./types.ts";

const command = Bun.parse<A>('{"kind":"a","value":1}');
prepare(command);
let rejected = false;
try {
  execute(command);
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
  rejected = true;
}
if (!rejected) throw new Error("lying guard admitted nonintersection tag");
if (command !== preparedObject()) throw new Error("identity changed");
if (command.value !== 11 || preparedValue() !== "a:11") throw new Error("C-side write escaped failed Flow");
console.log("rejected:" + preparedValue());
