// Self-filled arrays, mutual dependencies and external seeds keep ordinary JavaScript values.
function pushed() {
  const parts = [];
  parts.push("a");
  parts.push(parts[0] + parts[1]);
  parts.push(parts[7] + parts[8]);
  return parts.join("|") + " " + typeof parts[2];
}

function eachOther() {
  const left = [];
  const right = [];
  left.push("a");
  right.push("b");
  left.push(right[0] + "x");
  right.push(left[1] + "y");
  return left.join("|") + " " + right.join("|");
}

function fromOutside(input: { text: string }) {
  const left = [];
  const right = [];
  left.push("a");
  right.push(left[0]);
  left.push(JSON.parse(input.text));
  right.push(left[1]);
  left.push(right[1] + right[1]);
  return left.join("|") + " / " + right.join("|") + " " + typeof left[1] + " " + typeof left[2];
}

console.log(pushed());
console.log(eachOther());
console.log(fromOutside({ text: "3" }));
console.log([{ text: '"x"' }, { text: "4" }].map(fromOutside).join("; "));
