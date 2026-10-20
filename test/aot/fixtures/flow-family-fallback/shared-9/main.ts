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

const forward = Bun.parse<Base>('{"f1":"one","f2":"one","f3":"one","f4":"one","f5":"one","f6":"one","f7":"one","f8":"one","f9":"one","value":0}');
narrow1(forward);
narrow2(forward);
narrow3(forward);
narrow4(forward);
narrow5(forward);
narrow6(forward);
narrow7(forward);
narrow8(forward);
narrow9(forward);

if (forward.value !== 45 || read1() !== 45 || read2() !== 45 || read3() !== 45 || read4() !== 45 || read5() !== 45 || read6() !== 45 || read7() !== 45 || read8() !== 45 || read9() !== 45) throw new Error("forward alias lost");
const reverse = Bun.parse<Base>('{"f1":"one","f2":"one","f3":"one","f4":"one","f5":"one","f6":"one","f7":"one","f8":"one","f9":"one","value":0}');
narrow9(reverse);
narrow8(reverse);
narrow7(reverse);
narrow6(reverse);
narrow5(reverse);
narrow4(reverse);
narrow3(reverse);
narrow2(reverse);
narrow1(reverse);

if (reverse.value !== 45 || read1() !== 45 || read2() !== 45 || read3() !== 45 || read4() !== 45 || read5() !== 45 || read6() !== 45 || read7() !== 45 || read8() !== 45 || read9() !== 45) throw new Error("reverse alias lost");
console.log(`forward:${forward.value},reverse:${reverse.value}`);
