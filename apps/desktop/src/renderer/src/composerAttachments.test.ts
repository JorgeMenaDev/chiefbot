import { MAX_ATTACHMENT_BYTES } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import type { SetStateAction } from "react";
import { admit, readInto, reserve, typeOf, uniqueName, uploads, type DraftAttachment } from "./composerAttachments.ts";

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

test("a read that ends after its file was removed changes nothing, even with a new file of its name", async () => {
  // Reads the test ends by hand, by file name.
  const reads = new Map<string, { resolve: (data: string) => void; reject: () => void }>();
  const read = (file: File) => new Promise<string>((resolve, reject) => reads.set(file.name, { resolve, reject: () => reject(new Error("unreadable")) }));
  let files: DraftAttachment[] = [];
  const setFiles = (next: SetStateAction<DraftAttachment[]>) => void (files = typeof next === "function" ? next(files) : next);
  const failed: string[] = [];
  const attach = (picked: File[]) => {
    const { reserved } = reserve(picked, files);
    files = [...files, ...reserved.map(({ attachment }) => attachment)];
    readInto(reserved, { files: () => files, setFiles, onFailed: ({ id }) => failed.push(id), read });
    return reserved.map(({ attachment }) => attachment.id);
  };

  const [removed = ""] = attach([file("notes.txt")]);
  const removedRead = reads.get("notes.txt");
  files = [];
  const [kept = ""] = attach([file("notes.txt")]);
  const keptRead = reads.get("notes.txt");
  removedRead?.reject();
  keptRead?.resolve("bmV3");
  await Bun.sleep(0);

  expect([removed === kept, failed]).toEqual([false, []]);
  expect(files.map(({ id, name, data }) => [id, name, data])).toEqual([[kept, "notes.txt", "bmV3"]]);
});

test("a file that cannot be read is reported while it is still in the composer", async () => {
  let files: DraftAttachment[] = [];
  const { reserved } = reserve([file("notes.txt")], files);
  files = reserved.map(({ attachment }) => attachment);
  const failed: string[] = [];

  readInto(reserved, { files: () => files, setFiles: () => {}, onFailed: ({ name }) => failed.push(name), read: () => Promise.reject(new Error("unreadable")) });
  await Bun.sleep(0);

  expect(failed).toEqual(["notes.txt"]);
});
