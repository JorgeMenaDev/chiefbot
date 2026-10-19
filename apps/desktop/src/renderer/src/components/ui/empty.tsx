// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/empty.tsx:
// a centred empty state, with an icon tile fanned like a small stack of cards.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn("flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance p-6 text-center md:p-12", className)}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("flex max-w-sm flex-col items-center text-center", className)} {...props} />;
}

const tile =
  "relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-card not-dark:bg-clip-padding text-foreground shadow-sm/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5";

export function EmptyMedia({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="empty-media" className={cn("relative mb-6", className)} {...props}>
      <div aria-hidden="true" className={cn(tile, "pointer-events-none absolute bottom-px origin-bottom-left -translate-x-0.5 -rotate-10 scale-84 shadow-none")} />
      <div aria-hidden="true" className={cn(tile, "pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84 shadow-none")} />
      <div className={tile}>{children}</div>
    </div>
  );
}

export function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-title" className={cn("font-semibold text-xl", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-description"
      className={cn("text-muted-foreground text-sm [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-1", className)}
      {...props}
    />
  );
}
