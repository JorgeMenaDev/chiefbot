import type { ReactNode } from "react";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./components/ui/card.tsx";

// The pieces every main-column screen shares, after T3 Code's chat header and
// settings panels: a slim top bar, panels that open under it, list rows, cards.

// The top bar: the screen's name (and a quiet note), its actions on the right.
// It is the window's drag handle, as macOS hides the title bar.
export function PaneHeader({
  title,
  icon,
  note,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <header className="drag-region flex h-(--topbar-height) shrink-0 items-center gap-3 border-b px-5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {icon}
        <h2 className="min-w-0 truncate font-medium text-sm">{title}</h2>
        {note && (
          <span className="min-w-0 flex-1 basis-0 truncate text-muted-foreground text-xs" title={note}>
            {note}
          </span>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </header>
  );
}

// A strip that opens under the top bar (routines, what a project listens to, connector calls).
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="max-h-[45%] shrink-0 overflow-y-auto border-b bg-card/60 px-5 py-3">
      <div className="flex flex-col">
        <h3 className="pb-1 font-medium text-muted-foreground text-xs">{title}</h3>
        {children}
      </div>
    </section>
  );
}

// A list row: a title, a quiet line under it, anything else (forms) below, actions on the right.
export function Row({ title, meta, actions, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="truncate font-medium text-sm">{title}</div>
        {meta && <div className="text-muted-foreground text-xs">{meta}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

// A card of rows on a settings-like screen (members, connectors).
export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-col p-5 pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>
      <CardPanel className="flex flex-col px-5 pb-3">{children}</CardPanel>
    </Card>
  );
}

// A settings-like screen's scrolling body, centred.
export function PaneBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">{children}</div>
    </div>
  );
}

// Control's refusal or a failed call, in a line.
export function ErrorText({ message }: { message: string | null }) {
  return message ? <p className="text-destructive-foreground text-xs">{message}</p> : null;
}

// A quiet line for an empty list.
export function Muted({ children }: { children: ReactNode }) {
  return <p className="py-2 text-muted-foreground text-xs">{children}</p>;
}
