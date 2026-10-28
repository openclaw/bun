import { read } from "./reader.ts";
import type { Scope, Preparation } from "./types.ts";
export async function readSharing(
  input: Pick<Scope, "agentId" | "storePath" | "env"> & { sessionKeys: readonly string[] },
  prepareSource: Preparation,
) {
  let physicalSource: { agentId: string; path: string } | undefined;
  const captureSource: Preparation = (source, identity) => {
    physicalSource = source;
    prepareSource(source, identity);
  };
  const request = {
    ...input,
    projection: "full" as const,
    snapshotFields: [],
    includeMembers: true,
    includeAuthorization: true,
  };
  let loaded = await read(request, captureSource);
  if (loaded.entries.length === 0) loaded = await read({ ...request, projection: "sharing" }, captureSource);
  return { ...loaded, physicalSource };
}
