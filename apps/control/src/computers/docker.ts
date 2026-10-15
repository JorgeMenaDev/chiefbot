import { z } from "zod";
import type { BotId } from "@chiefbot/contracts";
import type { ComputerProvider } from "./computer.ts";

// ComputerProvider on a local Docker Engine (Colima on the Mac). One container per
// bot plus one named volume mounted as the bot's home (/home/bot, with the
// workspace inside it). Talks to the Engine API over its unix socket. The
// screen's websockify port is published on the host's loopback only, on a port
// Docker picks; control is its one client.

export type DockerProviderOptions = {
  // e.g. ~/.colima/default/docker.sock
  socketPath: string;
  // The bot computer image built from infra/computer.
  image: string;
};

// websockify's port inside the computer (infra/computer/start.sh).
const screenPort = "6080/tcp";

const ContainerInspect = z.object({
  State: z.object({ Running: z.boolean() }),
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()).nullable(),
  }),
});

export function dockerProvider({ socketPath, image }: DockerProviderOptions): ComputerProvider {
  const container = (botId: BotId) => `chiefbot-${botId}`;
  const volume = (botId: BotId) => `chiefbot-${botId}-home`;

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

  async function inspect(botId: BotId) {
    const res = await engine("GET", `/containers/${container(botId)}/json`, undefined, [404]);
    return res.status === 404 ? null : ContainerInspect.parse(await res.json());
  }

  return {
    async create({ botId, env }) {
      const labels = { "chiefbot.bot-id": botId };
      await engine("POST", "/volumes/create", { Name: volume(botId), Labels: labels });
      await engine("POST", `/containers/create?name=${container(botId)}`, {
        Image: image,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Labels: labels,
        ExposedPorts: { [screenPort]: {} },
        HostConfig: {
          // Empty HostPort: Docker picks a free one at each start.
          PortBindings: { [screenPort]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
          Mounts: [{ Type: "volume", Source: volume(botId), Target: "/home/bot" }],
          // tini as PID 1, so the worker gets SIGTERM and stop is quick.
          Init: true,
          // Back after a crash or a Colima restart, but not after stop().
          RestartPolicy: { Name: "unless-stopped" },
        },
      });
    },

    // 304 means it was already in that state.
    async start(botId) {
      await engine("POST", `/containers/${container(botId)}/start`, undefined, [304]);
    },

    async stop(botId) {
      await engine("POST", `/containers/${container(botId)}/stop`, undefined, [304]);
    },

    // 404 means it is already gone.
    async destroy(botId, { deleteData }) {
      await engine("DELETE", `/containers/${container(botId)}?force=true`, undefined, [404]);
      if (deleteData) await engine("DELETE", `/volumes/${volume(botId)}`, undefined, [404]);
    },

    async status(botId) {
      const info = await inspect(botId);
      if (!info) return "absent";
      return info.State.Running ? "running" : "stopped";
    },

    async screenUrl(botId) {
      const info = await inspect(botId);
      const binding = info?.State.Running ? info.NetworkSettings.Ports?.[screenPort]?.[0] : undefined;
      return binding ? `ws://127.0.0.1:${binding.HostPort}` : null;
    },
  };
}
