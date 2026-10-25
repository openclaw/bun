import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const revisions = {
  s8: "6aba42d75d4bcee905087fa518cb2df6ff49bb0d",
  s7: "807211511f81e0a6639bc9eb41d67120f6b85316",
};
export const engines = {
  s8: "419b5a0470fc059a610e98697691bf6f7cedd841",
  s7: "a2976f02e69fde8ccc45dc8fb346173f9d63f8a1",
};
export function variantsFor(experiment) {
  assert(["bisect", "async-clear"].includes(experiment));
  return experiment === "bisect" ? [
    { id: "s8-bun-s7-engine", source: revisions.s8, engineRef: revisions.s7, kind: "bisect" },
    { id: "s7-bun-s8-engine", source: revisions.s7, engineRef: revisions.s8, kind: "bisect" },
  ] : [{ id: "async-clear", source: revisions.s8, engineRef: revisions.s8, kind: "async-clear" }];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`matrix=${JSON.stringify({ include: variantsFor(process.argv[2]) })}`);
}
