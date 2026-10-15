import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// A fake Docker Engine API on a unix socket, for DockerProvider tests. It keeps
// containers, volumes and networks in memory and answers the handful of endpoints the
// provider calls with the status codes the real engine uses.

type FakeContainer = {
  name: string;
  running: boolean;
  // The body POST /containers/create received.
  config: Record<string, unknown>;
};

export function startFakeDockerEngine() {
  const socketPath = join(mkdtempSync(join(tmpdir(), "chiefbot-docker-")), "docker.sock");
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const notFound = (what: string) => Response.json({ message: `No such ${what}` }, { status: 404 });

  const server = Bun.serve({
    unix: socketPath,
    routes: {
      "/volumes/create": {
        POST: async (req) => {
          const { Name } = z.object({ Name: z.string() }).parse(await req.json());
          volumes.add(Name);
          return Response.json({ Name }, { status: 201 });
        },
      },
      "/volumes/:name": {
        DELETE: (req) => (volumes.delete(req.params.name) ? new Response(null, { status: 204 }) : notFound("volume")),
      },
      "/networks/create": {
        POST: async (req) => {
          const { Name } = z.object({ Name: z.string() }).parse(await req.json());
          if (networks.has(Name)) return Response.json({ message: "network exists" }, { status: 409 });
          networks.add(Name);
          return Response.json({ Id: Name, Warning: "" }, { status: 201 });
        },
      },
      "/networks/:name": {
        DELETE: (req) => (networks.delete(req.params.name) ? new Response(null, { status: 204 }) : notFound("network")),
      },
      "/containers/create": {
        POST: async (req) => {
          const name = new URL(req.url).searchParams.get("name") ?? "";
          if (containers.has(name)) return Response.json({ message: "Conflict" }, { status: 409 });
          containers.set(name, { name, running: false, config: z.record(z.string(), z.unknown()).parse(await req.json()) });
          return Response.json({ Id: name, Warnings: [] }, { status: 201 });
        },
      },
      "/containers/:name/start": {
        POST: (req) => setRunning(req.params.name, true),
      },
      "/containers/:name/stop": {
        POST: (req) => setRunning(req.params.name, false),
      },
      "/containers/:name/json": {
        GET: (req) => {
          const container = containers.get(req.params.name);
          if (!container) return notFound("container");
          return Response.json({ Name: `/${container.name}`, State: { Running: container.running } });
        },
      },
      "/containers/:name": {
        DELETE: (req) => {
          const container = containers.get(req.params.name);
          if (!container) return notFound("container");
          const force = new URL(req.url).searchParams.get("force") === "true";
          if (container.running && !force) return Response.json({ message: "container is running" }, { status: 409 });
          containers.delete(req.params.name);
          return new Response(null, { status: 204 });
        },
      },
    },
    fetch: () => Response.json({ message: "page not found" }, { status: 404 }),
  });

  // 304 when the container is already in that state, as the real engine answers.
  function setRunning(name: string, running: boolean) {
    const container = containers.get(name);
    if (!container) return notFound("container");
    if (container.running === running) return new Response(null, { status: 304 });
    container.running = running;
    return new Response(null, { status: 204 });
  }

  return { socketPath, containers, volumes, networks, stop: () => server.stop(true) };
}
