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

const systemDark = () => matchMedia("(prefers-color-scheme: dark)");
const savedTheme = () => parseTheme(localStorage.getItem(themeKey));

// Puts the theme on the page, and on Electron's native parts (scrollbars, menus,
// the window's background). Once main sets its native theme, the OS media query
// answers with it too, so System's change listener sees the right value.
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveTheme(theme, systemDark().matches) === "dark");
  root.style.removeProperty("background-color");
  void window.chiefbot.theme.set(theme);
}

// Called once at startup (main.tsx): the saved theme, then again on every change
// of the OS appearance, which System follows.
export function startTheme() {
  applyTheme(savedTheme());
  systemDark().addEventListener("change", () => applyTheme(savedTheme()));
}

// The theme and a setter that saves and applies it, for the Settings screen.
export function useTheme() {
  const [theme, setTheme] = useState(savedTheme);
  const pick = (next: Theme) => {
    localStorage.setItem(themeKey, next);
    applyTheme(next);
    setTheme(next);
  };
  return [theme, pick] as const;
}
