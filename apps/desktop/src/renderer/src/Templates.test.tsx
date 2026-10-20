import type { Template } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TemplateRow } from "./Templates.tsx";

const template: Template = {
  name: "shop",
  title: "Shop",
  description: "A web app behind a gateway, with its database.",
  compose: "compose.yaml",
  services: { web: { context: "." }, api: { context: "services/api" } },
  stages: [
    { label: "Database", waitsFor: ["db"] },
    { label: "API", waitsFor: ["api", "gateway"] },
    { label: "Seed", waitsFor: ["seed"] },
  ],
  seed: "seed",
  notes: ["The app: http://localhost:3000"],
};

// The row's text as a person reads it, one space between words.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("a template's row shows its name, what it is, the services a repo may replace and its setup stages in order", () => {
  const row = text(renderToStaticMarkup(<TemplateRow template={template} />));

  expect(row).toStartWith("Shop shop A web app behind a gateway, with its database.");
  expect(row).toContain("From a repo web, api");
  expect(row).toContain("Setup Database: db API: api, gateway Seed: seed");
});
