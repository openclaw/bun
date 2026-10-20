// Object.entries iteration still yields pairs after an indexed accessor changes array storage.
declare const console: { log(...values: unknown[]): void };
const values: Record<string, number> = { a: 1, b: 2 };
for (const [key, value] of Object.entries(values)) console.log("before", key, value);
class IndexedPrototypeArray<T> extends Array<T> {}
Object.defineProperty(IndexedPrototypeArray.prototype, "3", { get() { return 3; }, configurable: true });
console.log("subclass length", new IndexedPrototypeArray<number>().length);
console.log("entries", JSON.stringify(Object.entries(values)));
for (const [key, value] of Object.entries(values)) console.log("after", key, value);
