// A generic spread keeps its aliases when three numeric fields require more space than the copied pair.
const kept: { g: number }[] = [];
function keep<V extends { g: number }>(value: V): V {
  kept.push(value);
  return value;
}
function wide<T extends object>(value: T): T & { g: number } {
  return keep({ ...value, g: 7 });
}
for (let n = 0; n < 3; n++) {
  const value = wide({ a: n, b: n });
  value.g = 8;
  console.log(value === kept[n], kept[n].g, value.a, value.b);
}
