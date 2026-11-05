// A second inline record level must not make Flow narrowing grow every intersection ordering.
type Command =
  | { type: "t0"; input: { nested: { value: number } } }
  | { type: "t1"; input: { nested: { value: number } } }
  | { type: "t2"; input: { nested: { value: number } } }
  | { type: "t3"; input: { nested: { value: number } } }
  | { type: "t4"; input: { nested: { value: number } } }
  | { type: "t5"; input: { nested: { value: number } } };
function work(command: Command): number {
  let score = 0;
  if (command.type !== "t0") score += command.input.nested.value;
  if (command.type !== "t1") score += command.input.nested.value;
  if (command.type !== "t2") score += command.input.nested.value;
  if (command.type !== "t3") score += command.input.nested.value;
  if (command.type !== "t4") score += command.input.nested.value;
  if (command.type !== "t5") score += command.input.nested.value;
  return score;
}
const command: Command = JSON.parse('{"type":"t0","input":{"nested":{"value":1}}}');
console.log(work(command));
