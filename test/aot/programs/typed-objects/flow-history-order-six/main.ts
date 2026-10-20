import type { Base } from "./types.ts";
import { narrow1, read1 } from "./narrow-1.ts";
import { narrow2, read2 } from "./narrow-2.ts";
import { narrow3, read3 } from "./narrow-3.ts";
import { narrow4, read4 } from "./narrow-4.ts";
import { narrow5, read5 } from "./narrow-5.ts";
import { narrow6, read6 } from "./narrow-6.ts";

const forward = Bun.parse<Base>('{"f1":"one","f2":"one","f3":"one","f4":"one","f5":"one","f6":"one","value":0}');
narrow1(forward);
narrow2(forward);
narrow3(forward);
narrow4(forward);
narrow5(forward);
narrow6(forward);

if (forward.value !== 21 || read1() !== 21 || read2() !== 21 || read3() !== 21 || read4() !== 21 || read5() !== 21 || read6() !== 21) throw new Error("forward alias lost");
const reverse = Bun.parse<Base>('{"f1":"one","f2":"one","f3":"one","f4":"one","f5":"one","f6":"one","value":0}');
narrow6(reverse);
narrow5(reverse);
narrow4(reverse);
narrow3(reverse);
narrow2(reverse);
narrow1(reverse);

if (reverse.value !== 21 || read1() !== 21 || read2() !== 21 || read3() !== 21 || read4() !== 21 || read5() !== 21 || read6() !== 21) throw new Error("reverse alias lost");
console.log(`forward:${forward.value},reverse:${reverse.value}`);
