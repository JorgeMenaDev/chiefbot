import type { ProjectFile, Template } from "@chiefbot/contracts";

// What is wrong with a project's template keys (ProjectFile's template, service and
// services: its config's, or its file's alone) against the catalog, or null.
// `repo` is the project's own repo: it is always the `service` it names, so no
// other service may run from it, and `services` cannot point that one elsewhere.
// Nothing else in the stack may need that service (neededBy), since an engineer
// runs it from its clone only once the rest is up.
// Control checks this when it reads the file, when settings are saved
// (projects.ts) and when a stack starts (taskWorkers.ts), and checks repo access apart.
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
  const needers = neededBy(picked, service);
  if (needers.length > 0) {
    const free = names.filter((name) => neededBy(picked, name).length === 0);
    return `service: ${service} is needed by ${list(needers)}, so it cannot run from the engineer's code. Pick a service the rest of the stack does not need${free.length > 0 ? `, such as ${free.join(" or ")}` : ""}.`;
  }
  for (const [name, source] of Object.entries(services)) {
    const problem =
      unknown(name) ??
      (name === service ? `${name} is this project's own service. It runs from ${repo}, in each engineer's clone.` : null) ??
      (source !== "stand-in" && source.repo.toLowerCase() === repo.toLowerCase() ? `${repo} is this project's own repo, which is already its ${service} service.` : null);
    if (problem) return `services.${name}: ${problem}`;
  }
  return null;
}

// What in `template`'s stack needs `own` to be up: each service the stack starts
// (every stage's, the seed, and all they need, but never `own`) that needs it,
// and each stage that waits for it with other services.
function neededBy({ stages, seed, needs }: Template, own: string): string[] {
  const started = new Set<string>();
  const start = (service: string) => {
    if (service === own || started.has(service)) return;
    started.add(service);
    for (const need of needs[service] ?? []) start(need);
  };
  for (const service of [...stages.flatMap(({ waitsFor }) => waitsFor), seed]) start(service);
  return [
    ...[...started].filter((service) => needs[service]?.includes(own)),
    ...stages.filter(({ waitsFor }) => waitsFor.length > 1 && waitsFor.includes(own)).map(({ label }) => `the ${label} stage`),
  ];
}

// "a", "a and b", "a, b and c".
const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));
