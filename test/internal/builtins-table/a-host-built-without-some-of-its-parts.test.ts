// b.leftOut(): what the table leaves out of a host.
import { expect, test } from "bun:test";
import { tempDir } from "harness";
import { resolve } from "node:path";
import { collectStaticTables, parseHashTable } from "../../../src/codegen/builtins/collect-static-tables.ts";
import { Problems, type LeftOutDeclaration, type Source, type SourcedDeclaration } from "../../../src/codegen/builtins/declarations.ts";
import { leftOut } from "../../../src/codegen/builtins/lib.ts";
import { ModelBuilder } from "../../../src/codegen/builtins/model-builder.ts";

const source: Source = { file: "made-up.builtins.ts", line: null, origin: "Host", proof: "Structure" };

function builderOf(parts: Parameters<typeof leftOut>[0]): ModelBuilder {
  const builder = new ModelBuilder({ schema: null as never, engineFiles: [] });
  for (const declaration of leftOut(parts)) builder.leaveOut(declaration as LeftOutDeclaration);
  return builder;
}

test("nothing is declared at a path that is left out or under it", () => {
  const builder = builderOf({ paths: ["%Gone%", "%Kept%.gone"] });
  expect(builder.create("%Gone%", "Namespace", source)).toBeNull();
  expect(builder.create("%Gone%.member", "Function", source)).toBeNull();
  expect(builder.create("%Kept%", "Namespace", source)).not.toBeNull();
  expect(builder.create("%Kept%.gone", "Namespace", source)).toBeNull();
  expect(builder.create("%Kept%.gone.member", "Function", source)).toBeNull();
  expect(builder.create("%Kept%.goneToo", "Function", source)).not.toBeNull();
  expect(builder.problems.lines).toEqual([]);
});

test("a declaration that names what nothing declares stops the build", () => {
  for (const parts of [{}, { paths: ["%Gone%"] }, { schemas: ["made_up_test.bind.ts"] }]) {
    const builder = builderOf(parts);
    expect(builder.resolve("%Gone%.member", source)).toBeNull();
    expect(builder.problems.lines).toEqual([expect.stringContaining("%Gone%.member: no class, namespace or entry")]);
  }
});

test("it says nothing where what is left out may be named", () => {
  const builder = builderOf({ paths: ["%Gone%"], mayBeNamed: true });
  expect(builder.resolve("%Gone%.member", source)).toBeNull();
  expect(builder.resolveClass("Gone", source)).toBeNull();
  expect(builder.resolveModule("made:up", source)).toBeNull();
  expect(builder.problems.lines).toEqual([]);
});

const table = `
@begin madeUpTable
  always    madeUpAlways    Function 0
#if !defined(WITHOUT_FIRST)
  first     madeUpFirst     Function 1
#endif
#if defined(WITHOUT_FIRST)
  instead   madeUpInstead   Function 1
#else
  second    madeUpSecond    Function 2
#endif
@end
`;

const keysWith = (...definedNames: string[]): string[] =>
  parseHashTable(table, "madeUpTable", "made-up.cpp", new Set(definedNames)).map(({ key }) => key);

test("a static table has the rows of the names that are defined", () => {
  expect(keysWith()).toEqual(["always", "first", "second"]);
  expect(keysWith("WITHOUT_OTHER")).toEqual(["always", "first", "second"]);
  expect(keysWith("WITHOUT_FIRST")).toEqual(["always", "instead"]);
});

function collect(root: string, file: string, table: string) {
  const declaration: SourcedDeclaration = {
    declaration: { declares: "StaticTable", holder: "process", table: { file, table } },
    source: { file: "custom-value.builtins.ts", line: null, origin: "Host", proof: "Structure" },
  };
  const problems = new Problems();
  const members = collectStaticTables([declaration], { Engine: root, Host: root }, problems);
  return { members: members.map(({ declaration }) => declaration), problems };
}

test("native process data properties retain their getter and setter symbols", () => {
  const { members, problems } = collect(
    resolve(import.meta.dir, "../../.."),
    "src/jsc/bindings/BunProcess.cpp",
    "processObjectTable",
  );
  expect(problems.lines).toEqual([]);
  for (const [name, getter, setter] of [
    ["ppid", "processPpid", "setProcessPpid"],
    ["title", "processTitle", "setProcessTitle"],
  ]) {
    expect(members).toContainEqual(
      expect.objectContaining({
        declares: "Member",
        path: `process.${name}`,
        kind: "DataProperty",
        columns: expect.objectContaining({ nativeSymbols: [getter, setter], hasSetter: true }),
      }),
    );
  }
});

test("read-only native data properties have no setter and unknown attributes still fail", () => {
  using directory = tempDir("custom-value-table", {
    "table.cpp": "@begin properties\nvalue readValue CustomValue|ReadOnly\nbad readBad UnknownValue\n@end\n",
  });
  const { members, problems } = collect(String(directory), "table.cpp", "properties");
  expect(members).toContainEqual(
    expect.objectContaining({
      path: "process.value",
      kind: "DataProperty",
      columns: expect.objectContaining({ nativeSymbols: ["readValue"], hasSetter: false }),
    }),
  );
  expect(problems.lines).toEqual([expect.stringContaining("process.bad: unknown attribute UnknownValue")]);
});
