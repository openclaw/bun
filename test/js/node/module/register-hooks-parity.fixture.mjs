import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [mode, inputRoot] = process.argv.slice(2);
const root = fs.realpathSync(inputRoot);
const put = (file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return pathToFileURL(target).href;
};
const target = put("target.mjs", 'export const identity = {}; export const value = "target";');
const cjs = put("value.cjs", "module.exports = 42;");
const req = createRequire(path.join(root, "caller.cjs"));

if (mode.startsWith("data-missing-comma-")) {
  const variant = mode.slice("data-missing-comma-".length);
  const url =
    "data:text/javascript" + (variant === "base64" ? ";base64" : variant === "fragment-comma" ? "#ignored,42" : "");
  const formats = [];
  registerHooks({
    resolve(spec, context, next) {
      return variant === "short-circuit" && spec === "chosen:data" ? { url, shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      if (url.startsWith("data:")) {
        formats.push(context.format);
        if (variant === "source") return { format: "module", source: "export default 42;", shortCircuit: true };
      }
      return next(url, context);
    },
  });
  try {
    const value = (await import(variant === "short-circuit" ? "chosen:data" : url)).default;
    console.log(JSON.stringify({ value, formats }));
  } catch (error) {
    console.log(
      JSON.stringify({
        name: error.name,
        code: error.code,
        message: error.message,
        input: error.input === url,
        formats,
      }),
    );
  }
} else if (mode.startsWith("builtin-inflight-override-")) {
  const variant = mode.slice("builtin-inflight-override-".length);
  const outcome = promise =>
    promise.then(
      value => ({ value: value.default?.value ?? "native" }),
      error => ({ error: error.code }),
    );
  let nested;
  let loads = 0;
  const hook = registerHooks({
    load(url, context, next) {
      if (url === "node:diagnostics_channel") {
        const index = ++loads;
        if (index === 1 && variant === "settled") {
          const entry = put("builtin-settled.mjs", 'export {default} from "node:diagnostics_channel";');
          nested = { value: req(fileURLToPath(entry)).default.value ?? "native" };
        } else if (index === 1 && variant !== "direct") nested = outcome(import(url));
        if (variant === "deregister" && index === 1) hook.deregister();
        if (
          variant === "direct" ||
          ((variant === "outer" || variant === "settled" || variant === "deregister") && index === 1) ||
          (variant === "inner" && index === 2)
        )
          return { format: "module", source: `export default {value:${index}};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  const pending = outcome(import("node:diagnostics_channel"));
  if (variant === "direct") {
    try {
      nested = { value: req("node:diagnostics_channel").default.value };
    } catch (error) {
      nested = { error: error.code };
    }
  }
  console.log(JSON.stringify({ one: await pending, two: await nested, loads }));
} else if (mode.startsWith("shared-builtin-")) {
  const variant = mode.slice("shared-builtin-".length);
  const events = [];
  let nested;
  registerHooks({
    load(url, context, next) {
      if (url === "node:diagnostics_channel") {
        events.push([context.format, context.importAttributes]);
        if (events.length === 1) {
          if (variant === "require-during-load") nested = req(url);
          if (variant === "import-during-load") nested = import(url);
        }
      }
      return next(url, context);
    },
  });
  const pending = import("node:diagnostics_channel");
  if (variant === "direct") nested = req("node:diagnostics_channel");
  const one = await pending;
  const two = await nested;
  console.log(JSON.stringify({ same: variant === "import-during-load" ? one === two : one.default === two, events }));
} else if (mode.startsWith("data-base64-")) {
  const variant = mode.slice("data-base64-".length);
  const encoded = Buffer.from("export default 42;").toString("base64");
  const payload = {
    punctuation: encoded.slice(0, 2) + "!" + encoded.slice(2),
    highbit: "%DA" + encoded.slice(1),
    padding: encoded + "=",
    length: "A",
    whitespace: encoded.slice(0, 4) + "%09%0A%0C%0D%20" + encoded.slice(4),
    unpadded: Buffer.from("export default 42").toString("base64").replace(/=+$/, ""),
  }[variant];
  const url = "data:text/javascript;base64," + payload;
  registerHooks({ load: (url, context, next) => next(url, context) });
  try {
    console.log((await import(url)).default);
  } catch (error) {
    console.log(
      JSON.stringify({ name: error.name, code: error.code, message: error.message, input: error.input === url }),
    );
  }
} else if (mode.startsWith("shared-request-diamond-")) {
  const entry = put(
    "diamond-entry.mjs",
    'import {value as left} from "./left.mjs"; import {value as right} from "./right.mjs"; export const same = left === right;',
  );
  put("left.mjs", 'export {value} from "./shared.mjs";');
  put("right.mjs", 'export {value} from "./shared.mjs";');
  const shared = put("shared.mjs", "export const value = {};");
  const facts = [];
  let loads = 0;
  registerHooks({
    resolve(spec, context, next) {
      const result = next(spec, context);
      if (result.url === shared)
        facts.push(JSON.stringify([result.url, result.format, context.importAttributes, context.conditions]));
      return result;
    },
    load(url, context, next) {
      if (url === shared) loads++;
      return next(url, context);
    },
  });
  const value = mode.endsWith("require") ? req(fileURLToPath(entry)) : await import(entry);
  console.log(
    JSON.stringify({ same: value.same, loads, resolutions: facts.length, factsEqual: facts[0] === facts[1] }),
  );
} else if (mode === "shared-request-async-dependency") {
  let loads = 0;
  registerHooks({
    resolve(spec, context, next) {
      return spec === "shared" ? { url: "virtual:shared", format: "module", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      if (url !== "virtual:shared") return next(url, context);
      loads++;
      return { format: "module", source: "export const identity = {};", shortCircuit: true };
    },
  });
  const pending = import("shared");
  const required = req(fileURLToPath(put("shared-root.mjs", 'export {identity} from "shared";')));
  console.log(JSON.stringify({ same: (await pending).identity === required.identity, loads }));
} else if (mode === "shared-request-commonjs-self") {
  let loads = 0;
  registerHooks({
    resolve(spec, context, next) {
      return spec === "self" ? { url: "virtual:self", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      if (url !== "virtual:self") return next(url, context);
      loads++;
      return {
        format: "commonjs",
        source: 'module.exports = {value:42}; globalThis.pendingSelf = import("self");',
        shortCircuit: true,
      };
    },
  });
  const one = await import("self");
  const two = await globalThis.pendingSelf;
  console.log(JSON.stringify({ same: one === two, value: two.default.value, loads }));
} else if (mode === "record-identity-active-identical") {
  let loads = 0,
    nested;
  registerHooks({
    resolve(spec, context, next) {
      return spec === "identical"
        ? { url: "virtual:identical", format: "module", shortCircuit: true }
        : next(spec, context);
    },
    load(url, context, next) {
      if (url !== "virtual:identical") return next(url, context);
      loads++;
      if (loads === 1)
        nested = import("identical").then(
          value => ({ value }),
          error => ({ error }),
        );
      return { format: "module", source: "export default {};", shortCircuit: true };
    },
  });
  const one = await import("identical");
  const two = await nested;
  console.log(
    JSON.stringify(
      two.error
        ? { code: two.error.code, message: two.error.message, loads }
        : { same: one.default === two.value.default, loads },
    ),
  );
} else if (mode.startsWith("bun-internal-handoff-")) {
  const name = mode.slice("bun-internal-handoff-".length);
  const url = `bun:${name}`;
  let intercepted = false;
  registerHooks({
    load(spec, context, next) {
      if (spec === url) intercepted = true;
      return next(spec, context);
    },
  });
  const pending = import(url);
  const required = req(url);
  const imported = await pending;
  const member = name === "sqlite" ? "Database" : "heapStats";
  console.log(JSON.stringify({ same: required[member] === imported[member], intercepted }));
} else if (mode.startsWith("data-header-")) {
  const variant = mode.slice("data-header-".length);
  const headers = {
    upper: "text/javascript;BASE64",
    mixed: "text/javascript;bAsE64",
    space: "text/javascript;  base64 \t",
    mime: "TEXT/JavaScript;base64",
    json: "application/json;BASE64",
    "json-case-sensitive": "APPLICATION/JSON;base64",
  };
  const json = variant === "json" || variant === "json-case-sensitive";
  const source = Buffer.from(json ? '{"value":42}' : "export default 42;").toString("base64");
  registerHooks({ load: (url, context, next) => next(url, context) });
  const url = `data:${headers[variant]},${source}`;
  const pending = json ? import(url, { with: { type: "json" } }) : import(url);
  if (variant === "json-case-sensitive") {
    console.log(
      await pending.then(
        () => "unexpected success",
        error => error.code,
      ),
    );
  } else {
    const result = await pending;
    console.log(json ? result.default.value : result.default);
  }
} else if (mode === "data-query-source") {
  registerHooks({ load: (url, context, next) => next(url, context) });
  console.log((await import("data:text/javascript,export%20default%20%22before?after%22;#ignored")).default);
} else if (mode.startsWith("single-letter-scheme-")) {
  const commonjs = mode.endsWith("commonjs");
  registerHooks({
    resolve(spec, context, next) {
      return spec === "single-letter" ? { url: "x:module", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      return url === "x:module"
        ? {
            format: commonjs ? "commonjs" : "module",
            source: commonjs ? "module.exports = 42;" : "export default 42;",
            shortCircuit: true,
          }
        : next(url, context);
    },
  });
  const required = mode.includes("-require-");
  const value = required ? req("single-letter") : await import("single-letter");
  console.log(required && commonjs ? value : value.default);
} else if (mode.startsWith("static-cycle-")) {
  const entry = put("cycle-entry.mjs", 'import { answer } from "./cycle-middle.mjs"; export { answer };');
  put("cycle-middle.mjs", 'import { answer } from "./cycle-leaf.mjs"; export const marker = 1; export { answer };');
  put(
    "cycle-leaf.mjs",
    'import { marker } from "./cycle-middle.mjs"; export const answer = 42; export const getMarker = () => marker;',
  );
  let leafResolves = 0;
  registerHooks({
    resolve(spec, context, next) {
      if (spec === "./cycle-leaf.mjs") leafResolves++;
      return next(spec, context);
    },
  });
  const result = mode.endsWith("require") ? req(fileURLToPath(entry)) : await import(entry);
  console.log(JSON.stringify({ answer: result.answer, leafResolves }));
} else if (mode === "attributes-static-returned-identity") {
  const url = put("static-identity.json", '{"value":42}');
  const entry = put("static-entry.mjs", 'export { default } from "./static-identity.json";');
  let loads = 0;
  registerHooks({
    resolve(spec, context, next) {
      const result = next(spec, context);
      return result.url === url ? { ...result, importAttributes: { type: "json" } } : result;
    },
    load(spec, context, next) {
      if (spec === url) loads++;
      return next(spec, context);
    },
  });
  try {
    const one = await import(entry);
    const two = await import(url, { with: { type: "json" } });
    console.log(JSON.stringify({ same: one.default === two.default, loads }));
  } catch (error) {
    console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message.replace(url, "<url>") }));
  }
} else if (mode === "attributes-static-wrong-type") {
  const url = "virtual:typed";
  let loads = 0;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "as-json") return { url, importAttributes: { type: "json" }, shortCircuit: true };
      if (specifier === "as-module") return { url, shortCircuit: true };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      if (specifier !== url) return next(specifier, context);
      loads++;
      return context.importAttributes?.type === "json"
        ? { format: "json", source: '{"kind":"json"}', shortCircuit: true }
        : { format: "module", source: 'export default "javascript";', shortCircuit: true };
    },
  });
  const before = await import("as-module");
  try {
    const after = await import('data:text/javascript,export {default} from "as-json"');
    console.log(JSON.stringify({ before: before.default, after: after.default, loads }));
  } catch (error) {
    console.log(JSON.stringify({ code: error.code, message: error.message.replace(url, "<url>"), loads }));
  }
} else if (mode.startsWith("record-identity-")) {
  const variant = mode.slice("record-identity-".length);
  let loads = 0,
    nested;
  const outcome = promise =>
    promise.then(
      value => ({ value }),
      error => ({ error }),
    );
  registerHooks({
    resolve(spec, context, next) {
      return spec === "parallel" ? { url: "virtual:parallel", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      if (url !== "virtual:parallel") return next(url, context);
      loads++;
      if (variant !== "sync-handoff" && variant !== "completed-handoff" && loads === 1)
        nested = outcome(import("parallel", { with: { flavor: "nested" } }));
      return {
        format: "module",
        source: `export default ${JSON.stringify(context.importAttributes?.flavor ?? "outer")};`,
        shortCircuit: true,
      };
    },
  });
  let one, two;
  if (variant === "static-reentrant") {
    one = await outcome(import(put("reentrant-entry.mjs", 'export { default } from "parallel";')));
    two = await nested;
  } else if (variant === "dynamic-reentrant") {
    one = await outcome(import("parallel", { with: { flavor: "one" } }));
    two = await nested;
  } else {
    const first = outcome(import("parallel", { with: { flavor: "one" } }));
    if (variant === "completed-handoff") await first;
    try {
      two = { value: req("parallel") };
    } catch (error) {
      two = { error };
    }
    one = await first;
  }
  const values = [one, two].map(result => (result.error ? null : result.value.default));
  const errors = [one, two].map(result =>
    result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null,
  );
  console.log(JSON.stringify(errors.some(Boolean) ? { values, errors, loads } : { values, loads }));
} else if (mode === "require-resolve-paths") {
  const descriptor = Object.getOwnPropertyDescriptor(req.resolve, "paths");
  const direct = req.resolve.paths("dep");
  const copied = Object.assign(() => {}, req.resolve);
  console.log(
    JSON.stringify({
      descriptor: [descriptor.enumerable, descriptor.writable, descriptor.configurable],
      scoped: direct[0] === path.join(root, "node_modules"),
      copied: JSON.stringify(copied.paths("dep")) === JSON.stringify(direct),
      unbound: JSON.stringify(Reflect.apply(req.resolve.paths, undefined, ["dep"])) === JSON.stringify(direct),
      builtin: copied.paths("node:fs") === null,
    }),
  );
} else if (mode.startsWith("materialized-imports-")) {
  const esm = mode.endsWith("esm");
  const filename = esm ? "late.mjs" : "late.cjs";
  put("package.json", '{"imports":{"#external":"dep"}}');
  put("node_modules/dep/package.json", JSON.stringify({ exports: "./" + filename }));
  const entry = put("entry.mjs", 'export { value } from "#external";');
  let retried = false;
  registerHooks({
    resolve(spec, context, next) {
      try {
        return next(spec, context);
      } catch (error) {
        if (spec !== "#external") throw error;
        retried = true;
        put("node_modules/dep/" + filename, esm ? "export const value = 42;" : "exports.value = 42;");
        return next(spec, context);
      }
    },
  });
  const value = esm ? (await import(entry)).value : req("#external").value;
  console.log(JSON.stringify({ value, retried }));
} else if (mode === "commonjs-tla") {
  const url = put("tla.cjs", "exports.value = await Promise.resolve(42);");
  registerHooks({
    load(spec, context, next) {
      return spec === url
        ? { format: "commonjs", source: fs.readFileSync(new URL(url)), shortCircuit: true }
        : next(spec, context);
    },
  });
  try {
    req(fileURLToPath(url));
    console.log(false);
  } catch (error) {
    console.log(error instanceof SyntaxError && /await|Promise/.test(error.message));
  }
} else if (mode === "bun-default-conditions") {
  put("package.json", '{"imports":{"#selected":{"bun":"./bun.cjs","default":"./node.cjs"}}}');
  put("bun.cjs", 'module.exports = "bun";');
  put("node.cjs", 'module.exports = "node";');
  let withoutBun = false;
  registerHooks({
    resolve(spec, context, next) {
      return next(spec, withoutBun ? { ...context, conditions: context.conditions.filter(x => x !== "bun") } : context);
    },
  });
  const native = req("#selected");
  withoutBun = true;
  console.log(JSON.stringify([native, req("#selected")]));
} else if (mode.startsWith("bun-native-aliases-")) {
  const hooks = {};
  const kind = mode.slice("bun-native-aliases-".length);
  if (kind !== "load") hooks.resolve = (spec, context, next) => next(spec, context);
  if (kind !== "resolve") hooks.load = (url, context, next) => next(url, context);
  registerHooks(hooks);
  const results = [];
  for (const name of [
    "ws",
    "ws/lib/websocket",
    "next/dist/compiled/ws",
    "undici",
    "node-fetch",
    "isomorphic-fetch",
    "@vercel/fetch",
    "abort-controller",
  ]) {
    const required = req(name),
      imported = (await import(name)).default;
    results.push([name, typeof required, required === imported]);
  }
  const validate = req("utf-8-validate");
  const importedValidate = (await import("utf-8-validate")).default;
  results.push([
    "utf-8-validate",
    validate(Buffer.from("valid")) && importedValidate(Buffer.from("valid")),
    !validate(Buffer.from([0xff])) && !importedValidate(Buffer.from([0xff])),
  ]);
  console.log(JSON.stringify(results));
} else if (mode.startsWith("bun-transparent-json-")) {
  const hooks = {};
  if (mode.endsWith("load")) hooks.load = (url, context, next) => next(url, context);
  else hooks.resolve = (spec, context, next) => next(spec, context);
  registerHooks(hooks);
  const url = put("native.json", '{"value":42}');
  console.log((await import(url)).default.value);
} else if (mode.startsWith("attributes-reject-")) {
  const variant = mode.slice("attributes-reject-".length);
  const url = variant === "missing" ? put("assertion.json", '{"value":42}') : target;
  const attributes =
    variant === "missing"
      ? {}
      : variant === "key"
        ? { flavor: "wrong" }
        : { type: variant === "value" ? "javascript" : variant === "number" ? 42 : "json" };
  registerHooks({
    resolve(spec, context, next) {
      return spec === "invalid-attributes"
        ? { url, importAttributes: attributes, shortCircuit: true }
        : next(spec, context);
    },
    load(spec, context, next) {
      return next(spec, context);
    },
  });
  try {
    await import("invalid-attributes");
    console.log("unexpected success");
  } catch (error) {
    console.log(
      JSON.stringify({ name: error.name, code: error.code, message: error.message.replaceAll(url, "<url>") }),
    );
  }
} else if (mode === "attributes-returned-identity") {
  const url = put("identity.json", '{"value":42}');
  let loads = 0;
  registerHooks({
    resolve(spec, context, next) {
      const result = next(spec, context);
      return result.url === url ? { ...result, importAttributes: { type: "json" } } : result;
    },
    load(spec, context, next) {
      if (spec === url) loads++;
      return next(spec, context);
    },
  });
  const one = await import(url);
  const two = await import(url, { with: { type: "json" } });
  console.log(JSON.stringify({ same: one === two, loads }));
} else if (mode === "attributes-nontype-identity") {
  const entry = put("identity-entry.mjs", 'export {default} from "shared-identity";');
  let loads = 0;
  registerHooks({
    resolve(spec, context, next) {
      return spec === "shared-identity" ? { url: "virtual:identity", shortCircuit: true } : next(spec, context);
    },
    load(spec, context, next) {
      if (spec !== "virtual:identity") return next(spec, context);
      loads++;
      return { format: "module", source: "export default {};", shortCircuit: true };
    },
  });
  const one = await import(entry);
  const two = await import("shared-identity", { with: { flavor: "two" } });
  console.log(JSON.stringify({ same: one.default === two.default, loads }));
} else if (mode === "concurrent-attributes") {
  const seen = [];
  registerHooks({
    resolve(spec, context, next) {
      if (spec !== "parallel") return next(spec, context);
      seen.push(["resolve", context.importAttributes]);
      return { url: "virtual:parallel", shortCircuit: true };
    },
    load(url, context, next) {
      if (url !== "virtual:parallel") return next(url, context);
      seen.push(["load", context.importAttributes]);
      return {
        source: `export default ${JSON.stringify(context.importAttributes.flavor)};`,
        format: "module",
        shortCircuit: true,
      };
    },
  });
  const values = await Promise.all([
    import("parallel", { with: { flavor: "one" } }),
    import("parallel", { with: { flavor: "two" } }),
  ]);
  console.log(JSON.stringify({ seen, values: values.map(value => value.default) }));
} else if (mode === "self-deregister-format") {
  const source = put("disguised.json", "export default 42;");
  const hook = registerHooks({
    resolve(spec, context, next) {
      if (spec !== "self-deregister") return next(spec, context);
      hook.deregister();
      return { url: source, format: "module", shortCircuit: true };
    },
  });
  console.log((await import("self-deregister")).default);
} else if (mode.startsWith("redirect-load-")) {
  const variant = mode.slice("redirect-load-".length);
  if (variant === "package") put("typed/package.json", '{"type":"module"}');
  const source = put(
    variant === "json" ? "redirect.json" : variant === "package" ? "typed/redirect.js" : "redirect.mjs",
    variant === "json" ? '{"value":42}' : "var value = 42;",
  );
  let observed;
  registerHooks({
    resolve(spec, context, next) {
      return spec === "redirect-load" ? { url: "virtual:redirect", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      if (url !== "virtual:redirect") return next(url, context);
      const result = next(source, variant === "json" ? { ...context, importAttributes: { type: "json" } } : context);
      observed = result.format;
      return variant === "json" ? result : { ...result, source: "export default 42;" };
    },
  });
  const result = await import("redirect-load");
  console.log(JSON.stringify([observed, variant === "json" ? result.default.value : result.default]));
} else if (mode === "data-percent" || mode === "data-wasm-bytes") {
  const bytes = [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 9, 1, 5, 118, 97, 108, 117, 101, 0, 0, 10, 7, 1,
    5, 0, 65, 170, 1, 11,
  ];
  const url =
    mode === "data-percent"
      ? "data:text/javascript,export default 5%2"
      : "data:application/wasm," + bytes.map(value => "%" + value.toString(16).padStart(2, "0")).join("");
  registerHooks({
    load(spec, context, next) {
      return next(spec, context);
    },
  });
  const result = await import(url);
  console.log(mode === "data-percent" ? result.default : result.value());
} else if (mode.startsWith("builtin-override-")) {
  const useRequire = mode.includes("-require-");
  const format = mode.endsWith("-cjs") ? "commonjs" : mode.endsWith("-json") ? "json" : "module";
  const specialExport = mode.endsWith("-special");
  let loads = 0;
  const hook = registerHooks({
    load(url, context, next) {
      if (url !== "node:zlib") return next(url, context);
      loads++;
      return {
        format,
        source:
          format === "json"
            ? '{"value":42}'
            : format === "commonjs"
              ? "module.exports = 42;"
              : specialExport
                ? 'const value = 42; export { value as "module.exports" };'
                : "export default 42;",
        shortCircuit: true,
      };
    },
  });
  const first = useRequire ? req("node:zlib") : await import("node:zlib");
  hook.deregister();
  const second = useRequire ? req("node:zlib") : await import("node:zlib");
  console.log(
    JSON.stringify({
      value:
        format === "json"
          ? useRequire
            ? first.value
            : first.default.value
          : useRequire && (format === "commonjs" || specialExport)
            ? first
            : first.default,
      same: first === second,
      loads,
      cached: Object.hasOwn(req.cache, "node:zlib"),
    }),
  );
} else if (mode === "resolve-only-format") {
  const url = put("source.txt", "export default 42;");
  registerHooks({
    resolve(spec, context, next) {
      return spec === "virtual-format" ? { url, format: "module", shortCircuit: true } : next(spec, context);
    },
  });
  console.log((await import("virtual-format")).default);
} else if (mode === "load-detection") {
  const sources = [
    ["export", "export const value = 42;"],
    ["meta", "import.meta.url;"],
    ["await", "await Promise.resolve();"],
    ["lexical", "let module;"],
    ["cjs", "module.exports = 42;"],
    ["typescript", "const value: number = 42; export { value };"],
  ];
  const seen = [];
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url.includes("detect-")) seen.push(result.format);
      return result;
    },
  });
  for (const [name, source] of sources)
    await import(put(`detect-${name}.${name === "typescript" ? "ts" : "js"}`, source));
  console.log(JSON.stringify(seen));
} else if (mode.startsWith("wasm-")) {
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 9, 1, 5, 118, 97, 108, 117, 101, 0, 0, 10, 7, 1,
    5, 0, 65, 170, 1, 11,
  ]);
  const padded = new Uint8Array(bytes.length + 4);
  padded.set(bytes, 2);
  const source =
    mode === "wasm-arraybuffer"
      ? bytes.buffer
      : mode === "wasm-uint8array"
        ? new Uint8Array(padded.buffer, 2, bytes.length)
        : Buffer.from(padded.buffer, 2, bytes.length);
  registerHooks({
    resolve(spec, context, next) {
      return spec === "virtual-wasm"
        ? { url: "virtual:wasm", format: "wasm", shortCircuit: true }
        : next(spec, context);
    },
    load(url, context, next) {
      return url === "virtual:wasm" ? { format: "wasm", source, shortCircuit: true } : next(url, context);
    },
  });
  console.log((await import("virtual-wasm")).value());
} else if (mode === "parent") {
  const parent = put("nested/caller.mjs", "");
  put("nested/dep.mjs", 'export default "nested";');
  registerHooks({
    resolve(spec, context, next) {
      return spec === "virtual-parent" ? next("./dep.mjs", { ...context, parentURL: parent }) : next(spec, context);
    },
  });
  console.log((await import("virtual-parent")).default);
} else if (mode === "conditions") {
  put(
    "node_modules/probe/package.json",
    JSON.stringify({
      name: "probe",
      type: "module",
      exports: { custom: "./custom.mjs", default: "./default.mjs" },
    }),
  );
  put("node_modules/probe/custom.mjs", 'export default "custom";');
  put("node_modules/probe/default.mjs", 'export default "default";');
  registerHooks({
    resolve(spec, context, next) {
      return next(spec, spec === "probe" ? { ...context, conditions: [...context.conditions, "custom"] } : context);
    },
  });
  console.log(req("probe").default);
} else if (mode === "cjs-source") {
  let source;
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url === cjs) source = result.source;
      return result;
    },
  });
  await import(cjs);
  console.log(source === null ? "null" : typeof source);
} else if (mode === "cjs-transform") {
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url === cjs) result.source = Buffer.from(result.source).toString().replace("42", "43");
      return result;
    },
  });
  console.log((await import(cjs)).default);
} else if (mode.startsWith("empty-url-suffix-")) {
  const observed = [];
  registerHooks({
    resolve(spec, context, next) {
      return spec.startsWith("variant:")
        ? { url: target + spec.slice(8), format: "module", shortCircuit: true }
        : next(spec, context);
    },
    load(url, context, next) {
      if (url.startsWith(target)) observed.push(url.slice(target.length));
      return next(url, context);
    },
  });
  const suffixes = ["", "?", "#", "?#"];
  let identities;
  if (mode.endsWith("static")) {
    const entry = put(
      "empty-suffix-entry.mjs",
      suffixes.map((suffix, i) => `import {identity as i${i}} from "variant:${suffix}";`).join("\n") +
        "export default [i0, i1, i2, i3];",
    );
    identities = (await import(entry)).default;
  } else {
    identities = [];
    for (const suffix of suffixes) identities.push((await import("variant:" + suffix)).identity);
  }
  console.log(JSON.stringify({ distinct: new Set(identities).size, observed }));
} else if (mode === "query" || mode === "fragment") {
  const observed = [];
  const delimiter = mode === "query" ? "?" : "#";
  registerHooks({
    resolve(spec, context, next) {
      return spec.startsWith("variant:")
        ? { url: target + delimiter + spec.slice(8), shortCircuit: true }
        : next(spec, context);
    },
    load(url, context, next) {
      if (url.includes("target.mjs")) observed.push(url.slice(url.indexOf("target.mjs")));
      return next(url, context);
    },
  });
  const one = await import("variant:one");
  const two = await import("variant:two");
  console.log(JSON.stringify({ same: one.identity === two.identity, observed }));
} else if (mode === "custom-scheme") {
  registerHooks({
    resolve(spec, context, next) {
      return spec.startsWith("variant:") ? { url: spec, format: "module", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      return url.startsWith("variant:")
        ? { source: `export default ${JSON.stringify(url)};`, format: "module", shortCircuit: true }
        : next(url, context);
    },
  });
  console.log((await import("variant:one")).default);
} else if (mode === "format-lifetime") {
  const hook = registerHooks({
    resolve(spec, context, next) {
      return { ...next(spec, context), format: "json" };
    },
  });
  req.resolve("./value.cjs");
  hook.deregister();
  registerHooks({
    load(url, context, next) {
      return next(url, context);
    },
  });
  console.log(req("./value.cjs"));
} else if (["attributes", "attributes-static", "attributes-override"].includes(mode)) {
  const json = put("value.json", '{"value":42}');
  const seen = [];
  registerHooks({
    resolve(spec, context, next) {
      if (spec.endsWith("value.json")) {
        seen.push(["resolve", context.importAttributes]);
        const result = next(spec, context);
        return mode === "attributes-override" ? { ...result, importAttributes: { type: "json" } } : result;
      }
      return next(spec, context);
    },
    load(url, context, next) {
      if (url === json) seen.push(["load", context.importAttributes]);
      return next(url, context);
    },
  });
  if (mode === "attributes-static") {
    const entry = put("entry.mjs", 'import value from "./value.json" with { type: "json" }; export default value;');
    await import(entry);
  } else if (mode === "attributes-override") {
    await import(json);
  } else {
    await import(json, { with: { type: "json" } });
  }
  console.log(JSON.stringify(seen));
} else if (mode === "untyped-typescript-load") {
  const source = put("plain.ts", "declare const __filename: string; module.exports = 42;");
  let observed;
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url === source) observed = [context.format, result.format, typeof result.source];
      return result;
    },
  });
  console.log(JSON.stringify({ value: req(path.join(root, "plain.ts")), observed }));
} else if (mode === "cli-conditions") {
  let observed = false;
  registerHooks({
    resolve(spec, context, next) {
      if (spec === "node:fs")
        observed = context.conditions.includes("w73-custom") && Object.isFrozen(context.conditions);
      return next(spec, context);
    },
  });
  req("node:fs");
  console.log(observed);
} else if (mode === "require-query") {
  let observed;
  registerHooks({
    resolve(spec, context, next) {
      return spec === "queried" ? { url: cjs + "?q", format: "commonjs", shortCircuit: true } : next(spec, context);
    },
    load(url, context, next) {
      observed = url;
      return next(url, context);
    },
  });
  req("queried");
  console.log(observed === cjs + "?q");
} else if (mode === "meta-parent-query") {
  const entry = put("meta.mjs", 'export default import.meta.resolve("parent-check");');
  let observed;
  registerHooks({
    resolve(spec, context, next) {
      if (spec === "parent-check") {
        observed = context.parentURL;
        return { url: target, shortCircuit: true };
      }
      return next(spec, context);
    },
  });
  await import(entry + "?parent=one");
  console.log(observed === entry + "?parent=one");
} else if (mode === "load-result-url") {
  let matches = false;
  const queried = cjs + "?instance=one";
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url === queried) matches = result.responseURL === url;
      return result;
    },
  });
  await import(queried);
  console.log(matches);
} else if (mode === "meta-resolve") {
  registerHooks({
    resolve(spec, context, next) {
      return spec === "./missing.mjs" ? { url: target, shortCircuit: true } : next(spec, context);
    },
  });
  console.log(import.meta.resolve("./missing.mjs") === target);
} else if (mode === "require-properties") {
  const copied = Object.assign(() => {}, req);
  const Module = req("node:module");
  const originalCache = req.cache,
    originalExtensions = req.extensions;
  const descriptor = Object.getOwnPropertyDescriptor(req, "extensions");
  const replacement = {
    ".js": module => {
      module.exports = 99;
    },
  };
  req.extensions = replacement;
  req.cache = {};
  put("properties.proof", "not JavaScript");
  originalExtensions[".proof"] = module => {
    module.exports = 43;
  };
  console.log(
    ["main", "extensions", "cache"].every(key => Object.hasOwn(req, key)) &&
      copied.cache === originalCache &&
      !!descriptor &&
      "value" in descriptor &&
      descriptor.enumerable &&
      req.extensions === replacement &&
      Module._cache === originalCache &&
      Module._extensions === originalExtensions &&
      req("./properties.proof") === 43,
  );
  delete originalExtensions[".proof"];
} else if (mode === "source-formats") {
  put("package.json", '{"type":"module"}');
  const urls = ["a.mts", "b.cts", "c.ts", "d.js"].map(name => put(name, ""));
  const formats = [];
  registerHooks({
    resolve(spec, context, next) {
      const result = next(spec, context);
      if (urls.includes(spec)) formats.push(result.format);
      return result;
    },
  });
  for (const url of urls) import.meta.resolve(url);
  console.log(JSON.stringify(formats));
} else if (mode === "materialized-file") {
  const first = put("first.mjs", "export default 1;");
  registerHooks({
    resolve(spec, context, next) {
      return spec === "late"
        ? { url: put("late.mjs", "export default 42;"), format: "module", shortCircuit: true }
        : next(spec, context);
    },
  });
  await import(first);
  console.log((await import("late")).default);
} else if (mode === "materialized-package") {
  put("node_modules/dep/package.json", '{"name":"dep","type":"module","exports":"./index.mjs"}');
  put("node_modules/dep/index.mjs", "export const value=1;");
  const entry = put("entry.mjs", 'export {value} from "dep";');
  const nested = put("nested/entry.mjs", 'export const load=()=>import("dep");');
  const hook = registerHooks({
    resolve(spec, context, next) {
      if (spec === "dep" && context.parentURL.includes("/nested/")) {
        put("nested/node_modules/dep/package.json", '{"name":"dep","type":"module","exports":"./index.mjs"}');
        put("nested/node_modules/dep/index.mjs", "export const value=2;");
      }
      return next(spec, context);
    },
  });
  const one = await import(entry);
  const two = await import(nested);
  const nestedValue = (await two.load()).value;
  hook.deregister();
  const after = createRequire(path.join(root, "nested/other.cjs"))("dep").value;
  console.log(JSON.stringify({ root: one.value, nested: nestedValue, after }));
} else if (mode === "data-json") {
  registerHooks({
    load(url, context, next) {
      return next(url, context);
    },
  });
  console.log((await import("data:application/json,%7B%22value%22%3A42%7D", { with: { type: "json" } })).default.value);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
