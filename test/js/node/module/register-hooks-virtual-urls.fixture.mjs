import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
const [namespace, method, behavior] = process.argv.slice(2);
const req = createRequire(import.meta.url);
const events = [];
let loads = 0;
const entry = behavior.startsWith("direct")
  ? namespace + ":entry"
  : behavior === "replace-native-name"
    ? "ws"
    : "w85-entry";
Bun.plugin({
  name: "hook-virtual-url",
  setup(build) {
    build.onResolve({ filter: /^(?:w85-entry|ws)$/ }, () => ({ namespace, path: "payload" }));
    build.onResolve({ namespace, filter: /^entry$/ }, () => ({ namespace, path: "payload" }));
    build.onResolve({ filter: /^\.\/child\.js$/ }, args => {
      assert.equal(args.importer, namespace + ":payload");
      return { namespace, path: "child" };
    });
    build.onResolve({ namespace, filter: /^(?:\.\/)?child(?:\.js)?$/ }, args => {
      if (args.importer) assert.equal(args.importer, namespace + ":payload");
      return { namespace, path: "child" };
    });
    build.onLoad({ namespace, filter: /payload|child/ }, args => {
      loads++;
      return {
        loader: "js",
        contents:
          args.path === "child"
            ? "export default 41;"
            : behavior === "parent"
              ? 'import child from "./child.js"; export default child + 1;'
              : "export default 42;",
      };
    });
  },
});
let hook;
if (behavior !== "no-hooks")
  hook = registerHooks({
    resolve(spec, context, next) {
      if (context.parentURL) new URL(context.parentURL);
      const result = next(spec, context);
      new URL(result.url);
      events.push(["resolve", result.url]);
      if (behavior === "deregister-resolve") hook.deregister();
      return result;
    },
    load(url, context, next) {
      new URL(url);
      events.push(["load", url]);
      if (behavior === "deregister-load") hook.deregister();
      if (behavior === "override") return { format: "module", source: "export default 99;", shortCircuit: true };
      return next(url, context);
    },
  });
try {
  if (behavior === "direct-after-deregister") hook.deregister();
  const spec = behavior === "roundtrip" ? req.resolve(entry) : entry;
  const value = method === "require" ? req(spec).default : (await import(spec)).default;
  assert.equal(value, behavior === "override" ? 99 : 42);
  assert.equal(loads, behavior === "override" ? 0 : behavior === "parent" ? 2 : 1);
  for (const [kind, url] of events)
    if (kind === "load") assert.ok(events.some(([k, u]) => k === "resolve" && u === url));
  console.log(JSON.stringify({ value, loads, events }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, error: error.message, events, loads }));
  process.exitCode = 1;
}
