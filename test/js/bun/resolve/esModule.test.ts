import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import * as Self from "./esModule.test.ts";

test("an imported namespace has no inherited or writable __esModule marker", () => {
  expect(Object.getPrototypeOf(Self)).toBeNull();
  expect("__esModule" in Self).toBe(false);
  expect(Object.hasOwn(Self, "__esModule")).toBe(false);
  expect(Object.getOwnPropertyDescriptor(Self, "__esModule")).toBeUndefined();
  expect(Reflect.ownKeys(Self)).toEqual([Symbol.toStringTag]);
  expect(Reflect.set(Self, "__esModule", true)).toBe(false);
  expect(Reflect.defineProperty(Self, "__esModule", { value: true })).toBe(false);
  expect(require("./esModule.test.ts")).toBe(Self);
  expect(Self.__esModule).toBeUndefined();
});

for (const order of ["import-first", "require-first", "cache-first"]) {
  test.concurrent(`require(esm) marker reflection and live bindings (${order})`, async () => {
    using dir = tempDir("namespace-marker", {
      "default.mjs": "export default {}; export let value = 1; export function bump() { value++; }",
      "none.mjs": "export const value = 1;",
      "false.mjs": "export const __esModule = false; export default 1;",
      "undefined.mjs": "export const __esModule = undefined; export default 1;",
      "true.mjs": "export const __esModule = true; export default 1;",
      "sorted.mjs": "export default 1; export const Alpha = 1, _a = 2, zzz = 3;",
      "leaf.mjs": "export const value = 'synthetic-ok';",
      "alias.mjs": "import * as z from './leaf.mjs'; export * from './leaf.mjs'; export { z, z as default };",
      "entry.mjs": `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function marker(ns, present, value) {
  assert.equal(Object.getPrototypeOf(ns), null);
  assert.equal(Object.isExtensible(ns), false);
  assert.equal('__esModule' in ns, present);
  assert.equal(Object.hasOwn(ns, '__esModule'), present);
  assert.equal(Object.prototype.hasOwnProperty.call(ns, '__esModule'), present);
  assert.deepEqual(Object.getOwnPropertyDescriptor(ns, '__esModule'), present ? {
    value, writable: true, enumerable: true, configurable: false,
  } : undefined);
  assert.equal(Reflect.set(ns, '__esModule', true), false);
  assert.equal(Reflect.set(ns, '__esModule', value), false);
  assert.equal(Reflect.defineProperty(ns, '__esModule', { value }), present);
  for (const descriptor of [{ value: {} }, { writable: false }, { enumerable: false }, { configurable: true }, { get() {} }])
    assert.equal(Reflect.defineProperty(ns, '__esModule', descriptor), false);
  assert.equal(Reflect.deleteProperty(ns, '__esModule'), !present);
}
for (const [name, hasDefault, explicit, value] of [
  ['default', true, false, undefined], ['none', false, false, undefined],
  ['false', true, true, false], ['undefined', true, true, undefined], ['true', true, true, true],
]) {
  let imported, required;
  if (${JSON.stringify(order)} !== 'require-first') {
    imported = await import('./' + name + '.mjs');
    marker(imported, explicit, value);
    if (${JSON.stringify(order)} === 'cache-first') void require.cache[require.resolve('./' + name + '.mjs')];
    required = require('./' + name + '.mjs');
  } else {
    required = require('./' + name + '.mjs');
    imported = await import('./' + name + '.mjs');
  }
  marker(imported, explicit, value);
  marker(required, explicit || hasDefault, explicit ? value : hasDefault ? true : undefined);
  assert.equal(imported === required, explicit || !hasDefault);
  assert.equal(require('./' + name + '.mjs'), required);
  delete require.cache[require.resolve('./' + name + '.mjs')];
  const reloaded = require('./' + name + '.mjs');
  // Bun also evicts the ESM registry on cache deletion; only check the added facade's identity.
  if (hasDefault && !explicit) assert.notEqual(reloaded, required);
  marker(reloaded, explicit || hasDefault, explicit ? value : hasDefault ? true : undefined);
  if (name === 'default') {
    imported.bump();
    assert.equal(required.value, 2);
    assert.equal(({ ...required }).__esModule, true);
    assert.equal(Object.assign({}, required).__esModule, true);
    assert.equal(JSON.parse(JSON.stringify(required)).__esModule, true);
    globalThis.Bun?.gc(true);
    assert.equal(required.value, imported.value);
  }
}
const sorted = require('./sorted.mjs');
assert.deepEqual(Reflect.ownKeys(sorted), ['Alpha', '__esModule', '_a', 'default', 'zzz', Symbol.toStringTag]);
assert.deepEqual(Object.keys(sorted), ['Alpha', '__esModule', '_a', 'default', 'zzz']);
const alias = await import('./alias.mjs');
const interop = alias.default && typeof alias.default === 'object' && '__esModule' in alias.default ? alias.default : alias;
assert.equal(interop.z.value, 'synthetic-ok');
assert.equal(require('./alias.mjs').__esModule, true);
assert.equal('__esModule' in alias, false);
console.log('ok');
`,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "entry.mjs"],
      cwd: String(dir),
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
  });
}

test.concurrent("CommonJS-as-ESM namespaces preserve explicit markers and own-key reflection", async () => {
  using dir = tempDir("cjs-namespace-marker", {
    "plain.cjs": "exports.value = 1;",
    "true.cjs": "Object.defineProperty(exports, '__esModule', { value: true }); exports.value = 1;",
    "false.cjs": "exports.__esModule = false; exports.value = 1;",
    "undefined.cjs": "exports.__esModule = undefined; exports.value = 1;",
    "collision.cjs": "exports['module.exports'] = 3; exports.value = 1;",
    "forwarded.mjs": "export default 'kept'; export const value = 1;",
    "forwarder.cjs": "module.exports = require('./forwarded.mjs');",
    "entry.mjs": `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const [name, present, value] of [
  ['plain', false], ['true', true, true], ['false', true, false], ['undefined', true, undefined], ['collision', false],
]) {
  const ns = await import('./' + name + '.cjs');
  assert.equal(Object.getPrototypeOf(ns), null);
  assert.equal(Object.isExtensible(ns), false);
  assert.equal('__esModule' in ns, present);
  assert.equal(Object.hasOwn(ns, '__esModule'), present);
  assert.equal(Object.prototype.hasOwnProperty.call(ns, '__esModule'), present);
  assert.deepEqual(Object.getOwnPropertyDescriptor(ns, '__esModule'), present ? {
    value, writable: true, enumerable: true, configurable: false,
  } : undefined);
  assert.deepEqual(Reflect.ownKeys(ns), [...(present ? ['__esModule'] : []), 'default', 'module.exports', 'value', Symbol.toStringTag]);
  assert.equal(ns['module.exports'], require('./' + name + '.cjs'));
  assert.equal(Reflect.set(ns, '__esModule', true), false);
}
const forwarded = await import('./forwarder.cjs');
assert.equal(forwarded.default, require('./forwarder.cjs'));
assert.equal(forwarded.default.default, 'kept');
assert.equal(forwarded['module.exports'], forwarded.default);
console.log('ok');
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "entry.mjs"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
});
