// Native process listeners are stored unwrapped; materialize the public once wrapper on demand.
export function createOnceWrapper(target, type, listener) {
  var fired = false;
  function onceWrapper() {
    if (fired) return undefined;
    fired = true;
    target.removeListener(type, onceWrapper);
    return listener.$apply(target, arguments);
  }
  onceWrapper.listener = listener;
  return onceWrapper;
}
