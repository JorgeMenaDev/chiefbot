import type { HealthStatus } from "@chiefbot/contracts";
import { CircleCheckIcon, CircleQuestionMarkIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "./lib/utils.ts";

// How Health shows a status, shared by connection cards (Health.tsx) and services (Services.tsx).

export const statusLabel: Record<HealthStatus, string> = { ok: "Healthy", degraded: "Degraded", down: "Down", unknown: "Unknown" };

export const badgeVariant = { ok: "success", degraded: "warning", down: "error", unknown: "outline" } as const satisfies Record<HealthStatus, string>;

// A bar's colour per status; the track behind it (no check) is muted.
export const barColor: Record<HealthStatus, string> = {
  ok: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/45",
};

const statusIcon = {
  ok: [CircleCheckIcon, "text-success"],
  degraded: [TriangleAlertIcon, "text-warning"],
  down: [CircleXIcon, "text-destructive"],
  unknown: [CircleQuestionMarkIcon, "text-muted-foreground"],
} as const satisfies Record<HealthStatus, readonly [unknown, string]>;

export function StatusIcon({ status, className }: { status: HealthStatus; className?: string }) {
  const [Icon, color] = statusIcon[status];
  return <Icon aria-hidden className={cn("shrink-0", color, className)} />;
}

// "just now", "4 min ago", "2 h ago".
export function ago(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

// A time of day, as the status bars' tooltips show it.
export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
