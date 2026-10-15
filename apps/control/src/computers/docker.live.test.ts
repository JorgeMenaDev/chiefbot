import { expect, test } from "bun:test";
import { Bot, SignInResponse } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { homedir } from "node:os";
import { join } from "node:path";
import { startControl } from "../control.ts";
import { dockerProvider } from "./docker.ts";

// Opt-in: the whole loop on real Docker (Colima). Needs the image from
// `bun run computer:build`. Run with CHIEFBOT_DOCKER_TESTS=1 bun test docker.live
const socketPath = process.env.CHIEFBOT_DOCKER_SOCKET ?? join(homedir(), ".colima/default/docker.sock");

test.skipIf(!process.env.CHIEFBOT_DOCKER_TESTS)(
  "a bot's container starts, its worker comes online, and stop and delete clean up",
  async () => {
    const github = startFakeGitHub();
    const computers = dockerProvider({ socketPath, image: "chiefbot-computer:dev" });
    const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, computers });
    const port = new URL(control.url).port;
    // Restart control with the URL containers reach it on, now that the port is known.
    control.stop();
    const live = startControl({
      port: Number(port),
      dbPath: ":memory:",
      githubApiUrl: github.url,
      computers,
      workerControlUrl: `http://host.docker.internal:${port}`,
    });
    try {
      const { accessToken, refreshToken } = github.issueTokens();
      const signIn = await fetch(`${live.url}/sessions`, {
        method: "POST",
        body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken, refreshTokenExpiresAt: 0 }),
      });
      const auth = { authorization: `Bearer ${SignInResponse.parse(await signIn.json()).sessionToken}` };
      const listBots = async () => Bot.array().parse(await (await fetch(`${live.url}/bots`, { headers: auth })).json());

      const created = await fetch(`${live.url}/bots`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Ada" }) });
      const bot = Bot.parse(await created.json());
      expect(await computers.status(bot.id)).toBe("running");
      for (let i = 0; i < 100 && (await listBots())[0]?.status !== "online"; i++) await Bun.sleep(200);
      expect((await listBots())[0]?.status).toBe("online");

      await fetch(`${live.url}/bots/${bot.id}/stop`, { method: "POST", headers: auth });
      expect(await computers.status(bot.id)).toBe("stopped");

      await fetch(`${live.url}/bots/${bot.id}?deleteData=true`, { method: "DELETE", headers: auth });
      expect(await computers.status(bot.id)).toBe("absent");
      const volume = await fetch(`http://docker/volumes/chiefbot-${bot.id}-home`, { unix: socketPath });
      expect(volume.status).toBe(404);
    } finally {
      live.stop();
      github.stop();
    }
  },
  60_000,
);
