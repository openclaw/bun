// Synchronous `module.registerHooks()` — port of
// https://github.com/nodejs/node/blob/main/lib/internal/modules/customization_hooks.js
// Native entry points: runResolveHooksBun / runLoadHooksBun (undefined ⇒ use native path).
const { validateFunction, validateString } = require("internal/validators");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { isAbsolute } = require("node:path");
const { isAnyArrayBuffer, isArrayBufferView } = require("node:util/types");
const { isBuiltin } = require("node:module");

// The native load gate includes pending resolve results, which survive a hook
// deregistering itself before returning its result.
const setNativeHooksCounts = $newRustFunction("node_module_hooks_binding.rs", "setModuleHooksCounts", 2);
// (specifier: string, referrer: string, isESM: boolean, isUserRequireResolve:
// boolean) => string — Bun's default resolution, with hooks suppressed.
const nativeDefaultResolve = $newRustFunction("node_module_hooks_binding.rs", "defaultResolveForHooks", 6);
const nativePackageType = $newRustFunction("node_module_hooks_binding.rs", "getPackageTypeForHooks", 1);
const nativeDefaultConditions = $newRustFunction("node_module_hooks_binding.rs", "getDefaultConditionsForHooks", 1);
const getNativeBuiltinSpecifier = $newRustFunction("node_module_hooks_binding.rs", "getBuiltinSpecifierForHooks", 1);
const containsModuleSyntax = $newCppFunction("NodeModuleModule.cpp", "jsFunctionModuleHooksContainsModuleSyntax", 1);

// BunLoaderType values (src/jsc/bindings/headers-handwritten.h).
const LOADER_NONE = 254;
const LOADER_JS = 2;
const LOADER_TS = 3;
const LOADER_JSON = 7;
const LOADER_WASM = 10;
// ModuleType override handed back to the native loader.
const MODULE_TYPE_UNKNOWN = 0;
const MODULE_TYPE_CJS = 1;
const MODULE_TYPE_ESM = 2;

// Node's default conditions, in Node's order (observed on v26.3.0).
const cjsConditions = Object.freeze(nativeDefaultConditions(false));
const esmConditions = Object.freeze(nativeDefaultConditions(true));

const resolveHooks: any[] = [];
const loadHooks: any[] = [];
const hookId = Symbol("kModuleHooksIdKey");
let nextHookId = 0;

// Formats produced by the resolve hook chain, keyed by result URL, consumed
// as `context.format` when the load stage runs for that module.
const resolvedContexts = new Map<
  string,
  {
    url: string;
    format: string | null | undefined;
    importAttributes: any;
    attributesKnown: boolean;
    attributesOverridden: boolean;
    isESM: boolean;
    builtin: string | undefined;
  }
>();
// A resolve-only lookup must retain the native identity when its returned
// filesystem URL is subsequently loaded while hooks remain registered.
const builtinURLs = new Map<string, string>();
const nativeURLs = new Map<string, string>();

function updateNativeHooksCounts() {
  setNativeHooksCounts(resolveHooks.length, loadHooks.length + resolvedContexts.size);
}

class ModuleHooks {
  resolve;
  load;
  constructor(resolve, load) {
    this[hookId] = Symbol(`module-hook-${nextHookId++}`);
    this.resolve = resolve;
    this.load = load;
    if (resolve) {
      resolveHooks.push(this);
    }
    if (load) {
      loadHooks.push(this);
    }
    updateNativeHooksCounts();
    Object.freeze(this);
  }

  deregister() {
    const id = this[hookId];
    let index = resolveHooks.findIndex(hook => hook[hookId] === id);
    if (index !== -1) {
      resolveHooks.splice(index, 1);
    }
    index = loadHooks.findIndex(hook => hook[hookId] === id);
    if (index !== -1) {
      loadHooks.splice(index, 1);
    }
    resolvedContexts.clear();
    if (resolveHooks.length === 0 && loadHooks.length === 0) builtinURLs.clear();
    updateNativeHooksCounts();
  }
}

function registerHooks(hooks) {
  const { resolve, load } = hooks;
  if (resolve) {
    validateFunction(resolve, "hooks.resolve");
  }
  if (load) {
    validateFunction(load, "hooks.load");
  }
  return new ModuleHooks(resolve, load);
}

function nativeBuiltinSpecifier(specifier) {
  if (specifier === undefined) return undefined;
  if (specifier.startsWith("bun-builtin:")) {
    return nativeURLs.get(specifier);
  }
  if (specifier.startsWith("node:internal/")) return getNativeBuiltinSpecifier(specifier.slice(5));
  return getNativeBuiltinSpecifier(specifier);
}

function nativeVirtualSpecifier(url) {
  if (typeof url === "string" && url.startsWith("bun-virtual:")) return nativeURLs.get(url);
}

function virtualModuleURL(specifier) {
  const url = "bun-virtual:" + encodeURIComponent(specifier);
  nativeURLs.set(url, specifier);
  return url;
}

function convertCJSFilenameToURL(filename) {
  if (!filename) return filename;
  if (filename.startsWith("node:") || filename.startsWith("bun-builtin:")) return filename;
  const builtin = nativeBuiltinSpecifier(filename);
  if (builtin !== undefined) {
    if (builtin.startsWith("internal/")) return "node:" + builtin;
    if (builtin.includes(":")) return builtin;
    const url = "bun-builtin:" + builtin;
    nativeURLs.set(url, builtin);
    return url;
  }
  if (isAbsolute(filename)) {
    return pathToFileURL(filename).href;
  }
  if (URL.canParse(filename)) return filename;
  return filename.includes(":") ? virtualModuleURL(filename) : pathToFileURL(filename).href;
}

function convertURLToCJSFilename(url) {
  if (!url) return url;
  if (url.startsWith("node:")) {
    return url;
  }
  if (isBuiltin(url)) {
    return url;
  }
  if (url.startsWith("file://")) {
    return fileURLToPath(url);
  }
  return url;
}

// https://github.com/nodejs/node/blob/v26.3.0/lib/internal/modules/customization_hooks.js#L171
function buildHooks(hooks, name, defaultStep, validate, mergedContext) {
  let lastRunIndex = hooks.length;
  function wrapHook(index, userHookOrDefault, next: Function | undefined = undefined) {
    return function nextStep(arg0, context) {
      lastRunIndex = index;
      if (context && context !== mergedContext) {
        Object.assign(mergedContext, context);
      }
      const hookResult = userHookOrDefault(arg0, mergedContext, next);
      if (lastRunIndex > 0 && lastRunIndex === index) {
        const shortCircuit = hookResult.shortCircuit;
        if (!shortCircuit) {
          throw $ERR_INVALID_RETURN_PROPERTY_VALUE("true", name, "shortCircuit", shortCircuit);
        }
      }
      return validate(arg0, mergedContext, hookResult);
    };
  }
  const chain = [wrapHook(0, defaultStep)];
  for (let i = 0; i < hooks.length; ++i) {
    const wrappedHook = wrapHook(i + 1, hooks[i][name], chain[i]);
    chain.push(wrappedHook);
  }
  return chain[chain.length - 1];
}

function validateResolve(specifier, context, result) {
  const { url, format, importAttributes } = result;
  if (typeof url !== "string") {
    throw $ERR_INVALID_RETURN_PROPERTY_VALUE("a URL string", "resolve", "url", url);
  }
  if (format && typeof format !== "string") {
    throw $ERR_INVALID_RETURN_PROPERTY_VALUE("a string", "resolve", "format", format);
  }
  if (importAttributes && typeof importAttributes !== "object") {
    throw $ERR_INVALID_RETURN_PROPERTY_VALUE("an object", "resolve", "importAttributes", importAttributes);
  }
  return {
    __proto__: null,
    url,
    format,
    importAttributes,
  };
}

function validateSourceStrict(url, context, result) {
  const { source, format } = result;
  // Native builtins may delegate with null source, including Bun's bare aliases.
  if (
    !url.startsWith("node:") &&
    format !== "builtin" &&
    nativeBuiltinSpecifier(url) === undefined &&
    typeof result.source !== "string" &&
    !isAnyArrayBuffer(source) &&
    !isArrayBufferView(source) &&
    format !== "addon"
  ) {
    throw $ERR_INVALID_RETURN_PROPERTY_VALUE("a string, an ArrayBuffer, or a TypedArray", "load", "source", source);
  }
}

function validateSourcePermissive(url, context, result) {
  const { source, format } = result;
  if (format === "commonjs" && source == null) {
    // The default load step for the ES module loader produces a null source
    // for commonjs modules; see nodejs/node#57327.
    return;
  }
  validateSourceStrict(url, context, result);
}

function validateFormat(url, context, result) {
  const { format } = result;
  if (typeof format !== "string" && format !== undefined) {
    throw $ERR_INVALID_RETURN_PROPERTY_VALUE("a string", "load", "format", format);
  }
}

function validateLoadStrict(url, context, result) {
  validateSourceStrict(url, context, result);
  validateFormat(url, context, result);
  return result;
}

function validateLoadSloppy(url, context, result) {
  validateSourcePermissive(url, context, result);
  validateFormat(url, context, result);
  return result;
}

class ModuleResolveContext {
  parentURL;
  importAttributes;
  conditions;
  constructor(parentURL, importAttributes, conditions) {
    this.parentURL = parentURL;
    this.importAttributes = importAttributes;
    this.conditions = conditions;
  }
}

class ModuleLoadContext {
  format;
  importAttributes;
  conditions;
  constructor(format, importAttributes, conditions) {
    this.format = format;
    this.importAttributes = importAttributes;
    this.conditions = conditions;
  }
}

let decoder;
let typeStripper;
function loadWithHooks(url, originalFormat, importAttributes, conditions, defaultLoad, validateLoad) {
  const context = new ModuleLoadContext(originalFormat, importAttributes, conditions);
  const result =
    loadHooks.length === 0
      ? defaultLoad(url, context)
      : buildHooks(loadHooks, "load", defaultLoad, validateLoad, context)(url, context);
  const { source, format } = result;
  if (!isAnyArrayBuffer(source) && !isArrayBufferView(source)) {
    return result;
  }

  switch (format) {
    // Text formats:
    case undefined:
    case "module":
    case "commonjs":
    case "json":
    case "module-typescript":
    case "commonjs-typescript":
    case "typescript": {
      decoder ??= new TextDecoder();
      result.source = decoder.decode(source);
      break;
    }
    default:
      break;
  }
  return result;
}

function resolveWithHooks(specifier, parentURL, importAttributes, conditions, defaultResolve) {
  const context = new ModuleResolveContext(parentURL, importAttributes, conditions);
  if (resolveHooks.length === 0) {
    return defaultResolve(specifier, context);
  }

  const runner = buildHooks(resolveHooks, "resolve", defaultResolve, validateResolve, context);

  return runner(specifier, context);
}

// Formats Node's ES module resolution reports for a resolved path, derived
// from the extension (Bun's native loader re-derives package.json semantics
// itself, so this only feeds the hooks' `context`/result observability).
function defaultEsmFormat(filename) {
  if (filename.startsWith("bun-virtual:")) return "builtin";
  if (filename.startsWith("node:") || nativeBuiltinSpecifier(filename) !== undefined) return "builtin";
  if (filename.startsWith("data:")) {
    const mime = filename.slice(5, filename.indexOf(",")).split(";", 1)[0];
    // Node's mimeToFormat matches JavaScript case-insensitively, but JSON and Wasm exactly.
    if (mime === "application/json") return "json";
    if (/^\s*(?:text|application)\/javascript\s*$/i.test(mime)) return "module";
    if (mime === "application/wasm") return "wasm";
    return null;
  }
  if (filename.startsWith("file:")) filename = fileURLToPath(filename);
  if (filename.endsWith(".mjs")) return "module";
  if (filename.endsWith(".cjs")) return "commonjs";
  if (filename.endsWith(".mts")) return "module-typescript";
  if (filename.endsWith(".cts")) return "commonjs-typescript";
  if (filename.endsWith(".json")) return "json";
  if (filename.endsWith(".wasm")) return "wasm";
  if (filename.endsWith(".node")) return "addon";
  if (filename.endsWith(".js") || filename.endsWith(".ts")) {
    const type = nativePackageType(filename);
    if (type !== MODULE_TYPE_UNKNOWN) {
      const format = type === MODULE_TYPE_ESM ? "module" : "commonjs";
      return filename.endsWith(".ts") ? format + "-typescript" : format;
    }
  }
  return null;
}

// ── Bun native loader entry points ──────────────────────────────────────────

// Called by the native resolve funnel when at least one resolve hook is
// registered. Returns the resolved specifier for Bun's pipeline, or
// `undefined` when the chain produced exactly the default resolution.
function runResolveHooksBun(specifier, referrer, isESM, isUserRequireResolve, attributes, resolveOnly = false) {
  if (specifier.startsWith("bun:") || specifier.startsWith("builtin:") || specifier.startsWith("macro:"))
    return undefined;
  const parentURL = referrer ? convertCJSFilenameToURL(referrer) : undefined;
  const conditions = isESM ? esmConditions : cjsConditions;
  const importAttributes = attributes ?? (isESM ? {} : undefined);
  const builtinResolutions = new Map<string, string>();

  function defaultResolve(spec, context) {
    const nextConditions = context.conditions;
    if (nextConditions !== undefined && nextConditions !== conditions && !Array.isArray(nextConditions)) {
      throw $ERR_INVALID_ARG_VALUE("context.conditions", nextConditions, "expected an array");
    }
    if (isESM && spec.slice(0, 5).toLowerCase() === "data:") return { __proto__: null, url: new URL(spec).href };
    if (nativeVirtualSpecifier(spec) !== undefined) return { __proto__: null, url: spec, format: "builtin" };
    const parent = context.parentURL ?? referrer;
    const nativeParent = nativeVirtualSpecifier(parent) ?? parent;
    const directBuiltin = nativeBuiltinSpecifier(spec);
    const nativeURL =
      spec.startsWith("bun-builtin:") && directBuiltin !== undefined
        ? directBuiltin
        : nativeDefaultResolve(spec, nativeParent, isESM, isUserRequireResolve, nextConditions);
    // Native plugins may use our URL scheme names as their own namespaces.
    if (nativeURL.startsWith("bun-virtual:") || nativeURL.startsWith("bun-builtin:")) {
      return { __proto__: null, url: virtualModuleURL(nativeURL), format: "builtin" };
    }
    const builtin = nativeBuiltinSpecifier(nativeURL);
    if (builtin !== undefined) {
      let url;
      if (builtin.startsWith("node:")) {
        url = directBuiltin === builtin ? (spec.startsWith("node:") ? spec : "node:" + spec) : builtin;
      } else if (
        !spec.includes(":") &&
        builtin !== "bun" &&
        !spec.startsWith("internal/") &&
        !builtin.startsWith("internal:")
      ) {
        url = nativeDefaultResolve(spec, nativeParent, isESM, isUserRequireResolve, nextConditions, true);
      }
      url ??= builtin === "bun:ffi" ? "bun-builtin:ffi" : convertCJSFilenameToURL(builtin);
      if (url.startsWith("bun-builtin:")) nativeURLs.set(url, builtin);
      builtinResolutions.set(url, builtin);
      return {
        __proto__: null,
        url,
        format: url.startsWith("node:")
          ? isESM !== spec.startsWith("node:")
            ? "builtin"
            : undefined
          : url.startsWith("file:")
            ? isESM
              ? defaultEsmFormat(url)
              : undefined
            : "builtin",
      };
    }
    const url = nativeURL;
    const resolvedURL = convertCJSFilenameToURL(url);
    return {
      __proto__: null,
      url: resolvedURL,
      format: resolvedURL.startsWith("bun-virtual:")
        ? "builtin"
        : isESM && !resolvedURL.startsWith("node:")
          ? defaultEsmFormat(url)
          : undefined,
    };
  }

  const result = resolveWithHooks(specifier, parentURL, importAttributes, conditions, defaultResolve);
  const { url, format, importAttributes: resultAttributes } = result;
  const builtin = builtinResolutions.get(url);
  if (builtin !== undefined && url.startsWith("file:")) builtinURLs.set(url, builtin);
  if (!resolveOnly && !isUserRequireResolve) {
    const key = isESM ? url : convertCJSFilenameToURL(convertURLToCJSFilename(url));
    resolvedContexts.set(key, {
      url,
      format,
      importAttributes: resultAttributes ?? importAttributes,
      attributesKnown: attributes !== undefined || resultAttributes !== undefined,
      attributesOverridden: resultAttributes !== undefined,
      isESM,
      builtin,
    });
    updateNativeHooksCounts();
  }
  if (isUserRequireResolve && url.startsWith("node:") && isBuiltin(url)) {
    // require.resolve() reports redirected builtins by their bare id, like
    // Node's convertURLToCJSFilename().
    return url === specifier || !isBuiltin(url.slice(5)) ? url : url.slice(5);
  }
  return isESM ? url : convertURLToCJSFilename(url);
}

function defaultLoadImplCJS(filename, format) {
  switch (format) {
    case undefined:
    case null:
    case "module":
    case "commonjs":
    case "json":
    case "module-typescript":
    case "commonjs-typescript":
    case "typescript": {
      return require("node:fs").readFileSync(filename, "utf8");
    }
    case "builtin":
      return null;
    default:
      throw $ERR_UNKNOWN_MODULE_FORMAT(format, convertCJSFilenameToURL(filename));
  }
}

function getResolvedImportAttributes(path) {
  return resolvedContexts.get(convertCJSFilenameToURL(path))?.importAttributes;
}

function getResolvedBuiltin(path) {
  const url = convertCJSFilenameToURL(path);
  return (
    resolvedContexts.get(url)?.builtin ??
    builtinURLs.get(url) ??
    nativeURLs.get(url) ??
    (path.startsWith("node:") ? nativeBuiltinSpecifier(path) : undefined)
  );
}

// Node 24 lib/internal/modules/esm/assert.js validates only the default loader;
// a short-circuiting user load hook owns its own attribute contract.
function validateLoadAttributes(url, format, attributes, requireType) {
  for (const key of Object.keys(attributes)) {
    if (key !== "type") {
      throw $ERR_IMPORT_ATTRIBUTE_UNSUPPORTED(
        `Import attribute "${key}" with value "${attributes[key]}" is not supported in ${url}`,
      );
    }
  }
  const expectsJSON = format === "json";
  if (!expectsJSON && format !== "builtin" && format !== "commonjs" && format !== "module" && format !== "wasm") return;
  if (expectsJSON && attributes.type === "json") return;
  if (!Object.hasOwn(attributes, "type")) {
    if (expectsJSON && requireType)
      throw $ERR_IMPORT_ATTRIBUTE_MISSING(`Module "${url}" needs an import attribute of "type: json"`);
    return;
  }
  const type = attributes.type;
  validateString(type, "type");
  if (type !== "json") {
    throw $ERR_IMPORT_ATTRIBUTE_UNSUPPORTED(`Import attribute "type" with value "${type}" is not supported in ${url}`);
  }
  throw $ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE(`Module "${url}" is not of type "${type}"`);
}

function discardResolvedContext(path) {
  if (resolvedContexts.delete(convertCJSFilenameToURL(path))) updateNativeHooksCounts();
}

function hexValue(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  const lower = byte | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

function decodeDataURLBase64(bytes, url) {
  // WHATWG forgiving-base64: Buffer's decoder alone also accepts invalid punctuation and padding.
  const data = bytes.toString("latin1").replace(/[\t\n\f\r ]/g, "");
  let length = data.length;
  if (length % 4 === 0 && data[length - 1] === "=") {
    length--;
    if (data[length - 1] === "=") length--;
  }
  if (length % 4 === 1 || /[^+/0-9A-Za-z]/.test(data.slice(0, length))) throw $ERR_INVALID_URL(url);
  return Buffer.from(data, "base64");
}

// Called by the native module loader when any hooks are registered, right
// before it would read the module off disk. Returns `undefined` to let the
// native loader proceed, or `{ source, loader, moduleType }` overrides.
function runLoadHooksBun(path, loaderHint, moduleTypeHint, isCommonJSRequire) {
  const key = convertCJSFilenameToURL(path);
  const resolved = resolvedContexts.get(key);
  if (resolvedContexts.delete(key)) updateNativeHooksCounts();
  const url = resolved?.url ?? key;
  const builtin = resolved?.builtin ?? builtinURLs.get(url) ?? nativeVirtualSpecifier(url);
  if (resolved?.isESM) isCommonJSRequire = false;
  let format: string | null | undefined = resolved?.format;
  if (format === undefined && isCommonJSRequire && url.startsWith("node:")) {
    format = "builtin";
  }
  if (format === undefined && isCommonJSRequire) {
    format = defaultEsmFormat(url) ?? (convertURLToCJSFilename(url).endsWith(".ts") ? "typescript" : undefined);
  }
  if (format === undefined && !isCommonJSRequire && !url.startsWith("node:") && !url.startsWith("data:")) {
    format =
      moduleTypeHint === MODULE_TYPE_ESM && url.endsWith(".js")
        ? "module"
        : moduleTypeHint === MODULE_TYPE_CJS && url.endsWith(".js")
          ? "commonjs"
          : defaultEsmFormat(path);
  }
  const conditions = isCommonJSRequire ? cjsConditions : esmConditions;
  const importAttributes = resolved?.importAttributes ?? (isCommonJSRequire ? undefined : {});
  const attributesKnown = resolved?.attributesKnown ?? false;

  function validateDefaultAttributes(url, format, context) {
    const attributes = context.importAttributes ?? {};
    // Static input attributes are unavailable at JSC's resolve callback. A
    // supplied resolve/load context still has an enforceable attribute contract.
    if (attributesKnown || attributes !== importAttributes || Object.keys(attributes).length > 0)
      validateLoadAttributes(
        url,
        format,
        attributes,
        resolved?.attributesOverridden || attributes !== importAttributes,
      );
  }

  function defaultLoad(urlFromHook, context) {
    if (builtin && urlFromHook === url) {
      if (!isCommonJSRequire) validateDefaultAttributes(urlFromHook, "builtin", context);
      return { format: "builtin", source: null };
    }
    const format = isCommonJSRequire ? context.format : (context.format ?? defaultEsmFormat(urlFromHook));
    const filenameFromHook = convertURLToCJSFilename(urlFromHook);
    if (urlFromHook.startsWith("data:")) {
      // Node serializes the entire data URL without its fragment, retaining the query as source.
      const serialized = urlFromHook.split("#", 1)[0];
      const comma = serialized.indexOf(",");
      if (comma < 0) throw $ERR_INVALID_URL(urlFromHook);
      const header = serialized.slice(5, comma);
      const payload = serialized.slice(comma + 1);
      const bytes = Buffer.from(payload, "utf8");
      let length = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 37 && i + 2 < bytes.length) {
          const high = hexValue(bytes[i + 1]);
          const low = hexValue(bytes[i + 2]);
          if (high !== -1 && low !== -1) {
            bytes[length++] = (high << 4) | low;
            i += 2;
            continue;
          }
        }
        bytes[length++] = bytes[i];
      }
      const decoded = bytes.subarray(0, length);
      const source = /; *base64[\t\n\f\r ]*$/i.test(header) ? decodeDataURLBase64(decoded, urlFromHook) : decoded;
      const finalFormat = format ?? defaultEsmFormat(urlFromHook);
      if (!isCommonJSRequire) validateDefaultAttributes(urlFromHook, finalFormat, context);
      return isCommonJSRequire
        ? { source: source.toString(), format: finalFormat }
        : { format: finalFormat, responseURL: urlFromHook, source };
    }
    if (isCommonJSRequire) {
      const source = defaultLoadImplCJS(filenameFromHook, format);
      return { source, format };
    }
    // ES module pipeline.
    if (format === "builtin" || urlFromHook.startsWith("node:")) {
      validateDefaultAttributes(urlFromHook, format, context);
      return { format, responseURL: urlFromHook, source: null };
    }
    const source = require("node:fs").readFileSync(filenameFromHook);
    let finalFormat = format;
    if (finalFormat == null) {
      decoder ??= new TextDecoder();
      let text = decoder.decode(source);
      const typescript = filenameFromHook.endsWith(".ts");
      if (typescript) {
        typeStripper ??= new Bun.Transpiler({ loader: "ts", target: "bun" });
        text = typeStripper.transformSync(text);
      }
      finalFormat = containsModuleSyntax(text) ? "module" : "commonjs";
      if (typescript) finalFormat += "-typescript";
    }
    validateDefaultAttributes(urlFromHook, finalFormat, context);
    return { format: finalFormat, responseURL: urlFromHook, source };
  }

  if (loadHooks.length === 0) {
    const nativeFormat = defaultEsmFormat(url);
    if (format == null || format === nativeFormat || (format === "typescript" && nativeFormat == null)) {
      if (!isCommonJSRequire) validateDefaultAttributes(url, format ?? nativeFormat, { importAttributes });
      return undefined;
    }
  }

  const result = loadWithHooks(
    url,
    format,
    importAttributes,
    conditions,
    defaultLoad,
    isCommonJSRequire ? validateLoadStrict : validateLoadSloppy,
  );

  let { source } = result;
  const finalFormat = result.format;
  if (finalFormat === "wasm") {
    if (isCommonJSRequire) throw $ERR_UNKNOWN_MODULE_FORMAT(finalFormat, url);
    return { source, loader: LOADER_WASM, moduleType: MODULE_TYPE_UNKNOWN };
  }
  if (source == null) {
    // builtin, addon, or the ESM commonjs delegation quirk: load natively.
    return undefined;
  }
  if (typeof source !== "string") {
    throw $ERR_UNKNOWN_MODULE_FORMAT(finalFormat, url);
  }

  switch (finalFormat) {
    case undefined:
    case null:
      return {
        source,
        loader: loaderHint === LOADER_NONE ? LOADER_JS : loaderHint,
        moduleType: MODULE_TYPE_UNKNOWN,
      };
    case "module":
      return { source, loader: LOADER_JS, moduleType: MODULE_TYPE_ESM };
    case "commonjs":
      containsModuleSyntax(source, true);
      return { source, loader: LOADER_JS, moduleType: MODULE_TYPE_CJS };
    case "json":
      return { source, loader: LOADER_JSON, moduleType: MODULE_TYPE_UNKNOWN };
    case "module-typescript":
      return { source, loader: LOADER_TS, moduleType: MODULE_TYPE_ESM };
    case "commonjs-typescript":
      return { source, loader: LOADER_TS, moduleType: MODULE_TYPE_CJS };
    case "typescript":
      return { source, loader: LOADER_TS, moduleType: MODULE_TYPE_UNKNOWN };
    case "builtin":
    case "addon":
      return undefined;
    default:
      throw $ERR_UNKNOWN_MODULE_FORMAT(finalFormat, url);
  }
}

export default {
  registerHooks,
  runResolveHooksBun,
  runLoadHooksBun,
  discardResolvedContext,
  getResolvedImportAttributes,
  getResolvedBuiltin,
};
