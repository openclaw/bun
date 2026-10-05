import assert from "node:assert/strict";
let frame: NodeJS.CallSite;
function capture<T>(..._args: unknown[]) {
  const target: { stack?: NodeJS.CallSite[] } = {};
  const previous = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, frames) => frames;
    Error.captureStackTrace(target, capture);
    frame = target.stack![0];
  } finally {
    Error.prepareStackTrace = previous;
  }
}
const object = { capture };
const cases = [
  [function () {
(object).capture<number>();
  }, 17, 10, "receiver-parentheses"],
  [function () {
(object.capture)<number>();
  }, 20, 25, "callee-parentheses"],
  [function () {
((capture))<number>();
  }, 23, 20, "nested-parentheses"],
  [function () {
(capture as typeof capture)<number>();
  }, 26, 36, "asserted-callee"],
  [function () {
object["capture"]<number>();
  }, 29, 26, "computed-callee"],
  [function () {
object?.["capture"]<number>();
  }, 32, 28, "optional-computed-callee"],
  [function () {
const marker = "🎉"; (capture)<number>();
  }, 35, 39, "astral-prefix"],
  [function () {
(capture); object.capture<number>();
  }, 38, 19, "prior-parenthesized-expression"],
  [function () {
(capture)<<T>() => T>();
  }, 41, 22, "generic-function-type"],
  [function () {
(capture)!();
  }, 44, 11, "non-null-callee"],
  [function () {
(capture)!<number>();
  }, 47, 19, "generic-non-null-callee"],
  [function () {
(capture)!!();
  }, 50, 12, "repeated-non-null-callee"],
  [function () {
(object)!.capture<number>();
  }, 53, 11, "non-null-receiver"],
  [function () {
capture<number>`text`;
  }, 56, 16, "tagged-template"],
 ] as const;
for (const [fn, line, column, label] of cases) {
  fn();
  assert.deepEqual([frame!.getLineNumber(), frame!.getColumnNumber()], [line, column], label);
  assert.deepEqual(/:(\d+):(\d+)\)?$/.exec(frame!.toString())!.slice(1).map(Number), [line, column], label);
}
