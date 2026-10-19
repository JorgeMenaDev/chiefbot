// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/lib/utils.ts.
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

// Joins class names; later Tailwind classes win over earlier ones.
export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
