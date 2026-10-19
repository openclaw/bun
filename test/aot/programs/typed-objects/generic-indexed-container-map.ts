// Mapping a generic container preserves additional element fields and alias identity.
// IR+ ^shape .*"MappedRows"
// IR- ^shape .*"MappedRows".* accepts-untyped
export {};
type Base = { rows: readonly { id: string }[] };
type MappedRows<T extends Base> = { rows: Array<T["rows"][number] & { error: string }> };
function addField<T extends Base>(input: T): MappedRows<T> {
  const error = `failure-${input.rows.length}`;
  return { rows: input.rows.map((item: T["rows"][number]) => ({ ...item, error })) };
}
function identities<T extends Base>(input: T): Array<T["rows"][number]> {
  return input.rows.map((item: T["rows"][number]) => item);
}
const original = { id: "fixture", extra: "preserved" };
const input = { rows: [original] };
const result = addField(input);
console.log(result.rows[0]?.id, result.rows[0]?.extra, result.rows[0]?.error);
console.log(identities(input)[0] === original, original.extra);
console.log(addField({ rows: [] }).rows.length);
class SkippedMap<T> extends Array<T> {
  override map<U>(_callback: (value: T, index: number, array: T[]) => U, _thisArg?: unknown): U[] {
    return [];
  }
}
const skipped = new SkippedMap<typeof original>();
skipped.push(original);
console.log(addField({ rows: skipped }).rows.length, skipped[0] === original);
