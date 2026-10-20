import type { Base } from "./types.ts";
import { narrow1, read1 } from "./narrow-1.ts";
import { narrow2, read2 } from "./narrow-2.ts";
import { narrow3, read3 } from "./narrow-3.ts";
import { narrow4, read4 } from "./narrow-4.ts";
import { narrow5, read5 } from "./narrow-5.ts";
import { narrow6, read6 } from "./narrow-6.ts";
import { narrow7, read7 } from "./narrow-7.ts";
import { narrow8, read8 } from "./narrow-8.ts";
import { narrow9, read9 } from "./narrow-9.ts";
import { narrow10, read10 } from "./narrow-10.ts";
import { narrow11, read11 } from "./narrow-11.ts";

const forward = Bun.parse<Base>('{"f1":"one","f2":"one","f3":"one","f4":"one","f5":"one","f6":"one","f7":"one","f8":"one","f9":"one","f10":"one","f11":"one","value":0}');
narrow1(forward);
narrow2(forward);
narrow3(forward);
narrow4(forward);
narrow5(forward);
narrow6(forward);
narrow7(forward);
narrow8(forward);
narrow9(forward);
narrow10(forward);
narrow11(forward);

if (forward.value !== 66 || read1() !== 66 || read2() !== 66 || read3() !== 66 || read4() !== 66 || read5() !== 66 || read6() !== 66 || read7() !== 66 || read8() !== 66 || read9() !== 66 || read10() !== 66 || read11() !== 66) throw new Error("forward alias lost");
const reverse = Bun.parse<Base>('{"f1":"one","f2":"one","f3":"one","f4":"one","f5":"one","f6":"one","f7":"one","f8":"one","f9":"one","f10":"one","f11":"one","value":0}');
narrow11(reverse);
narrow10(reverse);
narrow9(reverse);
narrow8(reverse);
narrow7(reverse);
narrow6(reverse);
narrow5(reverse);
narrow4(reverse);
narrow3(reverse);
narrow2(reverse);
narrow1(reverse);

if (reverse.value !== 66 || read1() !== 66 || read2() !== 66 || read3() !== 66 || read4() !== 66 || read5() !== 66 || read6() !== 66 || read7() !== 66 || read8() !== 66 || read9() !== 66 || read10() !== 66 || read11() !== 66) throw new Error("reverse alias lost");
if (!narrow1.toString().includes("not narrowed 1") || !narrow11.toString().includes("not narrowed 11")) {
  throw new Error("function source lost after Flow-family fallback");
}
const validated = Bun.validate<Base>(forward);
if (validated.value !== 66) throw new Error("validation changed after Flow-family fallback");
const safe = Bun.safeValidate<Base>(forward);
if (!safe.success || safe.data.value !== 66) throw new Error("safe validation changed after Flow-family fallback");
const invalid = Bun.safeValidate<Base>({});
if (invalid.success || invalid.issues.length === 0) throw new Error("safe validation accepted an invalid value");
const standard = Bun.schema<Base>()["~standard"];
const accepted = standard.validate(forward);
if (accepted.issues !== undefined || accepted.value.value !== 66) throw new Error("schema validation changed after Flow-family fallback");
const rejected = standard.validate({});
if (rejected.issues === undefined || rejected.issues.length === 0) throw new Error("schema validation accepted an invalid value");
let refused = 0;
try { Bun.validate<Base>({}); } catch { refused++; }
try { Bun.parse<Base>("{}"); } catch { refused++; }
if (refused !== 2) throw new Error("type-driven API accepted an invalid value");
console.log(`forward:${forward.value},reverse:${reverse.value}`);
