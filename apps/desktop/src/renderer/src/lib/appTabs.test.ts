import { expect, test } from "bun:test";
import { tabForShortcut } from "./appTabs.ts";

const key = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("Cmd+1 opens Bots and Cmd+2 Projects on a Mac; Ctrl elsewhere; anything else is not a tab switch", () => {
  expect(tabForShortcut(key("1", { metaKey: true }), true)).toBe("bots");
  expect(tabForShortcut(key("2", { metaKey: true }), true)).toBe("projects");
  expect(tabForShortcut(key("2", { ctrlKey: true }), false)).toBe("projects");
  expect(tabForShortcut(key("2", { ctrlKey: true }), true)).toBeNull();
  expect(tabForShortcut(key("2", { metaKey: true, shiftKey: true }), true)).toBeNull();
  expect(tabForShortcut(key("3", { metaKey: true }), true)).toBeNull();
  expect(tabForShortcut(key("1"), true)).toBeNull();
});
