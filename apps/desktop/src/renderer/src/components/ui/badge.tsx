// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/badge.tsx:
// the same variants on a plain <span>.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: { size: "default", variant: "default" },
    variants: {
      size: {
        default: "h-4.5 min-w-4.5 px-[calc(--spacing(1)-1px)] text-xs",
        lg: "h-5.5 min-w-5.5 px-[calc(--spacing(1.5)-1px)] text-sm",
        sm: "h-4 min-w-4 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-[.625rem]",
      },
      variant: {
        default: "bg-primary text-primary-foreground",
        destructive: "bg-destructive text-white",
        error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
        info: "bg-info/8 text-info-foreground dark:bg-info/16",
        outline: "border-input bg-background text-foreground dark:bg-input/32",
        secondary: "bg-secondary text-secondary-foreground",
        success: "bg-success/8 text-success-foreground dark:bg-success/16",
        warning: "bg-warning/8 text-warning-foreground dark:bg-warning/16",
      },
    },
  },
);

export function Badge({ className, variant, size, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ size, variant }), className)} {...props} />;
}
