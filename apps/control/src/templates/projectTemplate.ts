import type { ProjectFile, Template } from "@chiefbot/contracts";

// What is wrong with a project's template keys (ProjectFile's template, service and
// services: its config's, or its file's alone) against the catalog, or null.
// `repo` is the project's own repo: it is always the `service` it names, so no
// other service may run from it, and `services` cannot point that one elsewhere.
// Control checks this when it reads the file and when settings are saved
// (projects.ts), and checks repo access apart.
export function templateProblem({ template, service, services = {} }: Pick<ProjectFile, "template" | "service" | "services">, repo: string, catalog: Template[]): string | null {
  // No template, or `template: null` in a file (null in settings is gone from the config).
  if (template === undefined || template === null) {
    if (service !== undefined) return "service: pick a template first.";
    return Object.keys(services).length > 0 ? "services: pick a template first." : null;
  }
  const picked = catalog.find(({ name }) => name === template);
  if (!picked) {
    return `template: no template is named ${template}. ${catalog.length > 0 ? `The catalog has ${catalog.map(({ name }) => name).join(", ")}.` : "The catalog has none."}`;
  }
  const names = Object.keys(picked.services);
  const unknown = (name: string) => (names.includes(name) ? null : `${template} has no service ${name}. Its services are ${names.join(", ")}.`);
  if (service === undefined) return `service: name the template service ${repo} is, one of ${names.join(", ")}.`;
  const ownUnknown = unknown(service);
  if (ownUnknown) return `service: ${ownUnknown}`;
  for (const [name, source] of Object.entries(services)) {
    const problem =
      unknown(name) ??
      (name === service ? `${name} is this project's own service. It runs from ${repo}, in each engineer's clone.` : null) ??
      (source !== "stand-in" && source.repo.toLowerCase() === repo.toLowerCase() ? `${repo} is this project's own repo, which is already its ${service} service.` : null);
    if (problem) return `services.${name}: ${problem}`;
  }
  return null;
}
