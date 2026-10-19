// Typed JSON records retain their identity while narrowing across overlapping literal sets.
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage<boolean>();
type Bindings = { id: string };
type Command =
  | { type: "session.nativeBindings.delete"; input: unknown }
  | { type: "session.messageCut.commit"; input: unknown }
  | { type: "session.entries.replace"; input: unknown }
  | { type: "session.lifecycle.delete"; input: unknown }
  | { type: "session.maintenance.prepare"; input: unknown }
  | { type: "session.maintenance.metadata"; input: unknown }
  | { type: "authProfiles.read"; input: unknown }
  | { type: "conversation.authority"; input: unknown };
type Wide = { type: Command["type"]; input: unknown };
function record(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null; }
function isBinding(x: unknown): x is Bindings { return record(x) && typeof x.id === "string"; }
function binding(x: unknown): Bindings | undefined { return isBinding(x) ? x : undefined; }
function native(x: unknown): Bindings | undefined { return record(x) ? binding(x.nativeBindings) : undefined; }
function transcript(x: unknown): boolean { return record(x) && record(x.initializeTranscript) && typeof x.initializeTranscript.sessionKey === "string"; }
const seen: string[] = [];
let received: unknown;
const registry = { prepare(type: Command["type"]) { seen.push(type); return Promise.resolve(); } };
const backend: { prepare(command: Command): void | Promise<void> } = { prepare(command) {
  if (!storage.getStore()) throw new Error("missing context");
  const preparing = registry.prepare(command.type);
  const nativeBindings = command.type === "session.nativeBindings.delete" ? binding(command.input) :
    command.type === "session.messageCut.commit" ? native(command.input) :
    command.type === "session.entries.replace" || command.type === "session.lifecycle.delete" ? native(command.input) : undefined;
  if (nativeBindings) { received = command; return Promise.all([preparing, Promise.resolve()]).then(() => {}); }
  if (command.type === "session.maintenance.prepare" || command.type === "session.maintenance.metadata") {
    received = command; seen.push("maintenance"); return Promise.all([preparing, Promise.resolve()]).then(() => {});
  }
  if (command.type === "session.entries.replace" && transcript(command.input)) {
    received = command; seen.push("transcript"); return Promise.all([preparing, Promise.resolve()]).then(() => {});
  }
  received = command; return preparing;
} };
const commands: Command[] = [
  { type: "session.nativeBindings.delete", input: { id: "x" } }, { type: "session.messageCut.commit", input: {} },
  { type: "session.entries.replace", input: {} }, { type: "session.lifecycle.delete", input: {} },
  { type: "session.maintenance.prepare", input: { id: "x" } }, { type: "session.maintenance.metadata", input: undefined },
  { type: "authProfiles.read", input: undefined }, { type: "conversation.authority", input: { id: "x" } },
];
function isCommand(value: Wide): value is Command { return commands.some(command => command.type === value.type); }
let rejected = false;
try { Bun.parse<Wide>(' { "type": "outside", "input": {} } '); } catch (error) { rejected = error instanceof TypeError; }
if (!rejected) throw new Error("invalid discriminator accepted");
await storage.run(true, async () => {
  for (let round = 0; round < 3; round++) for (const command of commands) {
    seen.length = 0;
    const broad = Bun.parse<Wide>(JSON.stringify(command));
    if (!isCommand(broad)) throw new Error("invalid fixture");
    await backend.prepare(broad);
    if (received !== broad) throw new Error("narrowing copied the command");
    console.log(command.type, seen.join(","));
  }
});
