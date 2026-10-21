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

type MappedRecord<Cause, Result> = { cause: Cause; result: Result; number: number };
function records<C, R>(cause: C, result: R): { rows: MappedRecord<C, R>[] } {
  return { rows: [0].map(() => ({ cause, result, number: 2 })) };
}
const useCause = (cell: MappedRecord<"poll", string>): string => cell.cause + ":" + cell.result.length + cell.number;
const useResult = (cell: MappedRecord<string, "status">): string => cell.cause.length + ":" + cell.result + cell.number;
const plain = records<"poll", "status">("poll", "status");
const byCause: { rows: MappedRecord<"poll", string>[] } = plain;
const byResult: { rows: MappedRecord<string, "status">[] } = plain;
console.log(useCause(byCause.rows[0]!), useResult(byResult.rows[0]!), useCause(byCause.rows[0]!));
byCause.rows[0]!.number = 7;
byResult.rows[0]!.number += 1;
console.log(useResult(byResult.rows[0]!), useCause(byCause.rows[0]!), plain.rows[0] === byResult.rows[0]);
