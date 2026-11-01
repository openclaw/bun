const { SafeArrayIterator } = require("internal/primordials");

const ArrayIsArray = Array.isArray;
const ArrayPrototypePush = Array.prototype.push;
const ObjectConstructor: (value: unknown) => object = Object;
const ReflectGet: (target: object, key: PropertyKey, receiver?: unknown) => unknown = Reflect.get;

function aggregateTwoErrors(innerError: unknown, outerError: unknown): unknown {
  if (innerError && outerError && innerError !== outerError) {
    const outerErrors = ReflectGet(ObjectConstructor(outerError), "errors", outerError);
    if (ArrayIsArray(outerErrors)) {
      // If `outerError` is already an `AggregateError`.
      ArrayPrototypePush.$call(outerErrors, innerError);
      return outerError;
    }
    const err: Omit<AggregateError, "code"> & { code?: unknown } = new AggregateError(
      new SafeArrayIterator([outerError, innerError]),
      ReflectGet(ObjectConstructor(outerError), "message", outerError),
    );
    err.code = ReflectGet(ObjectConstructor(outerError), "code", outerError);
    return err;
  }
  return innerError || outerError;
}

export default {
  aggregateTwoErrors,
};
