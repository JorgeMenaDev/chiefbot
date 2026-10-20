import type { Connection } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldsForm } from "./ConnectApps.tsx";

const connection: Connection = {
  name: "tool",
  title: "Tool",
  description: "A tool.",
  setup: ["Open [Tokens](https://tool.example/tokens) and create one.", "Pick an expiry date.", "Copy it."],
  withoutAsking: "Read things.",
  asksFirst: "Change things.",
  fields: {
    site: { label: "Site", secret: false, placeholder: "tool.example" },
    token: { label: "Token", secret: true, help: "From step 1, read-only." },
  },
  on: false,
};

test("the Connect form shows the steps above the fields, their links, help under a field and its example", () => {
  const html = renderToStaticMarkup(<FieldsForm connection={connection} busy={false} onSave={async () => {}} onCancel={() => {}} />);

  expect(html.indexOf("Pick an expiry date.")).toBeLessThan(html.indexOf("Site"));
  expect(html).toContain('<li>Open <a class="text-primary underline-offset-4 hover:underline" href="https://tool.example/tokens" target="_blank" rel="noreferrer">Tokens</a> and create one.</li>');
  expect(html).toContain("Read things.");
  expect(html).toContain("Change things.");
  expect(html).toContain('placeholder="tool.example"');
  expect(html.indexOf("From step 1, read-only.")).toBeGreaterThan(html.indexOf('type="password"'));
});
