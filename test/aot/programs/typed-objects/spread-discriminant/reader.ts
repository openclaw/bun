import type { Read, Preparation, ReadResult } from "./types.ts";
export async function read(input: Read, prepareSource?: Preparation): Promise<ReadResult> {
  prepareSource?.({ agentId: input.agentId, path: input.storePath }, "identity");
  const keys = input.selection ? [input.selection.sessionId] : input.sessionKeys;
  return { entries: input.projection === "sharing" ? keys.map(sessionKey => ({ sessionKey })) : [] };
}
