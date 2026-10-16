const { test, expect } = require("bun:test");
const { SourceMap } = require("node:module");
const { bunEnv, bunExe, runtimesWithNode, tempDir } = require("harness");

function checkSourceMapPositions() {
  const assert = require("node:assert/strict");
  const { SourceMap } = require("node:module");
  const named = new SourceMap({
    version: 3,
    file: "app.js",
    sources: ["original.js"],
    sourcesContent: ["function flush() {}"],
    names: ["flush"],
    mappings: "AAAAA",
  });
  assert.deepEqual(named.findEntry(0, 0), {
    generatedLine: 0,
    generatedColumn: 0,
    originalSource: "original.js",
    originalLine: 0,
    originalColumn: 0,
    name: "flush",
  });
  assert.deepEqual(named.findOrigin(1, 1), {
    name: "flush",
    fileName: "original.js",
    lineNumber: 1,
    columnNumber: 1,
  });
  assert.deepEqual(named.findOrigin(1, 5), {
    name: "flush",
    fileName: "original.js",
    lineNumber: 1,
    columnNumber: 5,
  });
  const map = new SourceMap({ version: 3, sources: ["a.ts", "b.ts"], names: [], mappings: "KAAA,IACC;AAAC,GCAE" });
  for (const args of [
    [-1, 0],
    [0, 4],
  ])
    assert.deepEqual(map.findEntry(...args), {});
  for (const args of [
    [0, 0],
    [1, 5],
  ])
    assert.deepEqual(map.findOrigin(...args), {});
  assert.deepEqual(map.findEntry(0, 5), {
    generatedLine: 0,
    generatedColumn: 5,
    originalSource: "a.ts",
    originalLine: 0,
    originalColumn: 0,
    name: undefined,
  });
  assert.deepEqual(map.findEntry(99, 99), {
    generatedLine: 1,
    generatedColumn: 3,
    originalSource: "b.ts",
    originalLine: 1,
    originalColumn: 4,
    name: undefined,
  });
  assert.deepEqual(map.findOrigin(2, 4), {
    name: undefined,
    fileName: "b.ts",
    lineNumber: 2,
    columnNumber: 5,
  });
  assert.deepEqual(map.findOrigin(99, 99), {
    name: undefined,
    fileName: "b.ts",
    lineNumber: 99,
    columnNumber: 100,
  });
  assert.deepEqual(map.findEntry(1, -1), {
    generatedLine: 0,
    generatedColumn: 9,
    originalSource: "a.ts",
    originalLine: 1,
    originalColumn: 1,
    name: undefined,
  });
  assert.deepEqual(map.findOrigin(2, 0), {
    name: undefined,
    fileName: "a.ts",
    lineNumber: 3,
    columnNumber: -8,
  });
  console.log("ok");
}

for (const [name, exe] of runtimesWithNode(24)) {
  test(`SourceMap position lookup agrees with Node (${name})`, async () => {
    await using child = Bun.spawn({
      cmd: [exe, "-e", `(${checkSourceMapPositions.toString()})()`],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
  });
}

test("SourceMap class exists", () => {
  expect(SourceMap).toBeDefined();
  expect(typeof SourceMap).toBe("function");
  expect(SourceMap.name).toBe("SourceMap");
});

test("SourceMap constructor requires payload", () => {
  expect(() => {
    new SourceMap();
  }).toThrowErrorMatchingInlineSnapshot(`"The "payload" argument must be of type object. Received undefined"`);
});

test("SourceMap payload must be an object", () => {
  expect(() => {
    new SourceMap("not an object");
  }).toThrowErrorMatchingInlineSnapshot(
    `"The "payload" argument must be of type object. Received type string ('not an object')"`,
  );
});

test("SourceMap instance has expected methods", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  });

  expect(typeof sourceMap.findOrigin).toBe("function");
  expect(typeof sourceMap.findEntry).toBe("function");
  expect(sourceMap.findOrigin.length).toBe(2);
  expect(sourceMap.findEntry.length).toBe(2);
});

test("SourceMap payload getter", () => {
  const payload = {
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  };
  const sourceMap = new SourceMap(payload);

  expect(sourceMap.payload).toBe(payload);
});

test("SourceMap lineLengths getter", () => {
  const payload = {
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  };
  const lineLengths = [10, 20, 30];
  const sourceMap = new SourceMap(payload, { lineLengths });

  expect(sourceMap.lineLengths).toBe(lineLengths);
});

test("SourceMap lineLengths undefined when not provided", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  });

  expect(sourceMap.lineLengths).toBeUndefined();
});
test("SourceMap findEntry returns mapping data", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  });
  const result = sourceMap.findEntry(0, 0);

  expect(result).toMatchInlineSnapshot(`
    {
      "generatedColumn": 0,
      "generatedLine": 0,
      "name": undefined,
      "originalColumn": 0,
      "originalLine": 0,
      "originalSource": "test.js",
    }
  `);
});

test("SourceMap findOrigin returns origin data", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  });
  const result = sourceMap.findOrigin(1, 1);

  expect(result).toMatchInlineSnapshot(`
    {
      "columnNumber": 1,
      "fileName": "test.js",
      "lineNumber": 1,
      "name": undefined,
    }
  `);
});

test("SourceMap with names returns name property correctly", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    names: ["myFunction", "myVariable"],
    mappings: "AAAAA,CAACC", // Both segments reference names
  });

  const result = sourceMap.findEntry(0, 0);
  const resultWithName = sourceMap.findEntry(0, 6);
  expect(result).toMatchInlineSnapshot(`
    {
      "generatedColumn": 0,
      "generatedLine": 0,
      "name": "myFunction",
      "originalColumn": 0,
      "originalLine": 0,
      "originalSource": "test.js",
    }
  `);
  expect(resultWithName).toMatchInlineSnapshot(`
    {
      "generatedColumn": 1,
      "generatedLine": 0,
      "name": "myVariable",
      "originalColumn": 1,
      "originalLine": 0,
      "originalSource": "test.js",
    }
  `);
});

test("SourceMap without names has undefined name property", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    mappings: "AAAA",
  });

  const result = sourceMap.findEntry(0, 0);
  expect(result).toMatchInlineSnapshot(`
    {
      "generatedColumn": 0,
      "generatedLine": 0,
      "name": undefined,
      "originalColumn": 0,
      "originalLine": 0,
      "originalSource": "test.js",
    }
  `);
});

test("SourceMap with invalid name index has undefined name property", () => {
  const sourceMap = new SourceMap({
    version: 3,
    sources: ["test.js"],
    mappings: "AAAAA,CAACC", // Both segments reference names
  });

  const result = sourceMap.findEntry(0, 0);
  expect(result).toMatchInlineSnapshot(`
    {
      "generatedColumn": 0,
      "generatedLine": 0,
      "name": undefined,
      "originalColumn": 0,
      "originalLine": 0,
      "originalSource": "test.js",
    }
  `);
});

test("SourceMap handles mappings with truncated VLQ segments without crashing", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const { SourceMap } = require("node:module");
const truncated = [
  // 'g' decodes to a base64 value with the VLQ continuation bit set, so the
  // decoder expects more bytes than the 1-byte input provides.
  { version: 3, sources: [], mappings: "g" },
  // Both leading VLQ fields are consumed before the segment is complete, so
  // the next field is decoded from an empty remainder.
  { version: 3, sources: ["x.js"], mappings: "AA" },
];
for (const payload of truncated) {
  try {
    new SourceMap(payload);
  } catch (err) {
    // A clean SyntaxError for a malformed mapping is acceptable.
    if (!(err instanceof SyntaxError)) throw err;
  }
}
// A well-formed mapping still parses.
const ok = new SourceMap({ version: 3, sources: ["test.js"], mappings: "AAAA" });
console.log(ok.findEntry(0, 0).originalSource);
console.log("done");`,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  expect(stdout).toBe("test.js\ndone\n");
  expect(exitCode).toBe(0);
});

test("error.stack of // @bun code with a truncated VLQ in sourceMappingURL warns and degrades gracefully", async () => {
  // 'g' is a single base64 byte with the VLQ continuation bit set, so the
  // mappings string ends mid-value. The generated-column field is truncated,
  // so the decoder makes no progress and parsing fails. Bun must reject the
  // map with a "Could not decode sourcemap" warning instead of silently
  // accepting a bogus `value: 0` mapping, and reading error.stack must still
  // print the unmapped location instead of aborting.
  const map = Buffer.from(
    JSON.stringify({ version: 3, sources: ["a.ts"], sourcesContent: ["x"], names: [], mappings: "g" }),
  ).toString("base64");
  using dir = tempDir("sourcemap-truncated-vlq", {
    "entry.js": `// @bun\nthrow new Error("boom");\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "entry.js"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  // The truncated mapping is rejected with a warning rather than silently
  // decoded as 0 (which left no trace that the map was corrupt).
  expect(stderr).toContain("Could not decode sourcemap");
  expect(stderr).toContain("error: boom");
  expect(stderr).toContain("entry.js:2:");
  expect(stdout).toBe("");
  expect(exitCode).toBe(1);
});
