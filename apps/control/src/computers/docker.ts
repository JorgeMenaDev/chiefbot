import { z } from "zod";
import type { ComputerId, ComputerProvider } from "./computer.ts";

// ComputerProvider on a local Docker Engine (Colima on the Mac). One container per
// bot plus one named volume mounted as the bot's home (/home/bot, with the
// workspace inside it) and one bridge network of its own, so bots cannot reach
// each other. Talks to the Engine API over its unix socket. docs/isolation.md
// lists the boundaries.

export type DockerProviderOptions = {
  // e.g. ~/.colima/default/docker.sock
  socketPath: string;
  // The bot computer image built from infra/computer.
  image: string;
};

const ContainerInspect = z.object({ State: z.object({ Running: z.boolean() }) });

export function dockerProvider({ socketPath, image }: DockerProviderOptions): ComputerProvider {
  const container = (id: ComputerId) => `chiefbot-${id}`;
  const volume = (id: ComputerId) => `chiefbot-${id}-home`;
  const network = (id: ComputerId) => `chiefbot-${id}-net`;

  // One Engine API call. Statuses in `ok` count as success besides 2xx.
  async function engine(method: string, path: string, body?: unknown, ok: number[] = []) {
    const res = await fetch(`http://docker${path}`, {
      method,
      unix: socketPath,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok && !ok.includes(res.status)) {
      throw new Error(`Docker ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  return {
    async create({ id, env }) {
      const labels = { "chiefbot.computer-id": id };
      await engine("POST", "/volumes/create", { Name: volume(id), Labels: labels });
      await engine("POST", "/networks/create", { Name: network(id), Driver: "bridge", Labels: labels });
      await engine("POST", `/containers/create?name=${container(id)}`, {
        Image: image,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Labels: labels,
        // Non-root even if the image forgets USER.
        User: "bot",
        HostConfig: {
          // The bot's volume is its only mount: never the Docker socket or a host path.
          Mounts: [{ Type: "volume", Source: volume(id), Target: "/home/bot" }],
          NetworkMode: network(id),
          // Docker Desktop, OrbStack and Colima resolve host.docker.internal on
          // their own; Docker Engine on Linux only with this. The default worker
          // URL dials control there (index.ts), so a Linux host needs control
          // listening beyond 127.0.0.1 (docs/deploy.md).
          ExtraHosts: ["host.docker.internal:host-gateway"],
          // The bot runs as a plain user: it needs no Linux capabilities, and nothing may gain them.
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          // tini as PID 1, so the worker gets SIGTERM and stop is quick.
          Init: true,
          // Back after a crash or a Colima restart, but not after stop().
          RestartPolicy: { Name: "unless-stopped" },
        },
      });
    },

    // 304 means it was already in that state.
    async start(id) {
      await engine("POST", `/containers/${container(id)}/start`, undefined, [304]);
    },

    async stop(id) {
      await engine("POST", `/containers/${container(id)}/stop`, undefined, [304]);
    },

    // 404 means it is already gone. The network holds no data, so it always goes.
    async destroy(id, { deleteData }) {
      await engine("DELETE", `/containers/${container(id)}?force=true`, undefined, [404]);
      await engine("DELETE", `/networks/${network(id)}`, undefined, [404]);
      if (deleteData) await engine("DELETE", `/volumes/${volume(id)}`, undefined, [404]);
    },

    async status(id) {
      const res = await engine("GET", `/containers/${container(id)}/json`, undefined, [404]);
      if (res.status === 404) return "absent";
      return ContainerInspect.parse(await res.json()).State.Running ? "running" : "stopped";
    },
  };
}
