import { expect, test } from "bun:test";
import { copyText } from "./clipboard.ts";

test("copies the text and resolves true", async () => {
  const written: string[] = [];
  expect(await copyText("ABCD-1234", { writeText: async (text) => void written.push(text) })).toBe(true);
  expect(written).toEqual(["ABCD-1234"]);
});

test("resolves false when there is no clipboard", async () => {
  expect(await copyText("ABCD-1234", undefined)).toBe(false);
});

test("resolves false when the clipboard refuses, whether it throws or rejects", async () => {
  const throws = {
    writeText: (): Promise<void> => {
      throw new Error("not allowed");
    },
  };
  expect(await copyText("ABCD-1234", throws)).toBe(false);
  expect(await copyText("ABCD-1234", { writeText: () => Promise.reject(new Error("denied")) })).toBe(false);
});
