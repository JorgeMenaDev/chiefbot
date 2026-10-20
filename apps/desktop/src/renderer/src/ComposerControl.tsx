// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/chat/ComposerControl.tsx:
// the composer's quiet control buttons (the model, effort and access pickers), their icon, chevron and
// separators, at T3's "sm" size, on a plain <button>.
import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./lib/utils.ts";

export function ComposerControl({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cn(
        "relative inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-(--control-radius) border border-transparent px-2.5 font-medium text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 aria-expanded:bg-accent aria-expanded:text-foreground [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerControlIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />;
}

export function ComposerControlChevron() {
  return <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" strokeWidth={2.25} />;
}

export function ComposerControlSeparator({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("mx-0.5 h-4 w-px shrink-0 bg-border", className)} />;
}
