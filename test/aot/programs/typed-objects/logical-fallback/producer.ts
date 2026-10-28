export type Result = { sessionModelCatalog: string[]; defaultModelCatalog: string[] };

export async function readProjection(present: boolean): Promise<Result | undefined> {
  return present ? { sessionModelCatalog: ["session"], defaultModelCatalog: ["default"] } : undefined;
}

export type Parser = { apply: (value: number) => string; label: string };

export function readParser(present: boolean): Parser | undefined {
  return present ? { apply: value => value.toFixed(0), label: "present" } : undefined;
}
