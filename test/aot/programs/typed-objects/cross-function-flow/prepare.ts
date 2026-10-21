import type { A, B } from "./types.ts";

let saved: B | undefined;

function isB(command: A): command is B {
  return command.kind !== "d";
}

export function prepare(command: A): void {
  if (!isB(command)) throw new Error("prepare requires B");
  saved = command;
  command.value += 10;
}

export function preparedObject(): object {
  if (!saved) throw new Error("nothing prepared");
  return saved;
}

export function preparedValue(): string {
  if (!saved) throw new Error("nothing prepared");
  return saved.kind + ":" + saved.value;
}
