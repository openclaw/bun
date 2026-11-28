import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

// A decorated private member is extracted from the class. Writes other than
// `this.#p = v` must stay assignment targets. oven-sh/bun#47043.
const source = `
let accessorSets = 0;
function fieldDec() {}
function accessorDec(target) {
  const { get, set } = target;
  return {
    get() {
      return get.call(this);
    },
    set(v) {
      accessorSets++;
      set.call(this, v);
    },
  };
}

class Field {
  @fieldDec #p = 1;
  plain() {
    this.#p = 5;
    return this.#p;
  }
  add() {
    return this.#p += 1;
  }
  post() {
    return this.#p++;
  }
  pre() {
    return ++this.#p;
  }
  obj(arr) {
    ({ 0: this.#p } = arr);
    return this.#p;
  }
  objDefault(arr) {
    ({ 0: this.#p = 9 } = arr);
    return this.#p;
  }
  arr(arr) {
    [this.#p] = arr;
    return this.#p;
  }
  rest(arr) {
    [...this.#p] = arr;
    return this.#p;
  }
  of(arr) {
    for (this.#p of arr) {
    }
    return this.#p;
  }
  inn(obj) {
    for (this.#p in obj) {
    }
    return this.#p;
  }
  and() {
    return this.#p &&= 6;
  }
  orKeep() {
    return this.#p ||= 9;
  }
  nullish() {
    this.#p = null;
    this.#p ??= 4;
    return this.#p;
  }
  nullishKeep() {
    return this.#p ??= 9;
  }
}

class Mixed {
  @fieldDec #d = 1;
  #u = 2;
  run() {
    this.#u += 1;
    return this.#u;
  }
}

function methodDec() {}
class Method {
  @methodDec #m() {
    return 1;
  }
  call() {
    return this.#m();
  }
  or() {
    return typeof (this.#m ||= 2);
  }
  thru(f) {
    return typeof (f().#m ||= 2);
  }
  add() {
    try {
      this.#m += 1;
      return "no-throw";
    } catch (e) {
      return e.name;
    }
  }
}

class Accessor {
  @accessorDec accessor #p = 1;
  add() {
    return this.#p += 1;
  }
  obj(arr) {
    ({ 0: this.#p } = arr);
    return this.#p;
  }
}

class Both {
  @fieldDec #q = 1;
  @fieldDec #p = 10;
  add() {
    this.#p += this.#q;
    return this.#p;
  }
}

const out = {
  plain: new Field().plain(),
  add: new Field().add(),
  post: new Field().post(),
  pre: new Field().pre(),
  obj: new Field().obj(["a"]),
  objDefaultMissing: new Field().objDefault([]),
  objDefaultPresent: new Field().objDefault(["b"]),
  arr: new Field().arr(["c"]),
  rest: new Field().rest([1, 2]),
  of: new Field().of([7, 8]),
  in: new Field().inn({ z: 1, y: 2 }),
  and: new Field().and(),
  orKeep: new Field().orKeep(),
  nullish: new Field().nullish(),
  nullishKeep: new Field().nullishKeep(),
  mixed: new Mixed().run(),
  methodCall: new Method().call(),
  methodOr: new Method().or(),
  methodThru: new Method().thru(() => new Method()),
  methodAdd: new Method().add(),
  accessorAdd: new Accessor().add(),
  accessorObj: new Accessor().obj(["d"]),
  accessorSets,
  both: new Both().add(),
};
console.log(JSON.stringify(out));
`;

test("decorated private fields stay assignable", async () => {
  using dir = tempDir("private-decorator-assign", {
    "assign.js": source,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "assign.js"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  expect(stdout).toBe(
    JSON.stringify({
      plain: 5,
      add: 2,
      post: 1,
      pre: 2,
      obj: "a",
      objDefaultMissing: 9,
      objDefaultPresent: "b",
      arr: "c",
      rest: [1, 2],
      of: 8,
      in: "y",
      and: 6,
      orKeep: 1,
      nullish: 4,
      nullishKeep: 1,
      mixed: 3,
      methodCall: 1,
      methodOr: "function",
      methodThru: "function",
      methodAdd: "TypeError",
      accessorAdd: 2,
      accessorObj: "d",
      // Initializers use __privateAdd, so only += and the destructuring
      // assignment call the decorated setter.
      accessorSets: 2,
      both: 11,
    }) + "\n",
  );
  expect(exitCode).toBe(0);
});
