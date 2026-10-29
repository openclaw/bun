import { readSharing } from "./caller.ts";
import { read } from "./reader.ts";
await read({ agentId: "a", storePath: "s", selection: { kind: "session-id", sessionId: "id" }, projection: "sharing" });
const result = await readSharing(
  JSON.parse('{"agentId":"main","storePath":"synthetic","sessionKeys":["selected"]}'),
  () => {},
);
if (result.entries[0]?.sessionKey !== "selected") throw new Error("wrong entries");
console.log("ok sharing");
