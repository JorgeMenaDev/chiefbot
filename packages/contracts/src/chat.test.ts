import { expect, test } from "bun:test";
import { MAX_ATTACHMENT_BYTES, SendBotMessageRequest } from "./chat.ts";

// A file of `bytes` zero bytes, as the desktop sends it.
const file = (name: string, bytes = 1) => ({ name, mimeType: "text/plain", data: Buffer.alloc(bytes).toString("base64") });
const sends = (attachments: unknown[]) => SendBotMessageRequest.safeParse({ text: "hi", attachments }).success;

test("a message takes up to 5 files of up to 10 MB each, or none", () => {
  expect(sends([file("a.bin", MAX_ATTACHMENT_BYTES), file("b.txt"), file("c.txt"), file("d.txt"), file("e.txt")])).toBe(true);
  expect(SendBotMessageRequest.parse({ text: "hi" }).attachments).toEqual([]);
});

test.each([
  ["a sixth file", ["a", "b", "c", "d", "e", "f"].map((name) => file(`${name}.txt`))],
  ["a file over 10 MB", [file("big.bin", MAX_ATTACHMENT_BYTES + 1)]],
  ["a path for a name", [file("../notes.txt")]],
  ["two files with one name", [file("a.txt"), file("a.txt")]],
  ["a type that is not a MIME type", [{ ...file("a.txt"), mimeType: "text/plain\r\nx-evil: 1" }]],
  ["bytes that are not base64", [{ ...file("a.txt"), data: "not base64!" }]],
])("%s is refused", (_case, attachments) => {
  expect(sends(attachments)).toBe(false);
});
