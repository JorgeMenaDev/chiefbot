import { expect, test } from "bun:test";
import { Bot, SignInResponse } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { gitProxyConfig } from "@chiefbot/worker/git-proxy";
import { homedir } from "node:os";
import { join } from "node:path";
import { startControl } from "../control.ts";
import { dockerProvider } from "./docker.ts";

// Opt-in: the whole loop on real Docker (Colima). Needs the image from
// `bun run computer:build`. Run with CHIEFBOT_DOCKER_TESTS=1 bun test docker.live
const socketPath = process.env.CHIEFBOT_DOCKER_SOCKET ?? join(homedir(), ".colima/default/docker.sock");
const image = process.env.CHIEFBOT_COMPUTER_IMAGE ?? "chiefbot-computer:dev";

test.skipIf(!process.env.CHIEFBOT_DOCKER_TESTS)(
  "a bot's container starts, its worker comes online, its screen greets through control, and stop and delete clean up",
  async () => {
    const github = startFakeGitHub();
    const computers = dockerProvider({ socketPath, image });
    const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers });
    const port = new URL(control.url).port;
    // Restart control with the URL containers reach it on, now that the port is known.
    control.stop();
    const live = startControl({
      port: Number(port),
      dbPath: ":memory:",
      githubApiUrl: github.url,
      githubClientId: "test-client",
      githubApp: github.app,
      computers,
      workerControlUrl: `http://host.docker.internal:${port}`,
    });
    try {
      const { accessToken, refreshToken } = github.issueTokens();
      const signIn = await fetch(`${live.url}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          accessToken,
          accessTokenExpiresAt: Date.now() + 8 * 3600_000,
          refreshToken,
          refreshTokenExpiresAt: Date.now() + 180 * 86400_000,
        }),
      });
      const auth = { authorization: `Bearer ${SignInResponse.parse(await signIn.json()).sessionToken}` };
      const listBots = async () => Bot.array().parse(await (await fetch(`${live.url}/bots`, { headers: auth })).json());

      const created = await fetch(`${live.url}/bots`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Ada" }) });
      const bot = Bot.parse(await created.json());
      expect(await computers.status(bot.id)).toBe("running");
      for (let i = 0; i < 100 && (await listBots())[0]?.status !== "online"; i++) await Bun.sleep(200);
      expect((await listBots())[0]?.status).toBe("online");

      // Git inside the computer, set up as the worker sets up the agent's shell,
      // clones github.com through control's proxy with the image's credential
      // helper. A push outside a turn fails in control: nobody can approve it.
      github.createRepo("octo/demo", { "README.md": "# Demo\n" });
      const gitEnv = Object.entries(gitProxyConfig({ controlUrl: `http://host.docker.internal:${port}` })).flatMap(
        ([name, value]) => ["-e", `${name}=${value}`],
      );
      const inBot = async (script: string) => {
        const proc = Bun.spawn(["docker", "-H", `unix://${socketPath}`, "exec", ...gitEnv, `chiefbot-${bot.id}`, "sh", "-c", `${script} 2>&1`], {
          stdout: "pipe",
        });
        const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
        return { code, out: out.trim() };
      };
      // Every connection's CLI is installed, and no turn's connection is staged between turns.
      expect((await inBot("acli --version >/dev/null && harness --version >/dev/null")).code).toBe(0);
      expect(await inBot("ls /tmp/chiefbot")).toEqual({ code: 2, out: "ls: cannot access '/tmp/chiefbot': No such file or directory" });

      expect(await inBot("cd /tmp && git clone -q https://github.com/octo/demo.git demo && git -C demo log --format=%s")).toEqual({
        code: 0,
        out: "Initial commit",
      });
      const push = await inBot("cd /tmp/demo && git commit -q --allow-empty -m x && git push -q origin HEAD:main");
      expect(push.code).not.toBe(0);
      expect(push.out).toContain("No turn is running, so nobody can approve this push.");
      expect(github.pushes).toEqual([]);

      // Its screen's VNC server greets a viewer through control (Xvfb and x11vnc are up).
      const viewer = new WebSocket(`${live.url.replace("http", "ws")}/bots/${bot.id}/screen`, { headers: auth });
      viewer.binaryType = "arraybuffer";
      const greeting = await new Promise<string>((resolve, reject) => {
        viewer.onmessage = (event) =>
          resolve(event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : String(event.data));
        viewer.onclose = () => reject(new Error("screen closed before the VNC greeting"));
      });
      viewer.onclose = null;
      viewer.close();
      expect(greeting).toBe("RFB 003.008\n");

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
