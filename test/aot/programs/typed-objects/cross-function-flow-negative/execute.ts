import type { A, C } from "./types.ts";

function liesAboutC(_command: A): _command is C {
  return true;
}

export function execute(command: A): void {
  if (liesAboutC(command)) command.value += 100;
}
