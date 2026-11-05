export type Scope = {
  agentId: string;
  storePath: string;
  env?: Record<string, string | undefined>;
  preparedSource?: { path: string; assertCurrent: () => void };
};
export type Selection =
  | {
      sessionKeys: readonly string[];
      selection?: never;
      projection?: "full" | "sharing" | "replacement" | "creation" | "list" | "lifecycle" | "exact" | "worktree";
    }
  | {
      sessionKeys?: never;
      selection: { kind: "session-id"; sessionId: string; orderBy?: "updatedAt" };
      projection: "sharing" | "full";
    };
export type Read = Scope &
  Selection & {
    lifecycleSessionKey?: string;
    snapshotFields?: readonly string[];
    projection?: "full" | "sharing" | "list" | "exact" | "worktree";
    includeMembers?: boolean;
    includeParticipantRecords?: boolean;
    includeAuthorization?: boolean;
  };
export type Preparation = (source: { agentId: string; path: string }, identity: string) => void;
export type ReadResult = { entries: { sessionKey: string }[]; sharing?: { source: { agentId: string; path: string } } };
