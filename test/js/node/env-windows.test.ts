import { expect, jest, test } from "bun:test";
import { bunEnv, bunExe, isWindows } from "harness";
import { windowsEnv } from "../../../src/js/builtins/ProcessObjectInternals";

// Run the actual Windows proxy on every platform; only its native callbacks are substituted.
function createWindowsEnv() {
  const internal = { KEY: "before" };
  const shared = { KEY: "before" };
  let promoted = false;
  const edit = jest.fn();
  const coerce = jest.fn((_key, value) => `${value}`);
  const env = windowsEnv(internal, ["KEY"], edit, coerce, jest.fn(), () => (promoted ? shared : undefined));
  return { env, internal, shared, edit, coerce, promote: () => (promoted = true) };
}

const writes = {
  set: (env, key, value) => Reflect.set(env, key, value),
  defineProperty: (env, key, value) =>
    Reflect.defineProperty(env, key, { value, configurable: true, enumerable: true, writable: true }),
};

for (const [name, write] of Object.entries(writes)) {
  test(`windowsEnv ${name} uses the store promoted during value coercion`, () => {
    const { env, internal, shared, edit, coerce, promote } = createWindowsEnv();
    const toString = jest.fn(() => {
      promote();
      return "after";
    });
    expect(write(env, "KEY", { toString })).toBe(true);
    expect({ cached: env.KEY, shared: shared.KEY, old: internal.KEY }).toEqual({
      cached: "after",
      shared: "after",
      old: "before",
    });
    expect(toString).toHaveBeenCalledTimes(1);
    expect(coerce).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });

  test(`windowsEnv ${name} preserves symbol errors before coercion`, () => {
    const { env, shared, edit, coerce, promote } = createWindowsEnv();
    const toString = jest.fn(promote);
    expect(() => write(env, Symbol("key"), { toString })).toThrow(
      new TypeError("Cannot convert a Symbol value to a string"),
    );
    expect(() => write(env, "KEY", Symbol("value"))).toThrow(
      new TypeError("Cannot convert a Symbol value to a string"),
    );
    expect(toString).not.toHaveBeenCalled();
    expect(coerce).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(shared.KEY).toBe("before");
  });

  test(`windowsEnv ${name} does not write when coercion promotes then throws`, () => {
    const { env, internal, shared, edit, promote } = createWindowsEnv();
    const error = new Error("coercion failed");
    expect(() =>
      write(env, "KEY", {
        toString() {
          promote();
          throw error;
        },
      }),
    ).toThrow(error);
    expect([env.KEY, internal.KEY, shared.KEY]).toEqual(["before", "before", "before"]);
    expect(edit).not.toHaveBeenCalled();
  });

  test(`windowsEnv ${name} coerces an empty-key value before ignoring the write`, () => {
    const { env, edit, coerce } = createWindowsEnv();
    const toString = jest.fn(() => "ignored");
    expect(write(env, "", { toString })).toBe(true);
    expect(toString).toHaveBeenCalledTimes(1);
    expect(coerce).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(env, "")).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });
}

test("windowsEnv defineProperty observes promotion from a descriptor value getter", () => {
  const { env, internal, shared, edit, promote } = createWindowsEnv();
  const getter = jest.fn(() => {
    promote();
    return "after";
  });
  Object.defineProperty(env, "KEY", {
    get value() {
      return getter();
    },
    configurable: true,
    enumerable: true,
    writable: true,
  });
  expect([env.KEY, shared.KEY, internal.KEY]).toEqual(["after", "after", "before"]);
  expect(getter).toHaveBeenCalledTimes(1);
  expect(edit).not.toHaveBeenCalled();
});

test("windowsEnv delete observes promotion from key coercion before the trap", () => {
  const { env, internal, shared, edit, promote } = createWindowsEnv();
  const key = {
    toString() {
      promote();
      return "KEY";
    },
  };
  // @ts-expect-error ToPropertyKey runs before the proxy's deleteProperty trap.
  expect(Reflect.deleteProperty(env, key)).toBe(true);
  expect([env.KEY, shared.KEY, internal.KEY]).toEqual([undefined, undefined, "before"]);
  expect(edit).not.toHaveBeenCalled();
});

test.if(isWindows)("process.env is case insensitive on windows", () => {
  const keys = Object.keys(process.env);
  // this should have at least one character that is lowercase
  // it is likely that PATH will be 'Path', and also stuff like 'WindowsLibPath' and so on.
  // but not guaranteed, so we just check that there is at least one of each case
  expect(
    keys
      .join("")
      .split("")
      .some(c => c.toUpperCase() !== c),
  ).toBe(true);
  expect(
    keys
      .join("")
      .split("")
      .some(c => c.toLowerCase() !== c),
  ).toBe(true);
  expect(process.env.path).toBe(process.env.PATH!);
  expect(process.env.pAtH).toBe(process.env.PATH!);

  expect(process.env.doesntexistahahahahaha).toBeUndefined();
  // @ts-expect-error
  process.env.doesntExistAHaHaHaHaHa = true;
  expect(process.env.doesntexistahahahahaha).toBe("true");
  expect(process.env.doesntexistahahahahaha).toBe("true");
  expect(process.env.doesnteXISTahahahahaha).toBe("true");
  expect(Object.keys(process.env).pop()).toBe("doesntExistAHaHaHaHaHa");
  delete process.env.DOESNTEXISTAHAHAHAHAHA;
  expect(process.env.doesntexistahahahahaha).toBeUndefined();
  expect(Object.keys(process.env)).not.toInclude("doesntExistAHaHaHaHaHa");
});

for (const [name, write] of Object.entries(writes)) {
  test(`windowsEnv ${name} makes a previously absent native accessor enumerable`, () => {
    const internal = {};
    let value;
    const get = () => value;
    const set = next => (value = next);
    Object.defineProperty(internal, "TZ", { get, set, configurable: true });
    const env = windowsEnv(
      internal,
      [],
      jest.fn(),
      (_key, next) => `${next}`,
      jest.fn(),
      () => undefined,
    );
    expect(Object.keys(env)).toEqual([]);
    expect(write(env, "tz", "UTC")).toBe(true);
    expect(Object.keys(env)).toEqual(["tz"]);
    expect({ ...env }).toEqual({ tz: "UTC" });
    expect(Object.getOwnPropertyDescriptor(internal, "TZ")).toEqual({
      get,
      set,
      configurable: true,
      enumerable: true,
    });
    expect(write(env, "TZ", "Asia/Tokyo")).toBe(true);
    expect({ ...env }).toEqual({ tz: "Asia/Tokyo" });
  });
}

test.if(isWindows)("new native environment variables survive copies, children, and SHARE_ENV promotion", () => {
  const env = { ...bunEnv };
  const keys = ["TZ", "NODE_TLS_REJECT_UNAUTHORIZED", "BUN_CONFIG_VERBOSE_FETCH"];
  for (const key of Object.keys(env)) if (keys.includes(key.toUpperCase())) delete env[key];
  const result = Bun.spawnSync({
    cmd: [bunExe(), import.meta.dir + "/env-windows-enumeration-fixture.cjs"],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stdout.toString()).toBe("ok\n");
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
