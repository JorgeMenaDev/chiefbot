// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/sidebar.tsx
// (`SidebarGroupLabel` and `sidebarMenuButtonVariants`): the sidebar's section label and row.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function SidebarGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn("flex h-8 shrink-0 items-center gap-2 px-2.5 pt-2 font-medium text-sidebar-muted-foreground text-xs", className)}
      {...props}
    />
  );
}

// One row: an icon or status dot, a label that truncates, and a quiet trailing note.
export function SidebarRow({ className, active = false, ...props }: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="sidebar-row"
      data-active={active}
      className={cn(
        "flex h-8 w-full shrink-0 cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] text-left text-sm text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 active:bg-sidebar-row-active disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] data-[active=true]:[&>svg]:text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}
