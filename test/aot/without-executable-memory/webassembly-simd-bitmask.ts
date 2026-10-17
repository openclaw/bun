// Keep module bytes as base64 so the AOT image compiles them ahead of time.
const cases = [
  {
    name: "i8x16",
    laneBytes: 1,
    lanes: 16,
    base64: "AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAQcQAgNydW4AAAZtZW1vcnkCAAoMAQoAIAD9AAQA/WQL",
  },
  {
    name: "i16x8",
    laneBytes: 2,
    lanes: 8,
    base64: "AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAQcQAgNydW4AAAZtZW1vcnkCAAoNAQsAIAD9AAQA/YQBCw==",
  },
  {
    name: "i32x4",
    laneBytes: 4,
    lanes: 4,
    base64: "AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAQcQAgNydW4AAAZtZW1vcnkCAAoNAQsAIAD9AAQA/aQBCw==",
  },
  {
    name: "i64x2",
    laneBytes: 8,
    lanes: 2,
    base64: "AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAQcQAgNydW4AAAZtZW1vcnkCAAoNAQsAIAD9AAQA/cQBCw==",
  },
];

for (const testCase of cases) {
  const bytes = Buffer.from(testCase.base64, "base64");
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const memory = instance.exports.memory;
  const run = instance.exports.run;
  if (!(memory instanceof WebAssembly.Memory) || typeof run !== "function") {
    throw new Error(`${testCase.name}: missing exports`);
  }
  const input = new Uint8Array(memory.buffer, 0, 16);
  const all = (1 << testCase.lanes) - 1;
  const masks = [0, all, 0xaaaa & all, 0x5555 & all];
  for (let lane = 0; lane < testCase.lanes; lane++) masks.push(1 << lane);
  for (const expected of masks) {
    input.fill(0);
    for (let lane = 0; lane < testCase.lanes; lane++) {
      // Values reach Wasm through mutable linear memory, not compile-time constants.
      input[(lane + 1) * testCase.laneBytes - 1] = expected & (1 << lane) ? 0x80 : 0x7f;
    }
    const actual = run(0);
    if (actual !== expected) {
      throw new Error(`${testCase.name}: expected ${expected}, got ${actual}`);
    }
  }
}
console.log("Wasm SIMD bitmasks OK");
