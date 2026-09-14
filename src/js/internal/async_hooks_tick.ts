// Shared init hooks for TickObject and WORKER resources. Keep this array
// identity stable: process.nextTick captures it once. Timer hooks share the
// async ID generator and deferred hook-mutation boundary below.
const tickInitHooks = [];
const allocateAsyncHooksId = $newRustFunction("runtime/timer/Timer.rs", "internal_bindings.new_async_hooks_id", 0);
let hookDispatchDepth = 0;
let pendingTickInitHooks;
let deferredHookMutations;

function mutableTickInitHooks() {
  if (hookDispatchDepth === 0) return tickInitHooks;
  if (pendingTickInitHooks === undefined) {
    pendingTickInitHooks = [];
    for (var i = 0, n = tickInitHooks.length; i < n; i++) $arrayPush(pendingTickInitHooks, tickInitHooks[i]);
  }
  return pendingTickInitHooks;
}

function removeFromArray(array, value) {
  for (var i = 0, n = array.length; i < n; i++) {
    if (array[i] !== value) continue;
    for (var j = i + 1; j < n; j++) array[j - 1] = array[j];
    array.length = n - 1;
    return;
  }
}

export default {
  tickInitHooks,
  addInitHook(hook) {
    $arrayPush(mutableTickInitHooks(), hook);
  },
  removeInitHook(hook) {
    removeFromArray(mutableTickInitHooks(), hook);
  },
  beginHookDispatch() {
    hookDispatchDepth++;
  },
  endHookDispatch() {
    if (--hookDispatchDepth !== 0) return;
    if (pendingTickInitHooks !== undefined) {
      tickInitHooks.length = 0;
      for (var i = 0, n = pendingTickInitHooks.length; i < n; i++) {
        $arrayPush(tickInitHooks, pendingTickInitHooks[i]);
      }
      pendingTickInitHooks = undefined;
    }
    const deferred = deferredHookMutations;
    deferredHookMutations = undefined;
    if (deferred !== undefined) {
      for (var i = 0, n = deferred.length; i < n; i++) deferred[i]();
    }
  },
  hookDispatchActive() {
    return hookDispatchDepth !== 0;
  },
  deferHookMutation(callback) {
    if (hookDispatchDepth === 0) {
      callback();
    } else if (deferredHookMutations === undefined) {
      deferredHookMutations = [callback];
    } else {
      $arrayPush(deferredHookMutations, callback);
    }
  },
  newAsyncId() {
    return allocateAsyncHooksId();
  },
};
