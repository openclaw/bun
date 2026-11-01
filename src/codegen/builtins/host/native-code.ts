import * as b from "bun-builtins-table";
import { timerArgumentsCell, timerCallbackCell } from "./native-cells.ts";

export const handedOver = b.handedOver;
export const objectHandedOver = handedOver;
// While an async context is set, native code keeps a callback inside a wrapper of its own, and a getter that answers what is kept hands out the wrapper: an object that no script has made.
export const mayAnswerWrapperKeptIn = (cell: string) => b.createdIn(b.object, b.nativeCell(cell));

// `_onTimeout` of the timer answers the callback.
export const scheduledTimer = (times: b.CallbackTimes) => ({
  callback: [
    b.storedIn(b.nativeCell(timerCallbackCell)),
    b.called({
      afterwards: "TouchesOnlyWhatRowNames",
      times,
      args: [],
      this: b.result,
      spreadArgs: b.operand("passed"),
      result: "Ignored",
    }),
  ],
  passed: [b.storedIn(b.nativeCell(timerArgumentsCell))],
});

export const immediateTimer = {
  args: { callback: b.callable, passed: b.any.rest },
  returns: b.instance("Immediate").fresh,
  capability: "heap",
  throws: true,
  uses: scheduledTimer("Later"),
  reads: ["ExternalState"],
  writes: ["ExternalState"],
  implementation: b.hostCall,
} satisfies b.FunctionField;
