import { effectiveConfig, Project, ProjectFile, type Template } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TemplateForm, withTemplate } from "./ProjectTemplate.tsx";

const template: Template = {
  name: "shop-stack",
  title: "Shop stack",
  description: "A web app behind a gateway, with its API and database.",
  compose: "compose.yaml",
  services: { web: { context: "." }, api: { context: "services/api" }, gateway: { context: "." } },
  stages: [{ label: "Database", waitsFor: ["db"] }],
  seed: "seed",
  notes: ["The app: http://localhost:3000"],
};

// A project of octo-org/shop with `file` as its project file and `settings` as its settings.
function project(file: ProjectFile | null, settings = ""): Project {
  const { config, sources } = effectiveConfig(file, ProjectFile.parse(Bun.YAML.parse(settings) ?? {}));
  return Project.parse({
    id: "project_1",
    workspaceId: "workspace_1",
    name: "shop",
    repo: "octo-org/shop",
    file: file ? { status: "found", file } : { status: "missing" },
    settings,
    config,
    sources,
    model: "auto",
    effort: null,
  });
}

test("the picker writes the template, the project's own service and every other service into the settings, keeping the rest", () => {
  const settings = "# Ours\ncommands:\n  setup: bun install\ntemplate: old-stack\nservice: app\nsecrets: [API_KEY]\n";

  const text = withTemplate(settings, {
    template: "shop-stack",
    service: "web",
    services: { api: { repo: "octo-org/api", ref: "main" }, gateway: "stand-in" },
  });

  const written = "# Ours\ncommands:\n  setup: bun install\ntemplate: shop-stack\nservice: web\nsecrets: [ API_KEY ]\nservices:\n  api: { repo: octo-org/api, ref: main }\n  gateway: stand-in\n";
  expect(text).toBe(written);
  // Control's YAML reads it as the picker meant it.
  expect(ProjectFile.parse(Bun.YAML.parse(written))).toMatchObject({ template: "shop-stack", service: "web", services: { api: { repo: "octo-org/api", ref: "main" }, gateway: "stand-in" } });
});

test("the picker edits the services already in the settings in place, so their comments stay", () => {
  const settings = `# Our stack
template: shop-stack # picked by the team
service: web
# where the others run
services:
  # the API team's repo
  api: { repo: octo-org/api, ref: main } # until v2 ships
  gateway: stand-in # no repo yet
  web: stand-in
`;

  const text = withTemplate(settings, {
    template: "shop-stack",
    service: "web",
    services: { api: { repo: "octo-org/api", ref: "v2" }, gateway: { repo: "octo-org/gateway", ref: "main" } },
  });

  expect(text).toBe(`# Our stack
template: shop-stack # picked by the team
service: web
# where the others run
services:
  # the API team's repo
  api: { repo: octo-org/api, ref: v2 } # until v2 ships
  gateway: { repo: octo-org/gateway, ref: main }
`);
});

test("no template writes template: null, which turns a file's template off, and text that is not YAML is refused", () => {
  const settings = "template: shop-stack\nservice: web\nservices: { gateway: stand-in }\nworkers: { max: 3 }\n";

  expect(withTemplate(settings, { template: undefined, service: undefined, services: {} })).toBe("template: null\nworkers: { max: 3 }\n");
  expect(withTemplate("", { template: undefined, service: undefined, services: {} })).toBe("template: null\n");
  expect(withTemplate("commands: [unclosed", { template: "shop-stack", service: "web", services: {} })).toEqual({
    error: "Fix the YAML under Settings first, then pick a template.",
  });
});

// The markup as a person reads it, one space between words.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
// The <select> a label names, with its options.
const select = (html: string, label: string) => html.match(new RegExp(`<select[^>]*aria-label="${label}".*?</select>`))?.[0] ?? "";

test("the picker shows the config's template with its source, and one row per service: the project's own marked, each other on a repo or its stand-in", () => {
  const file = ProjectFile.parse({ template: "shop-stack", service: "web", services: { api: { repo: "octo-org/api", ref: "v2" } } });

  const html = renderToStaticMarkup(<TemplateForm project={project(file)} catalog={[template]} blocked={false} onSaved={() => {}} />);

  expect(select(html, "Template")).toContain('<option value="shop-stack" selected="">Shop stack</option>');
  expect(select(html, "Template")).toContain('<option value="">None (overrides the project file)</option>');
  expect(text(html)).toContain("A web app behind a gateway, with its API and database. file None (overrides the project file) Shop stack");
  expect(select(html, "This repo&#x27;s service")).toContain('<option value="web" selected="">web</option>');
  // The project's own service: no repo to point it at.
  expect(text(html)).toContain("This repo Which of the template's services octo-org/shop is.");
  expect(text(html)).toContain("web This repo Runs from octo-org/shop in each engineer's own clone, so edits show live.");
  expect(html).not.toContain('aria-label="Repo of web"');
  expect(html).toContain('aria-label="Repo of api"');
  expect(html).toContain('value="octo-org/api"');
  expect(html).toContain('value="v2"');
  // A service the config does not map runs its stand-in.
  expect(select(html, "Source of api")).toContain('<option value="repo" selected="">');
  expect(select(html, "Source of gateway")).toContain('<option value="stand-in" selected="">');
  expect(html).not.toContain('aria-label="Repo of gateway"');
});

test("with no template the picker offers the catalog and shows no service rows", () => {
  const html = renderToStaticMarkup(<TemplateForm project={project(null)} catalog={[template]} blocked={false} onSaved={() => {}} />);

  expect(select(html, "Template")).toContain('<option value="" selected="">None</option>');
  expect(html).toContain('<option value="shop-stack">Shop stack</option>');
  expect(html).not.toContain("This repo");
});

test("while the YAML under Settings has unsaved edits, the picker cannot save, and says why", () => {
  const html = renderToStaticMarkup(<TemplateForm project={project(null)} catalog={[template]} blocked onSaved={() => {}} />);

  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  expect(text(html)).toContain("Save or undo your edits under Settings first.");
});
