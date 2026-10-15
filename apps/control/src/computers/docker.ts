import { z } from "zod";
import type { BotId } from "@chiefbot/contracts";
import type { ComputerProvider } from "./computer.ts";

// ComputerProvider on a local Docker Engine (Colima on the Mac). One container per
// bot plus one named volume mounted as the bot's home (/home/bot, with the
// workspace inside it). Talks to the Engine API over its unix socket.

export type DockerProviderOptions = {
  // e.g. ~/.colima/default/docker.sock
  socketPath: string;
  // The bot computer image built from infra/computer.
  image: string;
};

const ContainerInspect = z.object({ State: z.object({ Running: z.boolean() }) });

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

  return {
    async create({ botId, env }) {
      const labels = { "chiefbot.bot-id": botId };
      await engine("POST", "/volumes/create", { Name: volume(botId), Labels: labels });
      await engine("POST", `/containers/create?name=${container(botId)}`, {
        Image: image,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Labels: labels,
        HostConfig: {
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
      const res = await engine("GET", `/containers/${container(botId)}/json`, undefined, [404]);
      if (res.status === 404) return "absent";
      return ContainerInspect.parse(await res.json()).State.Running ? "running" : "stopped";
    },
  };
}
