// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/sidebar.tsx
// (`SidebarProvider`, `Sidebar` with collapsible="offcanvas", `SidebarTrigger`, `SidebarInput`,
// `SidebarGroupLabel` and `sidebarMenuButtonVariants`) and apps/web/src/components/AppSidebarLayout.tsx
// (the toggle fixed beside the macOS window buttons, and its Mod+B shortcut).
import { PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { useEffect, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

// Whether the sidebar is open survives a restart.
const sidebarKey = "chiefbot.sidebar";

const isMac = navigator.userAgent.includes("Mac");

// The sidebar's open state, persisted, and toggled by Cmd+B (Ctrl+B off macOS), as in T3 Code.
export function useSidebarOpen() {
  const [open, setOpen] = useState(() => localStorage.getItem(sidebarKey) !== "closed");
  const toggle = () => setOpen((was) => !was);
  useEffect(() => localStorage.setItem(sidebarKey, open ? "open" : "closed"), [open]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.shiftKey || event.altKey) return;
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return { open, toggle };
}

// The window: the sidebar, the main column and the fixed toggle. `data-sidebar-state`
// lets a top bar in the main column make room for the window buttons and the toggle
// while the sidebar is hidden (`PaneHeader`): content starts at `--sidebar-content-left`.
// On macOS the controls start after the window buttons (90px, as in T3 Code).
const controlsInset = {
  "--sidebar-controls-left": isMac ? "90px" : "0.75rem",
  "--sidebar-content-left": "calc(var(--sidebar-controls-left) + var(--sidebar-control-size) + 0.75rem)",
} as CSSProperties;

export function SidebarLayout({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full" data-sidebar-state={open ? "expanded" : "collapsed"} style={controlsInset}>
      {children}
      <div className="pointer-events-none fixed top-0 left-(--sidebar-controls-left) z-50 flex h-(--topbar-height) items-center">
        <button
          type="button"
          aria-label="Toggle sidebar"
          aria-pressed={open}
          title={`Toggle sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
          className="pointer-events-auto flex size-(--sidebar-control-size) cursor-pointer items-center justify-center rounded-[var(--control-radius)] text-muted-foreground outline-none transition-colors [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggle}
        >
          {open ? <PanelLeftCloseIcon className="size-4" /> : <PanelLeftIcon className="size-4" />}
        </button>
      </div>
    </div>
  );
}

// The sidebar, hidden off the left edge when closed: its width eases to zero while
// its content slides out, so nothing reflows. Closed, it leaves the tab order.
export function Sidebar({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none",
        open ? "w-(--sidebar-width)" : "w-0",
      )}
    >
      <aside
        inert={!open}
        aria-label="Sidebar"
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
          !open && "-translate-x-full",
        )}
      >
        {children}
      </aside>
    </div>
  );
}

// The sidebar's top bar: the window's drag handle, with the title after the window buttons and the toggle.
export function SidebarHeader({ children }: { children: ReactNode }) {
  return (
    <div className="drag-region flex h-(--topbar-height) shrink-0 items-center ps-(--sidebar-content-left) pe-3">
      <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-sm tracking-tight">{children}</span>
    </div>
  );
}

// T3 Code's search row: a quiet field with an icon that lights up on hover.
export function SidebarSearch({ icon, className, ...props }: ComponentProps<"input"> & { icon: ReactNode }) {
  return (
    <label className="flex h-8 min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-(--sidebar-icon-color)">
      {icon}
      <input
        type="search"
        className={cn(
          "min-w-0 flex-1 bg-transparent font-medium text-sidebar-foreground text-sm outline-none placeholder:text-sidebar-muted-foreground [&::-webkit-search-cancel-button]:hidden",
          className,
        )}
        {...props}
      />
    </label>
  );
}

// An icon action in the sidebar (search row, footer), after T3 Code's `SidebarHeaderIconButton`.
export function SidebarIconButton({ label, className, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--control-radius)] outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active disabled:pointer-events-none disabled:opacity-64 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-(--sidebar-icon-color) hover:[&>svg]:text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}

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
