import { z } from "zod";
import { ConnectorName } from "./connectors.ts";

// A template: a kind of service stack an engineer can get beside its code, such as
// a UI with its API, gateway and database (docs/templates.md). The repo ships one
// folder per template, templates/<name>/: template.yaml (TemplateManifest), a
// compose file and the stand-in services it builds.

// A template's name is its folder's name, with a connector's naming rule.
export const TemplateName = ConnectorName;
export type TemplateName = z.infer<typeof TemplateName>;

// A service's name in the template's compose file.
const ComposeService = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "expected a compose service name, like api");

// A service a project may point at one of its repos instead of the stand-in.
//   context  the folder inside that repo its image builds from, like . or services/api
export const TemplateService = z.strictObject({
  context: z
    .string()
    .regex(/^[\w.-]+(\/[\w.-]+)*$/, "expected a folder inside the repo, like . or services/api")
    .refine((path) => !path.split("/").includes(".."), "expected a folder inside the repo, like . or services/api"),
});
export type TemplateService = z.infer<typeof TemplateService>;

// One setup step an engineer's task shows: its label, and the compose services
// that must be healthy (or, for a one-shot service, finished) before it passes.
export const TemplateStage = z.strictObject({
  label: z.string().trim().min(1).max(40),
  waitsFor: z.array(ComposeService).min(1),
});
export type TemplateStage = z.infer<typeof TemplateStage>;

// templates/<name>/template.yaml: only what Chiefbot needs that compose cannot say.
//   compose   the compose file, in the template's folder
//   services  the compose services a project may point at a repo, each with its build context
//   stages    the setup steps, in order
//   seed      the one-shot compose service that fills the database
//   notes     lines for the engineer's brief: the app's URLs and how to sign in as the
//             seeded user. Stand-ins use dev-only sample values, never secrets.
// Control checks the names against the compose file when it loads the catalog.
export const TemplateManifest = z.strictObject({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(200),
  compose: z.string().regex(/^[\w.-]+\.ya?ml$/, "expected a compose file in the template's folder, like compose.yaml"),
  services: z.record(ComposeService, TemplateService).refine((services) => Object.keys(services).length > 0, "expected at least one service"),
  stages: z.array(TemplateStage).min(1),
  seed: ComposeService,
  notes: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
});
export type TemplateManifest = z.infer<typeof TemplateManifest>;

// One row of GET /templates: a template the repo ships, by its folder's name.
export const Template = TemplateManifest.extend({ name: TemplateName });
export type Template = z.infer<typeof Template>;
