import { Theme } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseTheme, resolveTheme } from "./theme.ts";

test("Dark until the user picks another theme, and for anything unknown", () => {
  expect(parseTheme(null)).toBe("dark");
  expect(parseTheme("sepia")).toBe("dark");
  expect(parseTheme("light")).toBe("light");
  expect(parseTheme("system")).toBe("system");
});

test("System follows the OS; Light and Dark ignore it", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

// The boot script repeats the logic in plain JS, to run before the app's modules load.
test("the boot script picks the same theme as the app", () => {
  const source = readFileSync(new URL("../../public/theme-boot.js", import.meta.url), "utf8");
  for (const saved of [null, "junk", ...Theme.options]) {
    for (const systemDark of [true, false]) {
      let dark: boolean | undefined;
      const documentElement = { classList: { toggle: (_name: string, on: boolean) => void (dark = on) }, style: {} };
      new Function("localStorage", "matchMedia", "document", source)(
        { getItem: () => saved },
        () => ({ matches: systemDark }),
        { documentElement },
      );
      expect(dark ? "dark" : "light").toBe(resolveTheme(parseTheme(saved), systemDark));
    }
  }
});
