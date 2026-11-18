import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";

type Message = {
  workerPreparation: {
    prepareMentionInvitation(): { assertCurrent(): void };
  };
};

function observePhases() {
  let current: { [Symbol.dispose](): void } | undefined;
  return {
    mark() {
      current?.[Symbol.dispose]();
      current = undefined;
    },
    [Symbol.dispose]() {
      current?.[Symbol.dispose]();
      current = undefined;
    },
  };
}

async function runOperation(params: {
  run(prepare: () => Promise<void>, commit: () => Promise<void>): Promise<void>;
  assertCurrent(): void;
  onAcknowledged(): void;
  onCommitted(): Promise<void>;
}) {
  return params.run(
    async () => {},
    async () => {
      const outcome = await Promise.resolve().then(
        () => {
          params.assertCurrent();
          return { ok: true as const };
        },
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!outcome.ok) {
        throw outcome.error;
      }
      params.onAcknowledged();
      return await params.onCommitted();
    },
  );
}

// Keep the nested async/using/settlement shape, without database or publication owners.
async function persistTurn(options: { messages: Message[]; beforeCommit(): void }) {
  const mentionCommitGuards: Array<() => void> = [];
  const committedCompletions: Promise<void>[] = [];
  const outcome = await (async () => {
    const operation = {
      async run(prepare: () => Promise<void>, commit: () => Promise<void>) {
        using phase = observePhases();
        await prepare();
        for (const message of options.messages) {
          const prepared = message.workerPreparation.prepareMentionInvitation();
          mentionCommitGuards.push(prepared.assertCurrent);
        }
        phase.mark();
        return await commit();
      },
      assertCurrent() {
        options.beforeCommit();
        for (const guard of mentionCommitGuards) {
          guard();
        }
      },
      onAcknowledged() {
        if (options.messages.length !== 1) {
          throw new Error("Invalid reduced turn");
        }
      },
      async onCommitted() {},
    };
    const run = () => runOperation({ ...operation });
    return await run();
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  using settlementPhase = observePhases();
  await Promise.allSettled(committedCompletions);
  settlementPhase.mark();
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

for (const outcome of ["commit", "rollback"] as const) {
  it(`releases reduced invitation callbacks after ${outcome}`, async () => {
    let current = true;
    let prepared = 0;
    const failure = new Error("Invitation authority changed");
    async function settle() {
      const captured = { sentinel: "synthetic invitation callback" };
      const reference = new WeakRef(captured);
      const write = persistTurn({
        messages: [
          {
            workerPreparation: {
              prepareMentionInvitation: () => {
                prepared++;
                return {
                  assertCurrent() {
                    expect(captured.sentinel).toBe("synthetic invitation callback");
                    if (!current) {
                      throw failure;
                    }
                  },
                };
              },
            },
          },
        ],
        beforeCommit() {
          if (outcome === "rollback") {
            current = false;
          }
        },
      });
      if (outcome === "rollback") {
        await expect(write).rejects.toBe(failure);
      } else {
        await write;
      }
      return reference;
    }
    const reference = await settle();
    expect(prepared).toBe(1);
    const control = new WeakRef({});
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(reference.deref()).toBeUndefined();
  });
}
