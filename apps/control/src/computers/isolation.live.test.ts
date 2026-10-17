import { expect, test } from "bun:test";
import { BotId } from "@chiefbot/contracts";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dockerProvider } from "./docker.ts";

// Opt-in: two bot computers side by side on real Docker (Colima) cannot see each
// other's files or reach each other over the network. Needs the image from
// `bun run computer:build`. Run with CHIEFBOT_DOCKER_TESTS=1 bun test isolation.live
const socketPath = process.env.CHIEFBOT_DOCKER_SOCKET ?? join(homedir(), ".colima/default/docker.sock");
const image = process.env.CHIEFBOT_COMPUTER_IMAGE ?? "chiefbot-computer:dev";

// Runs a command inside a bot's container; resolves to its exit code and stdout.
async function exec(botId: BotId, script: string) {
  const proc = Bun.spawn(["docker", "-H", `unix://${socketPath}`, "exec", `chiefbot-${botId}`, "sh", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, out: out.trim() };
}

const Inspect = z.object({
  Mounts: z.array(z.object({ Name: z.string().optional(), Destination: z.string() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }),
});
async function inspect(botId: BotId) {
  const res = await fetch(`http://docker/containers/chiefbot-${botId}/json`, { unix: socketPath });
  return Inspect.parse(await res.json());
}

// A GET that gives up after two seconds, run inside a bot. Exit 0 means it got an answer.
const fetchFrom = (url: string) =>
  `bun -e "await fetch('${url}', { signal: AbortSignal.timeout(2000) })"`;

test.skipIf(!process.env.CHIEFBOT_DOCKER_TESTS)(
  "bot A cannot read bot B's volume or reach bot B over the network",
  async () => {
    const computers = dockerProvider({ socketPath, image });
    const run = crypto.randomUUID().slice(0, 8);
    const a = BotId.parse(`bot_isoA_${run}`);
    const b = BotId.parse(`bot_isoB_${run}`);
    // No control here: the workers just keep retrying, which is all this test needs.
    const env = (botId: BotId) => ({
      CHIEFBOT_CONTROL_URL: "http://127.0.0.1:9",
      CHIEFBOT_BOT_ID: botId,
      CHIEFBOT_BOT_TOKEN: `token-${botId}`,
    });
    try {
      for (const botId of [a, b]) {
        await computers.create({ botId, env: env(botId) });
        await computers.start(botId);
      }

      // Files: B's secret is in B's home only. A's only mount is its own volume.
      expect((await exec(b, "echo b-secret > /home/bot/secret.txt")).code).toBe(0);
      expect((await exec(a, "cat /home/bot/secret.txt")).code).not.toBe(0);
      expect((await exec(a, `grep -rqs b-secret /home /tmp /opt /mnt /media`)).code).not.toBe(0);
      expect((await inspect(a)).Mounts).toEqual([
        expect.objectContaining({ Name: `chiefbot-${a}-home`, Destination: "/home/bot" }),
      ]);

      // No way around that from inside A: not root, no capabilities, no Docker socket.
      expect((await exec(a, "id -u")).out).not.toBe("0");
      expect((await exec(a, "grep CapEff /proc/self/status")).out).toBe("CapEff:\t0000000000000000");
      expect((await exec(a, "test -e /var/run/docker.sock")).code).not.toBe(0);
      expect((await exec(a, "printenv CHIEFBOT_BOT_TOKEN")).out).toBe(`token-${a}`);

      // Approvals: gh is absent and has no token, and every push runs the root-owned
      // pre-push hook. With no turn running nobody can approve, so the push fails.
      expect((await exec(a, "command -v gh")).code).not.toBe(0);
      expect((await exec(a, "printenv GH_TOKEN GITHUB_TOKEN")).out).toBe("");
      expect((await exec(a, "stat -c %U:%a /opt/chiefbot/hooks/pre-push && git config --system core.hooksPath")).out).toBe(
        "root:755\n/opt/chiefbot/hooks",
      );
      const push = await exec(
        a,
        "cd /tmp && git init -q --bare remote.git && git init -q work && cd work && git commit -q --allow-empty -m x && git push -q /tmp/remote.git HEAD:main 2>&1",
      );
      expect(push.code).not.toBe(0);
      expect(push.out).toContain("nobody can approve this push");
      expect((await exec(a, "git -C /tmp/remote.git rev-parse --verify -q main")).code).not.toBe(0);

      // Network: B serves on 8080 and answers itself, but A reaches it neither by IP nor by name.
      const bIp = Object.values((await inspect(b)).NetworkSettings.Networks)[0]?.IPAddress ?? "";
      expect(bIp).not.toBe("");
      await exec(b, `nohup bun -e "Bun.serve({ port: 8080, fetch: () => new Response('b') })" >/dev/null 2>&1 &`);
      let bUp = 1;
      for (let i = 0; i < 20 && bUp !== 0; i++) bUp = (await exec(b, fetchFrom(`http://${bIp}:8080`))).code;
      expect(bUp).toBe(0);
      expect((await exec(a, fetchFrom(`http://${bIp}:8080`))).code).not.toBe(0);
      expect((await exec(a, fetchFrom(`http://chiefbot-${b}:8080`))).code).not.toBe(0);
    } finally {
      for (const botId of [a, b]) await computers.destroy(botId, { deleteData: true });
    }
  },
  90_000,
);
