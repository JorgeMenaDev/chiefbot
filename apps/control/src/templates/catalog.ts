import { computerPorts, TemplateManifest, TemplateName, type Template } from "@chiefbot/contracts";
import { join } from "node:path";
import { z } from "zod";
import { catalogFolders, readYaml } from "../catalogFolders.ts";

// The templates the repo ships: templates/ at its root.
export const repoTemplates = join(import.meta.dir, "../../../../templates");

// One entry of a compose service's `ports` (short syntax "[ip:][published:]target[/protocol]",
// or long syntax) or `expose` ("target[/protocol]"). A port may be a range, "a-b".
const Port = z.union([z.number(), z.string()]);
const PortEntry = z.union([Port, z.object({ target: Port, protocol: z.string().optional() })]);

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

// A build a repo can replace: the folder its image builds from, or { context: <folder>, … }.
const RepoBuild = z.union([z.string().min(1), z.looseObject({ context: z.string().min(1) })]);

// Reads every template folder in `dir` (templates/<name>/template.yaml and the compose
// file it names), in name order. Control calls it once at startup: a folder that
// breaks a rule throws, naming the file and what is wrong, so control does not start.
// The rules: the folder's name, the manifest's contract, every service, stage and
// seed it names is a service of the compose file (a service a repo may replace has a
// build with a context), and no compose service binds a port the engineer computer
// listens on itself (computerPorts, same port and protocol) inside the namespace,
// which the stack joins. A port published on the Docker host is not in the namespace.
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

    // Only the file's own services: `toString` is no service.
    const has = (service: string) => Object.hasOwn(composed, service);
    const refuse = (problem: string) => new Error(`${manifestFile}: ${problem}`);
    for (const service of Object.keys(services)) {
      if (!has(service)) throw refuse(`service ${service} is not in ${compose}`);
      if (!RepoBuild.safeParse(composed[service]?.build).success) {
        throw refuse(`service ${service} needs a build in ${compose}, a folder or { context: <folder> }, so a repo can replace it`);
      }
    }
    for (const { label, waitsFor } of stages) {
      const missing = waitsFor.find((service) => !has(service));
      if (missing) throw refuse(`stage ${label} waits for ${missing}, which ${compose} has no service for`);
    }
    if (!has(seed)) throw refuse(`seed ${seed} is not in ${compose}`);

    for (const [service, { ports, expose }] of Object.entries(composed)) {
      for (const entry of [...ports, ...expose]) {
        const { port, protocol } = bound(entry);
        const range = /^(\d+)(?:-(\d+))?$/.exec(port);
        if (!range) throw new Error(`${composeFile}: service ${service}: cannot read the port ${typeof entry === "object" ? JSON.stringify(entry) : entry}`);
        const from = Number(range[1]);
        const to = range[2] === undefined ? from : Number(range[2]);
        const clash = Object.values(computerPorts).find((own) => own.protocol === protocol && own.port >= from && own.port <= to);
        if (clash) throw new Error(`${composeFile}: service ${service} binds port ${clash.port}/${clash.protocol}, which the engineer computer uses for ${clash.use}`);
      }
    }
    return { ...manifest.data, name };
  });
}

// The port (a number or a range "a-b") and protocol a compose port entry binds inside
// the namespace: its target. The host IP and the published port are the Docker host's.
function bound(entry: z.infer<typeof PortEntry>): { port: string; protocol: string } {
  if (typeof entry === "number") return { port: String(entry), protocol: "tcp" };
  if (typeof entry === "object") return { port: String(entry.target), protocol: (entry.protocol ?? "tcp").toLowerCase() };
  // "[ip:][published:]target[/protocol]": the target is the last part (an IPv6 host IP is in brackets).
  const [ports = "", protocol = "tcp"] = entry.split("/");
  return { port: ports.split(":").at(-1) ?? "", protocol: protocol.toLowerCase() };
}
