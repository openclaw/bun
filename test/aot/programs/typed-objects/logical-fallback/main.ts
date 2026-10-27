import { readParser, readProjection, type Parser } from "./producer.ts";

async function run(present: boolean) {
  const projection = await readProjection(present);
  const { sessionModelCatalog, defaultModelCatalog } = projection ?? {};
  console.log(JSON.stringify([sessionModelCatalog ?? null, defaultModelCatalog ?? null]));
  const { sessionModelCatalog: session, defaultModelCatalog: defaults } = projection || {};
  console.log(JSON.stringify([session ?? null, defaults ?? null]));
  const parser = readParser(present) ?? { apply: value => value.toFixed(1) };
  console.log(parser.apply(2));
  const annotated: Parser = readParser(present) || { apply: value => value.toFixed(2), label: "fallback" };
  console.log(annotated.label, annotated.apply(2));
}

await run(false);
await run(true);
