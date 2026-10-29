// A CommonJS file imports the ES module that is being required, then throws.
// Match the source loader: a reentrant import may settle before it learns that the file threw.
globalThis.say = (...words) => console.log(...words.map(word => typeof word === "string" ? word.replaceAll(__dirname, "<fixture>") : word));
try {
  require("./bare/module.mjs");
  say("bare: required");
} catch (error) {
  say("bare: threw", error.message);
}
try {
  require("./named/module.mjs");
  say("named: required");
} catch (error) {
  say("named: threw", error.message);
}
