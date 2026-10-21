import { execute } from "./execute.ts";
import { prepare, preparedObject, preparedValue } from "./prepare.ts";
import type { A } from "./types.ts";

const rows: string[] = [];
for (const text of ['{"kind":"b","value":1}', '{"kind":"c","value":1}']) {
  const command = Bun.parse<A>(text);
  prepare(command);
  execute(command);
  if (command !== preparedObject()) throw new Error("identity changed");
  const value = preparedValue();
  if (value !== command.kind + ":111") throw new Error("old alias lost updates");
  rows.push(value);
}
console.log(rows.join(","));
