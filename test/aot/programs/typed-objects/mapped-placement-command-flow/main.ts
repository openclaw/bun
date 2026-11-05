// A mapped command union passes through narrowed spreads without losing its discriminant or nested owner fields.
type Owner =
  | { kind: "local"; environmentId?: string; ownerEpoch?: number }
  | { kind: "worker"; environmentId: string; ownerEpoch: number };
type ClaimInput = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
  claimId: string;
  runId: string;
  owner: Owner;
};
type Claim = {
  sessionId: string;
  claimId: string;
  runId: string;
  placementGeneration: number;
  owner: Owner;
};
type EntrySource = { sessionId?: string };
type Claimed = { claim: Claim; nowMs?: number; sessionEntryCurrentSource?: EntrySource };
type Pending = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  claimId: string;
  runId: string;
  gatewayInstanceId: string;
  recoveryRequestedAtMs: number | null;
  workspaceAcceptedAtMs: number | null;
  stagedResultRef: string | null;
  repositoryWorkspaceId?: string;
};
type Inputs = {
  "placementTurns.transition": {
    sessionId: string;
    from: string;
    to: string;
    expectedGeneration: number;
    nowMs?: number;
  };
  "placementTurns.startDrain": {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    expectedGeneration: number;
    workspaceBaseManifestRef?: string;
    nowMs?: number;
  };
  "placementTurns.startReconcile": {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    expectedGeneration: number;
    forceLocalClaim?: true;
    nowMs?: number;
  };
  "placementTurns.fail": { sessionId: string; expectedGeneration: number; recoveryError: string; nowMs?: number };
  "placementTurns.failResult": { pending: Pending; recoveryError: string; nowMs?: number };
  "placementTurns.claimReclaimResult": { claim: ClaimInput; gatewayInstanceId: string; nowMs?: number };
  "placementTurns.claimMutationResult": {
    claim: ClaimInput;
    gatewayInstanceId: string;
    nowMs?: number;
    sessionEntryCurrentSource?: EntrySource;
  };
  "placementTurns.markResultPending": Claimed & { gatewayInstanceId: string };
  "placementTurns.acceptResult": Claimed;
  "placementTurns.handoffResult": Claimed & { gatewayInstanceId: string };
  "placementTurns.abandonResult": { pending: Pending };
  "placementTurns.drainResult": Claimed;
  "placementTurns.completeResult": Claimed;
  "placementTurns.cancelResult": Claimed & { gatewayInstanceId: string; reason?: "node-disconnect" };
  "placementTurns.updateAckCursors": {
    claim: Claim;
    transcript?: number;
    liveEvent?: number;
    gatewayInstanceId: string;
    nowMs?: number;
  };
  "placementTurns.claim": { claim: ClaimInput; nowMs?: number };
  "placementTurns.updateWorkspaceBaseManifest": Claimed & { manifestRef: string };
  "placementTurns.recordStagedResult": Claimed & { stagedResultRef: string; repositoryWorkspaceId?: string };
  "placementTurns.recoverWorkspace": Claimed & { gatewayInstanceId: string };
  "placementTurns.handoffRuntimeRefreshResult": Claimed & {
    expectedGeneration: number;
    gatewayInstanceId: string;
    nowMs: number;
  };
  "placementTurns.releaseIfOwned": Claimed;
  "placementTurns.release": Claimed;
};
type Operations = { [Key in keyof Inputs]: { input: Inputs[Key]; output: void } };
type SqliteWorkerCommand<Ops extends Record<string, { input: unknown; output: unknown }>> = {
  [Key in keyof Ops]: { type: Key; input: Ops[Key]["input"] };
}[keyof Ops];
function prepareWorkerTurnClaimClosed(_path: string, claim: Claim): string {
  return claim.claimId;
}
async function execute(
  input: SqliteWorkerCommand<Operations>,
  capturedEntryCheck?: { source: EntrySource },
): Promise<string> {
  const runtime = { path: "synthetic" };
  const command = { ...input };
  const localTurn =
    (command.type === "placementTurns.claim" ||
      command.type === "placementTurns.release" ||
      command.type === "placementTurns.releaseIfOwned") &&
    command.input.claim.owner.kind === "local" &&
    command.input.claim.owner.environmentId === undefined;
  const sessionId =
    "claim" in input.input
      ? input.input.claim.sessionId
      : "pending" in input.input
        ? input.input.pending.sessionId
        : input.input.sessionId;
  if ("claim" in command.input) {
    const { claimId, runId, owner: requestedOwner } = command.input.claim;
    const { kind, environmentId, ownerEpoch } = requestedOwner;
    const owner: typeof requestedOwner =
      kind === "local" ? { kind, environmentId, ownerEpoch } : { kind, environmentId, ownerEpoch };
    // Host callers may carry authority callbacks; only claim data crosses the worker boundary.
    const claim = { sessionId, claimId, runId, owner };
    if (
      command.type === "placementTurns.claim" ||
      command.type === "placementTurns.claimReclaimResult" ||
      command.type === "placementTurns.claimMutationResult"
    ) {
      const { agentId, sessionKey } = command.input.claim;
      command.input = { ...command.input, claim: { ...claim, agentId, sessionKey } };
    } else {
      const { placementGeneration } = command.input.claim;
      command.input = { ...command.input, claim: { ...claim, placementGeneration } };
    }
  } else {
    command.input = structuredClone(command.input);
  }
  if (
    command.type === "placementTurns.recordStagedResult" ||
    command.type === "placementTurns.updateWorkspaceBaseManifest" ||
    command.type === "placementTurns.claimMutationResult" ||
    command.type === "placementTurns.acceptResult" ||
    command.type === "placementTurns.completeResult"
  ) {
    command.input = { ...command.input, sessionEntryCurrentSource: capturedEntryCheck?.source };
  }
  let close =
    command.type === "placementTurns.release" ||
    command.type === "placementTurns.releaseIfOwned" ||
    command.type === "placementTurns.completeResult" ||
    command.type === "placementTurns.cancelResult"
      ? prepareWorkerTurnClaimClosed(runtime.path, command.input.claim)
      : undefined;
  const finalId = "claim" in command.input ? command.input.claim.claimId : sessionId;
  return `${localTurn} ${sessionId} ${finalId} ${close !== undefined}`;
}
const input: SqliteWorkerCommand<Operations> = JSON.parse(
  '{"type":"placementTurns.claim","input":{"claim":{"sessionId":"s","agentId":"a","sessionKey":"k","claimId":"c","runId":"r","owner":{"kind":"local"}}}}',
);
console.log(await execute(input));
