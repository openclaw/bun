import type { A, C } from "./types.ts";

function isC(command: A): command is C {
  return command.kind !== "a";
}

export function execute(command: A): void {
  if (!isC(command)) throw new Error("execute requires C");
  command.value += 100;
}
