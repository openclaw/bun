import vm from "node:vm";
import { heapStats } from "bun:jsc";

const held = [];
const retain = process.argv.includes("--retain");
const source = `/*\n${Buffer.alloc(10000, " * aaaaa\n").toString("utf8")}\n*/ Buffer.alloc(10, 'hello');`;
const samples = [];
function sample(iterations) {
  Bun.gc(true);
  const rss = process.memoryUsage.rss();
  const stats = heapStats();
  samples.push({ iterations, rss, ...stats });
}
function run(i) {
  const script = new vm.Script(source + "//" + i);
  script.runInThisContext();
  if (retain) held.push(script);
}
sample(0);
for (let batch = 0; batch < (retain ? 2 : 10); batch++) {
  for (let i = 0; i < 10000; i++) run(batch * 10000 + i);
  sample((batch + 1) * 10000);
}
console.log(JSON.stringify({ retain, held: held.length, samples }));
