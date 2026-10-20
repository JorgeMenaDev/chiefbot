// The theme setting, after T3 Code's apps/web/src/hooks/useTheme.ts (MIT): the
// choice is saved in localStorage, the `dark` class on <html> turns on the dark
// colours (styles.css), and Electron main sets its native theme to match.
// public/theme-boot.js puts the saved theme on before the app loads.
import { Theme } from "@chiefbot/contracts";
import { useState } from "react";

const themeKey = "chiefbot.theme";

// The saved theme: Dark until the user picks another.
export function parseTheme(saved: string | null): Theme {
  return Theme.safeParse(saved).data ?? "dark";
}

// Light or dark: System follows the OS.
export function resolveTheme(theme: Theme, systemDark: boolean): "light" | "dark" {
  if (theme !== "system") return theme;
  return systemDark ? "dark" : "light";
}

// The saved theme, or Dark when storage cannot be read (as the boot script does),
// so a broken storage never stops the app from starting.
export function readTheme(storage: () => Pick<Storage, "getItem">): Theme {
  try {
    return parseTheme(storage().getItem(themeKey));
  } catch {
    return "dark";
  }
}

const systemDark = () => matchMedia("(prefers-color-scheme: dark)");
// The theme on screen. A pick that could not be saved still lasts until restart.
let current: Theme = "dark";

// Puts the theme on the page, and on Electron's native parts (scrollbars, menus,
// the window's background). Once main sets its native theme, the OS media query
// answers with it too, so System's change listener sees the right value.
function applyTheme(theme: Theme) {
  current = theme;
  const root = document.documentElement;
  root.classList.toggle("dark", resolveTheme(theme, systemDark().matches) === "dark");
  root.style.removeProperty("background-color");
  void window.chiefbot.theme.set(theme);
}

// Called once at startup (main.tsx): the saved theme, then again on every change
// of the OS appearance, which System follows.
export function startTheme() {
  applyTheme(readTheme(() => localStorage));
  systemDark().addEventListener("change", () => applyTheme(current));
}

// The theme and a setter that saves and applies it, for the Settings screen.
export function useTheme() {
  const [theme, setTheme] = useState(current);
  const pick = (next: Theme) => {
    try {
      localStorage.setItem(themeKey, next);
    } catch {
      // Not saved: it still applies now; the saved theme returns at the next start.
    }
    applyTheme(next);
    setTheme(next);
  };
  return [theme, pick] as const;
}
