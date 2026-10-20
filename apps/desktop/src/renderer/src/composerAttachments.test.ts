import { MAX_ATTACHMENT_BYTES } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { admit, typeOf, uniqueName } from "./composerAttachments.ts";

const file = (name: string, bytes = 1) => new File([new Uint8Array(bytes)], name);

test("the composer takes up to 5 files of up to 10 MB, and says why it left one out", () => {
  const names = (files: File[]) => files.map(({ name }) => name);
  const fits = admit([file("a.txt"), file("b.txt"), file("c.txt")], 2);
  const over = admit([file("big.bin", MAX_ATTACHMENT_BYTES + 1), file("ok.txt")], 0);
  const empty = admit([file("empty.txt", 0)], 0);

  expect([names(fits.files), fits.error]).toEqual([["a.txt", "b.txt", "c.txt"], null]);
  expect([names(admit([file("f.txt")], 5).files), admit([file("f.txt")], 5).error]).toEqual([[], "You can attach up to 5 files per message."]);
  expect([names(over.files), over.error]).toEqual([["ok.txt"], "'big.bin' exceeds the 10 MB attachment limit."]);
  expect(empty.error).toBe("'empty.txt' is empty or could not be read.");
});

test("a second screenshot gets a name of its own", () => {
  expect(uniqueName("image.png", new Set())).toBe("image.png");
  expect(uniqueName("image.png", new Set(["image.png", "image-2.png"]))).toBe("image-3.png");
  expect(uniqueName("Makefile", new Set(["Makefile"]))).toBe("Makefile-2");
});

test("a file without a type is an image by its extension, or plain bytes", () => {
  expect(typeOf({ name: "shot.PNG", type: "" })).toBe("image/png");
  expect(typeOf({ name: "notes.md", type: "" })).toBe("application/octet-stream");
  expect(typeOf({ name: "notes.txt", type: "text/plain" })).toBe("text/plain");
});
