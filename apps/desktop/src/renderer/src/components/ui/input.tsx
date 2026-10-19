// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/input.tsx and
// textarea.tsx: the same control look, on native <input>, <textarea> and <select>.
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const control =
  "w-full min-w-0 rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] disabled:opacity-64 dark:bg-input/32";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn(control, "h-8 px-[calc(--spacing(3)-1px)]", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(control, "field-sizing-content min-h-16 px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)]", className)}
      {...props}
    />
  );
}

// A native select with T3 Code's select-trigger look.
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select data-slot="select" className={cn(control, "h-8 appearance-none ps-[calc(--spacing(3)-1px)] pe-8")} {...props} />
      <ChevronDownIcon className="pointer-events-none absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}
