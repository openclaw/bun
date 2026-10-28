// A session history request keeps its discriminant through asynchronous callbacks, conditional spreads and nested result unions.
type Scope = { agentId: string; sessionId: string; sessionKey: string; storePath: string; env?: { root: string } };
type ReadOptions = { readOnly: boolean };
type RequestParams = {
  "recent-usage": { target: Scope; maxBytes: number };
  "history-event-page": { target: Scope; options: ReadOptions; event?: string };
  "recent-text": { target: Scope; options: ReadOptions; text?: string };
  "active-accounting": { target: Scope; options: ReadOptions; accounting?: string };
  "bounded-tail": { target: Scope; options: ReadOptions; tail?: string };
  "inline-visibility": {
    target: Scope;
    lookup: { kind: "session"; sessionKey: string } | { kind: "run"; runId: string };
  };
  "summary": { target: Scope; query: { summary?: string } };
  "reactions": { target: Scope; reactions?: string };
  "conversation-binding": { target: Scope; conversationRef: string };
  "artifacts": { target: Scope; query: { kind: "image-page" | "other" } };
  "message-page": { target: Scope; options: ReadOptions; page?: string };
  "around-id": { target: Scope; options: ReadOptions; around?: string };
  "source-messages": { target: Scope; options: ReadOptions; source?: string };
  "recent-page": { target: Scope; options: ReadOptions; exactArchivePath?: string };
  "transcript-binding": { target: Scope; binding?: string };
  "rpc": { sessionAgentId: string; sessionId: string; canonicalKey: string; storePath: string; rpc?: string };
  "rpc-message": {
    sessionAgentId: string;
    sessionId: string;
    canonicalKey: string;
    storePath: string;
    messageId: string;
  };
  "message-lookup": { target: Scope; messageId: string };
  "message-by-id": { target: Scope; messageId: string; options?: ReadOptions };
  "message-count": { target: Scope; count?: string };
  "recent": { target: Scope; maxMessages: number; maxLines: number };
  "delta": { target: Scope; limits: { maxBytes: number } };
  "http": { target: Scope; maxChars?: number; limit?: number; cursor?: string };
};
type HistoryRequest = {
  [Kind in keyof RequestParams]: { kind: Kind; params: RequestParams[Kind] };
}[keyof RequestParams];
type ResultValue = { sessionId: string; readOnly: boolean };
type HistoryResult =
  | {
      kind:
        | "recent-usage"
        | "history-event-page"
        | "recent-text"
        | "active-accounting"
        | "bounded-tail"
        | "summary"
        | "reactions"
        | "conversation-binding"
        | "artifacts"
        | "message-page"
        | "around-id"
        | "source-messages"
        | "recent-page"
        | "message-by-id"
        | "rpc-message";
      result: ResultValue;
    }
  | { kind: "transcript-binding"; binding: ResultValue }
  | { kind: "inline-visibility"; subagentCoordination: ResultValue }
  | { kind: "rpc"; page: ResultValue }
  | { kind: "http"; snapshot: ResultValue }
  | { kind: "message-count"; count: number }
  | { kind: "message-lookup" | "recent"; messages: string[] }
  | { kind: "delta"; delta: ResultValue; subagentCoordination: ResultValue };
type ColdResult = { kind: "cold-metadata"; archive: string };
type ForegroundResult = HistoryResult | ColdResult;
type PreparedTarget = {
  transcript: Scope & { sessionFile: string };
  database: { agentId: string; path: string };
  stateDatabase?: { path: string; environment: { root: string } };
  sourceDiscovery?: { agentId: string };
  sourceDatabases?: { primary?: string };
  entryValidationKey?: string;
};
type HistoryInput = {
  kind: "history-page";
  database: { agentId: string; path: string };
  request: HistoryRequest;
  target: Omit<PreparedTarget, "database">;
  admission?: { receipt: string };
};
type ColdInput = {
  kind: "cold-metadata";
  database: { agentId: string; path: string };
  sessionId: string;
  env: { root: string };
};
type Owner = {
  assertCurrent(): void;
  read(input: HistoryInput): Promise<ForegroundResult>;
  readColdMetadata(input: { sessionId: string; env: { root: string } }): Promise<ColdResult>;
};
const owner: Owner = {
  assertCurrent() {},
  async read(input) {
    return { kind: "rpc", page: { sessionId: input.target.transcript.sessionId, readOnly: false } };
  },
  async readColdMetadata(input) {
    return { kind: "cold-metadata", archive: input.sessionId + input.env.root };
  },
};
async function withDatabase<Result>(callback: (owner: Owner) => Promise<Result>): Promise<Result> {
  return callback(owner);
}
async function discover(input: { agentId: string; path: string }): Promise<{ request?: { agentId: string } }> {
  return { request: { agentId: input.agentId } };
}
function readQueued(input: HistoryInput | ColdInput, key: string, owner: Owner): Promise<ForegroundResult> {
  return input.kind === "cold-metadata"
    ? owner.readColdMetadata({ sessionId: input.sessionId, env: input.env })
    : owner.read(input);
}
async function restored(
  read: () => Promise<HistoryResult>,
  options: {
    readOnly: boolean;
    assertCurrent: () => void;
    coldRead: { target: Scope; readMetadata: (phase: "initial" | "restored") => Promise<string> };
  },
): Promise<HistoryResult> {
  options.assertCurrent();
  await options.coldRead.readMetadata("initial");
  return read();
}
class ProjectionError extends Error {
  reason = "rebuilding";
}
class DeltaError extends Error {
  partial = {
    delta: { sessionId: "partial", readOnly: false },
    subagentCoordination: { sessionId: "partial", readOnly: false },
  };
}
async function readSessionHistoryPageInWorker(capturedRequest: HistoryRequest) {
  const scope: Scope =
    capturedRequest.kind === "rpc" || capturedRequest.kind === "rpc-message"
      ? {
          agentId: capturedRequest.params.sessionAgentId,
          sessionId: capturedRequest.params.sessionId,
          sessionKey: capturedRequest.params.canonicalKey,
          storePath: capturedRequest.params.storePath,
        }
      : capturedRequest.params.target;
  const env = scope.env ?? { root: "/synthetic" };
  const preparedTarget = { ...scope };
  const capturedScope = { ...scope, env };
  const currentSource = { agentId: scope.agentId, path: scope.storePath };
  const stateContext = { admission: { databasePath: "/state", assertCurrent() {} }, environment: env };
  const normalizedSessionKey = scope.sessionKey;
  const sessionKey: string | undefined = scope.sessionKey;
  const entryValidationKey: string | undefined = scope.sessionKey;
  const admission: { receipt: string } | undefined = undefined;
  const acquired = await withDatabase(async owner => {
    const sourceReads =
      capturedRequest.kind === "rpc" ||
      capturedRequest.kind === "rpc-message" ||
      capturedRequest.kind === "http" ||
      capturedRequest.kind === "delta" ||
      capturedRequest.kind === "inline-visibility"
        ? await discover(currentSource)
        : undefined;
    const target: Omit<PreparedTarget, "database"> = {
      transcript: {
        agentId: preparedTarget.agentId,
        sessionId: preparedTarget.sessionId,
        ...(normalizedSessionKey ? { sessionKey: normalizedSessionKey } : { sessionKey: "" }),
        storePath: capturedScope.storePath,
        sessionFile: sessionKey ?? preparedTarget.sessionId,
      },
      stateDatabase: { path: stateContext.admission.databasePath, environment: stateContext.environment },
      ...(sourceReads?.request ? { sourceDiscovery: sourceReads.request } : { sourceDatabases: {} }),
      ...(entryValidationKey ? { entryValidationKey } : {}),
    };
    const input: HistoryInput = {
      kind: "history-page",
      database: currentSource,
      request: capturedRequest,
      target,
      ...(admission ? { admission } : {}),
    };
    const key = JSON.stringify(input);
    const metadataInput: ColdInput = {
      kind: "cold-metadata",
      database: currentSource,
      sessionId: preparedTarget.sessionId,
      env,
    };
    const metadataKey = JSON.stringify(metadataInput);
    const assertCurrent = () => {
      stateContext.admission.assertCurrent();
      owner.assertCurrent();
    };
    let result: HistoryResult;
    const exactArchiveRead =
      capturedRequest.kind === "recent-page" && capturedRequest.params.exactArchivePath !== undefined;
    const readOnly =
      capturedRequest.kind === "recent-usage" ||
      capturedRequest.kind === "history-event-page" ||
      capturedRequest.kind === "active-accounting" ||
      capturedRequest.kind === "bounded-tail" ||
      capturedRequest.kind === "recent-text"
        ? true
        : capturedRequest.kind === "artifacts"
          ? capturedRequest.params.query.kind === "image-page"
          : exactArchiveRead
            ? true
            : capturedRequest.kind === "message-page" ||
                capturedRequest.kind === "around-id" ||
                capturedRequest.kind === "source-messages" ||
                capturedRequest.kind === "recent-page"
              ? capturedRequest.params.options.readOnly
              : false;
    let retriedProjection = false;
    const readPage = () => readQueued(input, key, owner);
    try {
      if (exactArchiveRead) {
        const page = await readPage();
        if (page.kind === "cold-metadata") throw new Error("wrong page");
        result = page;
      } else {
        result = await restored(
          async () => {
            let page: ForegroundResult;
            try {
              page = await readPage();
            } catch (error) {
              if (
                (capturedRequest.kind === "active-accounting" ||
                  capturedRequest.kind === "recent-text" ||
                  (capturedRequest.kind === "bounded-tail" && !capturedRequest.params.options.readOnly)) &&
                error instanceof ProjectionError
              )
                owner.assertCurrent();
              if (readOnly || retriedProjection || !(error instanceof ProjectionError) || error.reason !== "rebuilding")
                throw error;
              retriedProjection = true;
              await discover(currentSource);
              page = await readPage();
            }
            if (page.kind === "cold-metadata") throw new Error("wrong page");
            return page;
          },
          {
            readOnly,
            assertCurrent,
            coldRead: {
              target: preparedTarget,
              readMetadata: async phase => {
                const metadata =
                  phase === "initial"
                    ? await readQueued(metadataInput, metadataKey, owner)
                    : await owner.readColdMetadata({ sessionId: metadataInput.sessionId, env });
                if (metadata.kind !== "cold-metadata") throw new Error("wrong metadata");
                return metadata.archive;
              },
            },
          },
        );
      }
    } catch (error) {
      if (error instanceof DeltaError && capturedRequest.kind === "delta") result = { kind: "delta", ...error.partial };
      else throw error;
    }
    return { result, assertCurrent };
  });
  const { assertCurrent, result } = acquired;
  assertCurrent();
  if (result.kind !== capturedRequest.kind) throw new Error("wrong result kind");
  if (result.kind === "transcript-binding") return result.binding;
  if ("result" in result) return result.result;
  if (result.kind === "delta") return { ...result, assertCurrent };
  if (result.kind === "inline-visibility") return { subagentCoordination: result.subagentCoordination, assertCurrent };
  return result.kind === "rpc"
    ? result.page
    : result.kind === "http"
      ? result.snapshot
      : result.kind === "message-count"
        ? result.count
        : result.messages;
}
const request: HistoryRequest = JSON.parse(
  '{"kind":"rpc","params":{"sessionAgentId":"agent","sessionId":"session","canonicalKey":"key","storePath":"/synthetic"}}',
);
console.log(JSON.stringify(await readSessionHistoryPageInWorker(request)));
