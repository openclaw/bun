import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [specifier, method, installed, behavior, inputRoot] = process.argv.slice(2);
const root = fs.realpathSync(inputRoot);
const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const subpath = specifier.slice(packageName.length);
const put = (name, contents) => {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
  return pathToFileURL(filename).href;
};
const targets = {
  require: put(
    `node_modules/${packageName}/entry.cjs`,
    "globalThis.w85FixtureExecuted = true; module.exports = { fixture: true };",
  ),
  import: put(
    `node_modules/${packageName}/entry.mjs`,
    "globalThis.w85FixtureExecuted = true; export default { fixture: true };",
  ),
};
put(
  `node_modules/${packageName}/package.json`,
  JSON.stringify({
    name: packageName,
    exports: { [subpath ? "." + subpath : "."]: { import: "./entry.mjs", require: "./entry.cjs" } },
  }),
);
if (behavior === "conditions") {
  const development = put(`node_modules/${packageName}/development.cjs`, "module.exports = { fixture: true };");
  targets.require = targets.import = development;
  put(
    `node_modules/${packageName}/package.json`,
    JSON.stringify({
      name: packageName,
      exports: { development: "./development.cjs", import: "./entry.mjs", require: "./entry.cjs" },
    }),
  );
}
if (installed !== "installed") fs.rmSync(path.join(root, "node_modules"), { recursive: true });
put("caller.cjs", "module.exports = spec => import(spec);");
if (behavior === "tsconfig") {
  put(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { ws: ["./override.cjs"], plain: ["./override.cjs"] } } }),
  );
  put("override.cjs", "module.exports = { wrongTarget: true };");
}
const req = createRequire(path.join(root, "caller.cjs"));
const importer = req("./caller.cjs");
const events = [];
const requested = behavior === "imports" ? "#replacement" : specifier;
if (behavior === "imports") put("package.json", JSON.stringify({ imports: { "#replacement": specifier } }));
let hook;
if (behavior !== "no-hooks")
  hook = registerHooks({
    ...(behavior === "load-only"
      ? {}
      : {
          resolve(spec, context, next) {
            const result = next(
              spec,
              behavior === "conditions" ? { ...context, conditions: [...context.conditions, "development"] } : context,
            );
            new URL(result.url);
            if (spec === requested) events.push({ phase: "resolve", url: result.url, format: result.format ?? null });
            if (behavior === "deregister-resolve") hook.deregister();
            return result;
          },
        }),
    load(url, context, next) {
      events.push({ phase: "load", url, format: context.format ?? null });
      new URL(url);
      if (behavior === "deregister-load") hook.deregister();
      if (behavior === "override")
        return { format: "module", source: "export default { overridden: 42 };", shortCircuit: true };
      return next(url, context);
    },
  });
let value;
try {
  value =
    method === "require"
      ? req(behavior === "roundtrip" ? req.resolve(requested) : requested)
      : await importer(requested);
  if (behavior === "override") assert.equal(value.default?.overridden ?? value.overridden, 42);
  if (behavior !== "no-hooks" && behavior !== "deregister-resolve") {
    const load = events.find(event => event.phase === "load");
    assert.ok(load, "the native replacement must reach the load hook");
    if (installed === "installed") assert.equal(load.url, targets[method]);
    if (specifier === "sys" || specifier === "node:sys") assert.equal(load.url, "node:sys");
    if (specifier.startsWith("internal/")) assert.equal(load.url, "node:" + specifier);
    if (specifier === "bun") assert.equal(load.url, "bun-builtin:bun");
    const resolve = events.find(event => event.phase === "resolve");
    if (resolve) assert.equal(resolve.url, load.url);
  }
  if (process.versions.bun)
    assert.notEqual(globalThis.w85FixtureExecuted, true, "nextLoad must preserve the native replacement");
  if (process.versions.bun && behavior === "tsconfig") assert.equal(req("plain").wrongTarget, true);
  console.log(JSON.stringify({ ok: true, events, fixtureExecuted: globalThis.w85FixtureExecuted === true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, events, error: { code: error.code, message: error.message } }));
  process.exitCode = 1;
}
