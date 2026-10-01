// Native process listeners are stored unwrapped; materialize the public once wrapper on demand.
export function createOnceWrapper(target, type, listener, fired) {
  function onceWrapper() {
    if (fired) return undefined;
    fired = true;
    target.removeListener(type, onceWrapper);
    return listener.$apply(target, arguments);
  }
  return onceWrapper;
}
