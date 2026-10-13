import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./checker-compare.mts", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

// Load only the actual parser and gates; importing the driver starts a benchmark.
const context = vm.createContext({ path });
vm.runInContext(stripTypeScriptTypes(
  section("function matchesBunSummary(", "async function provision(") +
  section("function compare(", "async function main(") + `
  function output(facts) {
    const { overflow, error, resourceContractStable, cacheValid, inventoryValid,
      inventory, parsed, candidate, stderr, repo, cwd, code, state } = facts;
    ${section("    const validOutput =", "    const fileBase =")}
    return { validOutput, checkedFiles: Number.isNaN(checkedFiles) ? null : checkedFiles };
  }
  globalThis.api = { output, preflightPassed, scalarControlsPassed };
`), context);
const api = context.api;

function fixtureRows() {
  const diagnostic = { file: "fixture.ts", line: 1, column: 7, code: 2322,
    message: "Type 'string' is not assignable to type 'number'." };
  const rows = [];
  for (const state of ["fixture-positive", "fixture-negative"])
    for (const candidate of ["current", "bun"])
      rows.push({ graph: "fixture-scalar", candidate, state,
        exitCode: state === "fixture-negative" ? candidate === "bun" ? 1 : 2 : 0,
        diagnostics: state === "fixture-negative" ? [diagnostic] : [],
        stderr: candidate !== "bun" ? "" : state === "fixture-negative"
          ? "Found 1 error in 1 file, checked 68 files [116.04ms]\n"
          : "✓ No type errors in 68 files [148.83ms]\n" });
  for (const [graph, count, time, listTime] of [
    ["core", "15,822", "69.13", "2.75"], ["ui", "14,645", "62.32", "4.29"],
  ])
    for (const candidate of ["current", "bun"])
      for (const state of ["preflight", "inventory"])
        rows.push({ graph, candidate, state, exitCode: 0, diagnostics: [],
          inventory: state === "inventory" ? { application: [`${graph}/input.ts`], libraries: [] } : undefined,
          stderr: candidate !== "bun" ? "" : state === "inventory"
            ? `✓ No type errors in 0 files [${listTime}s]\n`
            : `✓ No type errors in ${count} files [${time}s]\n` });
  return rows.map(row => ({ repetition: 0, resourceContractStable: true, error: null, cwd: "/fixture", ...row }));
}

// Optional argument replays the retained results.jsonl and complete stderr files.
const raw = process.argv[2];
const rows = raw
  ? fs.readFileSync(path.join(raw, "results.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  : fixtureRows();
function facts(row) {
  return { overflow: false, error: row.error, resourceContractStable: row.resourceContractStable,
    cacheValid: true, inventoryValid: true, inventory: row.inventory,
    parsed: { diagnostics: row.diagnostics, unparsed: [] }, candidate: { name: row.candidate },
    stderr: raw ? fs.readFileSync(path.join(raw, row.stderrFile), "utf8") : row.stderr,
    repo: "/source", cwd: row.cwd, code: row.exitCode, state: row.state };
}
const adapted = rows.map(row => ({ ...row, ...api.output(facts(row)) }));
const zero = facts(rows.find(row => row.candidate === "bun" && row.graph === "core" && row.state === "inventory"));

test("captured control and core/UI streams remain valid", () => {
  assert.equal(adapted.length, 12);
  for (const row of adapted) assert.equal(row.validOutput, true, `${row.graph}/${row.candidate}/${row.state}`);
  assert.equal(api.output(zero).checkedFiles, 0);
  const controls = adapted.filter(row => row.graph === "fixture-scalar");
  assert.equal(api.scalarControlsPassed(controls, ["current", "bun"],
    controls.find(row => row.state === "fixture-negative").diagnostics[0].file), true);
});

test("zero checked files are accepted only for a nonempty inventory", () => {
  for (const state of ["preflight", "first", "second"])
    assert.equal(api.output({ ...zero, state }).validOutput, false, state);
  assert.equal(api.output({ ...zero, inventory: { ...zero.inventory, application: [] } }).validOutput, false);
  assert.equal(api.output({ ...zero, inventoryValid: false }).validOutput, false);
});

test("malformed and incomplete summaries cannot qualify", () => {
  for (const stderr of ["", zero.stderr + "unexpected\n", "Could not finish checking 1 file, checked 0 files [1s]\n"])
    assert.equal(api.output({ ...zero, stderr }).validOutput, false, stderr);
  assert.equal(api.output({ ...zero, stderr: "" }).checkedFiles, null);
  const negative = facts(rows.find(row => row.candidate === "bun" && row.state === "fixture-negative"));
  assert.equal(api.output({ ...negative, stderr: negative.stderr.replace("checked 68", "checked 0") }).validOutput, false);
  assert.equal(api.output({ ...zero, parsed: negative.parsed }).validOutput, false);
});

test("full nonempty application inventories must still agree", () => {
  const preflights = adapted.filter(row => ["preflight", "inventory"].includes(row.state));
  assert.equal(api.preflightPassed(preflights, 2), true);
  const target = preflights.find(row => row.candidate === "bun" && row.graph === "core" && row.state === "inventory");
  const mismatch = preflights.map(row => row === target
    ? { ...row, inventory: { ...row.inventory, application: [...row.inventory.application, "extra.ts"] } } : row);
  assert.equal(api.preflightPassed(mismatch, 2), false);
  const empty = preflights.map(row => row.state === "inventory"
    ? { ...row, inventory: { ...row.inventory, application: [] } } : row);
  assert.equal(api.preflightPassed(empty, 2), false);
});
