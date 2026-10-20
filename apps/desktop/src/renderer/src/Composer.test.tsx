import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "./Composer.tsx";

test("while a message is being sent the composer keeps its prompt and files as sent", () => {
  const html = renderToStaticMarkup(
    <Composer
      placeholder="Message Ada"
      draft="look at [notes.txt]"
      onDraft={() => {}}
      onSend={() => {}}
      canSend={false}
      locked
      error={null}
      attachments={{ items: [{ id: "1", name: "notes.txt", mimeType: "text/plain", size: 2, data: "aGk=" }], onChange: () => {} }}
    />,
  );
  expect(html).toMatch(/<textarea[^>]*readOnly=""/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Attach files"|<button[^>]*aria-label="Attach files"[^>]*disabled=""/);
});
