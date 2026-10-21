// Six distinct inline payload declarations must not make Flow narrowing grow every intersection ordering.
// VALIDATED compiles
type Command =
  | { type: "t0"; input: { value: number } }
  | { type: "t1"; input: { value: number } }
  | { type: "t2"; input: { value: number } }
  | { type: "t3"; input: { value: number } }
  | { type: "t4"; input: { value: number } }
  | { type: "t5"; input: { value: number } };
function work(command: Command): number {
  let score = 0;
  if (command.type !== "t0") score += command.input.value;
  if (command.type !== "t1") score += command.input.value;
  if (command.type !== "t2") score += command.input.value;
  if (command.type !== "t3") score += command.input.value;
  if (command.type !== "t4") score += command.input.value;
  if (command.type !== "t5") score += command.input.value;
  return score;
}
const command = Bun.parse<Command>('{"type":"t0","input":{"value":1}}');
console.log(work(command));
