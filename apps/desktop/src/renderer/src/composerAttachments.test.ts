import { MAX_ATTACHMENT_BYTES } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { admit, reserve, typeOf, uniqueName, uploads, type DraftAttachment } from "./composerAttachments.ts";

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

test("files picked while others are still read count against the same limits and names", () => {
  const first = reserve([file("image.png"), file("a.txt"), file("b.txt")], []);
  const held = first.reserved.map(({ attachment }) => attachment);
  const second = reserve([file("image.png"), file("c.txt"), file("d.txt")], held);

  expect(held.every(({ data }) => data === null)).toBe(true);
  expect(second.reserved.map(({ attachment }) => attachment.name)).toEqual(["image-2.png", "c.txt"]);
  expect(second.error).toBe("You can attach up to 5 files per message.");
});

test("a message sends its files only once every one is read", () => {
  const draft = (data: string | null): DraftAttachment => ({ id: "1", name: "a.txt", mimeType: "text/plain", size: 2, data });
  expect(uploads([draft("aGk="), draft(null)])).toBeNull();
  expect(uploads([draft("aGk=")])).toEqual([{ name: "a.txt", mimeType: "text/plain", data: "aGk=" }]);
  expect(uploads([])).toEqual([]);
});
