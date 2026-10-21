export {};
declare const console: { log(message: string): void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function rejects(run: () => unknown, message: string) {
  let caught = false;
  try {
    run();
  } catch (error) {
    caught = error instanceof TypeError;
  }
  assert(caught, message);
}
function identity(values: string[]): string[] {
  return values;
}
function first(values: string[]): string {
  return values[0];
}
function join(values: string[]): string {
  return values.join(",");
}
function write(values: string[]) {
  values[0] = "changed";
  values.push("tail");
}
function collect(values: string[]): string[] {
  return [...values];
}
function iterateFirst(values: string[]): string {
  for (const value of values) return value;
  return "";
}

const transparent = new Proxy(["browser"], {});
assert(identity(transparent) === transparent, "proxy identity");
assert(first(transparent) === "browser", "typed indexed read");
assert(join(transparent) === "browser", "typed method call");
assert(collect(transparent).join(",") === "browser", "typed iteration");
assert(Array.isArray(transparent), "Array.isArray");
assert(join(new Proxy(transparent, {})) === "browser", "nested proxy");
const invokeIdentity = (value: unknown) => Reflect.apply(identity, undefined, [value]);
assert(invokeIdentity(transparent) === transparent, "generic entry accepts array proxy");
rejects(() => invokeIdentity(new Proxy({ 0: "object", length: 1 }, {})), "same entry rejects non-array proxy");

const changes: string[] = [];
const target = ["old"];
const trapping = new Proxy(target, {
  get(array, key, receiver) {
    changes.push("get:" + String(key));
    return Reflect.get(array, key, receiver);
  },
  set(array, key, value, receiver) {
    changes.push("set:" + String(key));
    return Reflect.set(array, key, value, receiver);
  },
});
write(trapping);
assert(target.join(",") === "changed,tail", "target mutation");
assert(changes.includes("set:0") && changes.includes("set:1") && changes.includes("set:length"), "mutation traps");
assert(join(trapping) === "changed,tail", "method traps preserve receiver");
assert(changes.includes("get:join") && changes.includes("get:0"), "read traps");

const virtual = new Proxy(["real"], {
  get(array, key, receiver) {
    if (key === "length") return 2;
    if (key === "1") return "virtual";
    return Reflect.get(array, key, receiver);
  },
});
assert(collect(virtual).join(",") === "real,virtual", "virtual indexed data");
const customIterator = new Proxy(["ignored"], {
  get(array, key, receiver) {
    if (key === Symbol.iterator)
      return function* () {
        yield "iterated";
      };
    return Reflect.get(array, key, receiver);
  },
});
assert(collect(customIterator).join(",") === "iterated", "custom iterator trap");

const wrong = new Proxy(["valid"], {
  get(array, key, receiver) {
    return key === "0" ? 42 : Reflect.get(array, key, receiver);
  },
});
rejects(() => first(wrong), "typed read must reject wrong element");
rejects(() => iterateFirst(wrong), "typed iteration must reject wrong element");
rejects(() => first(collect(wrong)), "copied elements must still be checked on access");
rejects(() => wrong.map(value => value.toUpperCase()), "typed callback must reject wrong element");

let created: string[] | undefined;
const speciesInput = ["species"];
Object.defineProperty(speciesInput, "constructor", {
  value: {
    [Symbol.species]: function (length: number) {
      created = new Proxy(new Array<string>(length), {});
      return created;
    },
  },
});
function map(values: string[]): string[] {
  return values.map(value => value.toUpperCase());
}
const mapped = map(new Proxy(speciesInput, {}));
assert(mapped === created && first(mapped) === "SPECIES", "species proxy identity");

const revocable = Proxy.revocable(["revoked"], {});
assert(identity(revocable.proxy) === revocable.proxy, "revocable identity");
revocable.revoke();
rejects(() => identity(revocable.proxy), "same entry rejects revoked proxy");
rejects(() => first(revocable.proxy), "revoked read");
rejects(() => Array.isArray(revocable.proxy), "revoked Array.isArray");
function revokeAndRead(values: string[], revoke: () => void): string {
  revoke();
  return values[0];
}
const revokedInside = Proxy.revocable(["revoked inside"], {});
rejects(() => revokeAndRead(revokedInside.proxy, revokedInside.revoke), "revocation after typed admission");

const fresh = ["native"];
fresh.push("fast");
assert(first(fresh) === "native" && fresh.join(",") === "native,fast", "fresh native array");
function choose(useProxy: boolean): string[] {
  const local = ["native"];
  let selected = local;
  if (useProxy) selected = transparent;
  selected[0] = "assigned";
  return selected;
}
assert(choose(false).join(",") === "assigned", "mutable native assignment");
assert(choose(true) === transparent && first(transparent) === "assigned", "native/proxy control-flow merge");
console.log("proxy-array behavior passed");
