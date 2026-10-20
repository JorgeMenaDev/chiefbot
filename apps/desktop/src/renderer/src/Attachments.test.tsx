import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentTray, recentReads } from "./Attachments.tsx";

test("a chat keeps only its last few images read, and reads one again once it has let it go", async () => {
  const reads: string[] = [];
  const read = recentReads(async (id: string) => {
    reads.push(id);
    return `data:${id}`;
  }, 2);

  for (const id of ["a", "b", "a", "c", "a", "b"]) await read(id);

  // "b" went when "c" came, as "a" was read more recently.
  expect(reads).toEqual(["a", "b", "c", "b"]);
});

test("an image that could not be read is read again next time", async () => {
  let fail = true;
  const read = recentReads(async (id: string) => {
    if (fail) throw new Error("offline");
    return id;
  }, 2);

  await read("a").catch(() => {});
  fail = false;

  expect(await read("a")).toBe("a");
});

test("a document keeps its removable row while the prompt shows its chip", () => {
  const html = renderToStaticMarkup(
    <AttachmentTray attachments={[{ id: "1", name: "notes.txt", mimeType: "text/plain", size: 2, data: "aGk=" }]} onRemove={() => {}} />,
  );
  expect(html).toContain('aria-label="Remove notes.txt"');
});
