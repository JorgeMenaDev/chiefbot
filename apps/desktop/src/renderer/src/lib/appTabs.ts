// The sidebar's two tabs: the user's own bots, and the current workspace's projects.
export type AppTab = "bots" | "projects";

// Which tab a key press opens: Cmd+1 Bots and Cmd+2 Projects (Ctrl off macOS), else null.
export function tabForShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): AppTab | null {
  if (event.shiftKey || event.altKey || !(isMac ? event.metaKey : event.ctrlKey)) return null;
  return event.key === "1" ? "bots" : event.key === "2" ? "projects" : null;
}
