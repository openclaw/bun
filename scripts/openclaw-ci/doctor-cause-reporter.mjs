const PREFIX = "[doctor-causes] ";
// Leave room for the canonical shard owner's line prefix inside the 64KiB limit.
const MAX_BYTES = 64 * 1024 - 512;
const FILE = "src/commands/doctor-maintenance.continuation-scope.test.ts";
const CASES = new Set([
  "keeps Doctor continuation with its repair scope (cached writer: true)",
  "keeps Doctor continuation with its repair scope (cached writer: false)",
]);
let emittedCases = 0;
let reportedOverflow = false;

function errorTree(errors) {
  const seen = new WeakMap();
  let nodes = 0;
  let complete = true;
  const visit = (value, depth = 0, location = "errors") => {
    if (value !== null && typeof value === "object" && seen.has(value)) {
      return { reference: seen.get(value) };
    }
    if (++nodes > 64 || depth > 8) {
      complete = false;
      return "<depth-or-node-limit>";
    }
    if (typeof value === "string") {
      if (value.length > 16384) complete = false;
      return value.slice(0, 16384);
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") {
      complete = false;
      return "<unsupported-error-value>";
    }
    seen.set(value, location);
    if (Array.isArray(value)) {
      if (value.length > 16) complete = false;
      return value.slice(0, 16).map((item, index) => visit(item, depth + 1, `${location}[${index}]`));
    }
    const result = {};
    for (const key of ["name", "message", "stack", "code", "errno", "syscall", "cause", "errors"]) {
      if (value[key] !== undefined) result[key] = visit(value[key], depth + 1, `${location}.${key}`);
    }
    return result;
  };
  const result = visit(errors);
  return { errors: result, complete };
}

export default class DoctorCauseReporter {
  #log;

  #emit(record) {
    let line = PREFIX + JSON.stringify({ version: 1, ...record });
    if (Buffer.byteLength(line + "\n", "utf8") > MAX_BYTES) {
      line = PREFIX + JSON.stringify({ version: 1, kind: "incomplete", reason: "byte-budget" });
    }
    try {
      this.#log?.(line);
    } catch {
      // Missing readiness/case records make the caller's diagnostic inconclusive.
    }
  }

  onInit(ctx) {
    // Keep only the supplied redacting logger, never the Vitest context or tasks.
    try {
      this.#log = ctx.logger.log.bind(ctx.logger);
      this.#emit({
        kind: "ready",
        pid: process.pid,
        node: process.version,
        bun: process.versions.bun ?? null,
        bunRevision: globalThis.Bun?.revision ?? null,
      });
    } catch {
      // Never replace the native test outcome with an observer startup exception.
    }
  }

  onTestCaseResult(testCase) {
    try {
      const file = testCase.module.moduleId.replaceAll("\\", "/");
      if (file !== FILE && !file.endsWith("/" + FILE)) return;
      const fullName = testCase.fullName;
      if (!CASES.has(fullName)) return;
      const result = testCase.result();
      if (result.state !== "failed") return;
      if (emittedCases >= 2) {
        if (!reportedOverflow) {
          reportedOverflow = true;
          this.#emit({ kind: "incomplete", reason: "case-event-limit" });
        }
        return;
      }
      emittedCases++;
      if (!Array.isArray(result.errors) || result.errors.length === 0) {
        this.#emit({ kind: "incomplete", reason: "missing-errors", file: FILE, fullName });
        return;
      }
      this.#emit({ kind: "case", file: FILE, fullName, state: result.state, ...errorTree(result.errors) });
    } catch {
      if (!reportedOverflow) {
        reportedOverflow = true;
        this.#emit({ kind: "incomplete", reason: "observer-error" });
      }
    }
  }
}
