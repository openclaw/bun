import assert from 'node:assert/strict';

export const metrics = {
  gatewayReadySeconds: row => row.gatewayReadySeconds,
  firstDeltaSeconds: row => row.turn?.firstDeltaSeconds,
  turnSeconds: row => row.turn?.seconds,
  readyOwnRssBytes: row => row.readyOwnRssBytes,
  turnOwnRssBytes: row => row.turnOwnRssBytes,
  readyOwnCpuSeconds: row => row.readyOwnCpuSeconds,
  turnOwnCpuSeconds: row => row.turnOwnCpuSeconds,
  readyTreeRssBytes: row => row.readyTreeRssBytes,
  turnTreeRssBytes: row => row.turnTreeRssBytes,
  readyTreeCpuSeconds: row => row.readyTreeCpuSeconds,
  turnTreeCpuSeconds: row => row.turnTreeCpuSeconds,
};

export function quantile(values, p) {
  assert(values.length && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

function describe(values) {
  return { n: values.length, median: quantile(values, 0.5), q1: quantile(values, 0.25),
    q3: quantile(values, 0.75), min: Math.min(...values), max: Math.max(...values) };
}

export function summarize(rows, ids, baseline) {
  const measured = rows.filter(row => !row.warmup);
  const cells = {};
  for (const id of ids) {
    const own = measured.filter(row => row.id === id);
    assert(own.length, `missing measured rows for ${id}`);
    cells[id] = {};
    for (const [name, get] of Object.entries(metrics)) {
      const values = own.map(row => get(row.result));
      assert(values.every(Number.isFinite), `${id}: missing ${name}`);
      const pairs = own.flatMap(row => {
        const reference = measured.find(item => item.sweep === row.sweep && item.id === baseline);
        assert(reference, `missing baseline for sweep ${row.sweep}`);
        const denominator = get(reference.result);
        return denominator > 0 ? [get(row.result) / denominator] : [];
      });
      cells[id][name] = { ...describe(values), ratioToBaseline: pairs.length ? describe(pairs) : null,
        omittedZeroDenominatorPairs: own.length - pairs.length };
    }
  }
  return { baseline, policy: 'all completed measured rows; no outlier deletion; linear inclusive quartiles', cells };
}

export function sweepOrder(ids, sweep) {
  return sweep % 2 === 0 ? [...ids] : [...ids].reverse();
}
