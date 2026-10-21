// A mutable captured string enters a loop after a branch join while its environment can be reused or escape.
let saved: (() => number) | undefined;
function create(text: string, escape: boolean, depth: number) {
  function replace(next: string): void { text = next; }
  function scan(level: number, prefix: boolean): number {
    if (level < 0) return 1 + scan(level + 1, !prefix);
    if (level === 10) replace(text.slice(1));
    let total = 0;
    let i = 0;
    if (prefix) console.log("prefix");
    else console.log("other");
    for (; i < text.length; i++) total += text.charCodeAt(i);
    return total;
  }
  if (escape) saved = () => scan(depth, true);
  else console.log(scan(depth, false));
}
declare const process: {argv:string[]};
create(process.argv[2] ?? "hello", process.argv[3] === "escape", Number(process.argv[4] ?? 0));
create(process.argv[2] ?? "world", process.argv[3] !== "escape", Number(process.argv[4] ?? 0));
console.log(saved?.());

export {};
