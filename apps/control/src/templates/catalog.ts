import { computerPorts, TemplateManifest, TemplateName, type Template } from "@chiefbot/contracts";
import { join } from "node:path";
import { z } from "zod";
import { catalogFolders, readYaml } from "../catalogFolders.ts";

// The templates the repo ships: templates/ at its root.
export const repoTemplates = join(import.meta.dir, "../../../../templates");

// One entry of a compose service's `ports` (short syntax "[ip:][published:]target[/protocol]",
// or long syntax) or `expose` ("target[/protocol]"). A port may be a range, "a-b".
const Port = z.union([z.number(), z.string()]);
const PortEntry = z.union([Port, z.object({ target: Port, published: Port.optional() })]);

// The parts of a compose file the catalog checks. Compose checks the rest when it runs.
const ComposeFile = z.object({
  services: z.record(
    z.string(),
    z.object({
      build: z.unknown().optional(),
      ports: z.array(PortEntry).default([]),
      expose: z.array(Port).default([]),
    }),
  ),
});

// Reads every template folder in `dir` (templates/<name>/template.yaml and the compose
// file it names), in name order. Control calls it once at startup: a folder that
// breaks a rule throws, naming the file and what is wrong, so control does not start.
// The rules: the folder's name, the manifest's contract, every service, stage and
// seed it names is a service of the compose file (a service a repo may replace has a
// build), and no compose service binds or publishes a port the engineer computer
// uses itself (computerPorts), since the stack joins the computer's network namespace.
export function loadTemplates(dir: string): Template[] {
  return catalogFolders(dir, TemplateName).map(({ name, file }) => {
    const manifestFile = file("template.yaml");
    const manifest = TemplateManifest.safeParse(readYaml(manifestFile));
    if (!manifest.success) throw new Error(`${manifestFile}: ${z.prettifyError(manifest.error)}`);
    const { compose, services, stages, seed } = manifest.data;
    const composeFile = file(compose);
    const parsed = ComposeFile.safeParse(readYaml(composeFile));
    if (!parsed.success) throw new Error(`${composeFile}: ${z.prettifyError(parsed.error)}`);
    const composed = parsed.data.services;

    const refuse = (problem: string) => new Error(`${manifestFile}: ${problem}`);
    for (const service of Object.keys(services)) {
      if (!composed[service]) throw refuse(`service ${service} is not in ${compose}`);
      if (composed[service].build === undefined) throw refuse(`service ${service} has no build in ${compose}, so a repo cannot replace it`);
    }
    for (const { label, waitsFor } of stages) {
      const missing = waitsFor.find((service) => !composed[service]);
      if (missing) throw refuse(`stage ${label} waits for ${missing}, which ${compose} has no service for`);
    }
    if (!composed[seed]) throw refuse(`seed ${seed} is not in ${compose}`);

    for (const [service, { ports, expose }] of Object.entries(composed)) {
      for (const entry of [...ports, ...expose]) {
        for (const text of portsOf(entry)) {
          const range = /^(\d+)(?:-(\d+))?$/.exec(text);
          if (!range) throw new Error(`${composeFile}: service ${service}: cannot read the port ${typeof entry === "object" ? JSON.stringify(entry) : entry}`);
          const from = Number(range[1]);
          const to = range[2] === undefined ? from : Number(range[2]);
          const clash = Object.values(computerPorts).find(({ port }) => port >= from && port <= to);
          if (clash) throw new Error(`${composeFile}: service ${service} binds port ${clash.port}, which the engineer computer uses for ${clash.use}`);
        }
      }
    }
    return { ...manifest.data, name };
  });
}

// The ports a compose port entry names, each a number or a range: its target, and its
// published port when it names one. The host IP and the protocol drop.
function portsOf(entry: z.infer<typeof PortEntry>): string[] {
  if (typeof entry === "number") return [String(entry)];
  if (typeof entry === "object") return [entry.target, entry.published ?? ""].map(String).filter(Boolean);
  // "[ip:][published:]target": the last two parts (an IPv6 host IP is in brackets before them).
  return entry.replace(/\/[a-z]+$/, "").split(":").slice(-2).filter(Boolean);
}
