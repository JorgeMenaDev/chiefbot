// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/lib/utils.ts.
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

// Joins class names; later Tailwind classes win over earlier ones.
export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

// "A", "A and B", "A, B and C".
export const listOf = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
