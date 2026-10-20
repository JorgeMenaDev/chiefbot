// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/menu.tsx
// (`MenuPopup`, `MenuItem`, `MenuRadioItem`, `MenuGroupLabel`, `MenuSeparator`): the same look, on the browser's
// popover (top layer, so no window edge or scroll area clips it; a click outside or Escape closes it)
// and CSS anchor positioning in place of Base UI's positioner. It holds plain buttons, not ARIA menu
// items: Tab moves between them. Opening it focuses its first button, and closing it returns focus
// to the button that opened it (the browser does that for a popover).
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// A menu that opens above its trigger, aligned to the trigger's left edge. The trigger is
// any button with `popoverTarget={id}`: the browser anchors a popover to the button that opened it.
// `onOpenChange` hears it open and close, so the trigger can show it is open.
export function MenuPopup({
  id,
  className,
  onOpenChange,
  ...props
}: ComponentProps<"div"> & { id: string; "aria-label": string; onOpenChange?: (open: boolean) => void }) {
  return (
    <div
      id={id}
      popover="auto"
      role="dialog"
      data-slot="menu-popup"
      className={cn(
        "dropdown-glass m-0 mb-1 max-h-[calc(100vh-1rem)] min-w-56 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg p-1 text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none [-webkit-app-region:no-drag] [position-area:top_span-right] [position-try-fallbacks:flip-block] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
        "origin-bottom-left scale-98 opacity-0 transition-[opacity,scale,display,overlay] transition-discrete duration-150 ease-out motion-reduce:transition-none open:scale-100 open:opacity-100 starting:open:scale-98 starting:open:opacity-0",
        className,
      )}
      onToggle={(event) => {
        if (event.newState === "open") event.currentTarget.querySelector("button")?.focus();
        onOpenChange?.(event.newState === "open");
      }}
      {...props}
    />
  );
}

// A row that runs `onClick`, then closes its menu.
export function MenuItem({
  menu,
  variant = "default",
  className,
  ...props
}: ComponentProps<"button"> & { menu: string; variant?: "default" | "destructive" }) {
  return (
    <button
      type="button"
      popoverTarget={menu}
      popoverTargetAction="hide"
      data-slot="menu-item"
      data-variant={variant}
      className={cn(
        "flex min-h-7 w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-foreground text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent data-[variant=destructive]:text-destructive-foreground [&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground [&>svg]:-mx-0.5 [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg]:opacity-80 data-[variant=destructive]:[&>svg]:text-current",
        className,
      )}
      {...props}
    />
  );
}

// One choice of a set, such as an effort level: the checked one is shaded, as in T3 Code.
// Picking it runs `onClick`, then closes its menu.
export function MenuRadioItem({ menu, checked, className, ...props }: ComponentProps<"button"> & { menu: string; checked: boolean }) {
  return (
    <button
      type="button"
      popoverTarget={menu}
      popoverTargetAction="hide"
      aria-pressed={checked}
      data-slot="menu-radio-item"
      className={cn(
        "flex min-h-7 w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-foreground text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent aria-pressed:bg-foreground/[0.08] [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function MenuGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="menu-label" className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="menu-separator" className={cn("mx-2 my-1 h-px bg-border", className)} {...props} />;
}
