import { execFileSync } from "node:child_process";

export const acceptancePolicyPath = "scripts/openclaw-release/consumer-acceptance.json";

export function releaseAcceptance(source, commit, input = "", event = "", publish = false) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Acceptance policy requires a full source commit");
  if (input && !/^[a-f0-9]{40}$/.test(input)) throw new Error("acceptance_ref must be a full immutable commit");
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  if (!git("ls-tree", "--name-only", commit, "--", acceptancePolicyPath))
    return { ref: input, required: false, build: true };
  const policy = JSON.parse(git("show", commit + ":" + acceptancePolicyPath));
  if (!/^[a-f0-9]{40}$/.test(policy.consumerCommit)) throw new Error("Invalid committed consumer acceptance policy");
  if (input && input !== policy.consumerCommit)
    throw new Error("acceptance_ref disagrees with the released source policy");
  // The normal tag push owns publication; a competing dispatch must fail before any build.
  if (publish && event !== "push")
    throw new Error("This source requires tag-push publication; do not dispatch a second release build");
  // The normal PR build/test workflow supplies native implementation evidence.
  // Reserve this task's full release fleet for its approved tag publication.
  return { ref: policy.consumerCommit, required: true, build: event !== "pull_request" };
}
