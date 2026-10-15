import { BotId } from "@chiefbot/contracts";
import { startWorker } from "@chiefbot/worker";
import type { ComputerProvider, ComputerSpec } from "./computer.ts";

// An in-memory ComputerProvider for tests. A running computer is the real worker,
// started in this process with the env control handed over, so tests see the
// whole loop (create → worker dials control → bot online) without Docker.
// Its screen is a fake websockify that greets like a VNC server and records what it receives.
export function fakeComputers() {
  type FakeComputer = { spec: ComputerSpec; worker: ReturnType<typeof startWorker> | null };
  const computers = new Map<BotId, FakeComputer>();
  // Every destroy call, so tests can check whether data was kept.
  const destroyed: Array<{ botId: BotId; deleteData: boolean }> = [];
  // What each bot's screen received from viewers, decoded as text.
  const screenInput = new Map<BotId, string[]>();
  let screens: Bun.Server<{ botId: BotId }> | null = null;

  // One server for every fake screen, started on first use; the path names the bot.
  function screenServer() {
    screens ??= Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const computer = computers.get(BotId.parse(new URL(req.url).pathname.slice(1)));
        if (!computer?.worker) return new Response(null, { status: 404 });
        return server.upgrade(req, { data: { botId: computer.spec.botId } }) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        data: {} as { botId: BotId },
        open: (ws) => void ws.send(new TextEncoder().encode("RFB 003.008\n")),
        message(ws, message) {
          const input = screenInput.get(ws.data.botId) ?? [];
          input.push(typeof message === "string" ? message : new TextDecoder().decode(message));
          screenInput.set(ws.data.botId, input);
        },
      },
    });
    return screens;
  }

  const get = (botId: BotId) => {
    const computer = computers.get(botId);
    if (!computer) throw new Error(`no computer for ${botId}`);
    return computer;
  };

  const provider: ComputerProvider = {
    async create(spec) {
      computers.set(spec.botId, { spec, worker: null });
    },
    async start(botId) {
      const computer = get(botId);
      const { CHIEFBOT_CONTROL_URL, CHIEFBOT_BOT_TOKEN } = computer.spec.env;
      if (!CHIEFBOT_CONTROL_URL || !CHIEFBOT_BOT_TOKEN) throw new Error("worker env missing");
      computer.worker ??= startWorker({ controlUrl: CHIEFBOT_CONTROL_URL, botToken: CHIEFBOT_BOT_TOKEN, retryMs: 20 });
    },
    async stop(botId) {
      const computer = get(botId);
      computer.worker?.stop();
      computer.worker = null;
    },
    async destroy(botId, { deleteData }) {
      computers.get(botId)?.worker?.stop();
      computers.delete(botId);
      destroyed.push({ botId, deleteData });
    },
    async status(botId) {
      const computer = computers.get(botId);
      if (!computer) return "absent";
      return computer.worker ? "running" : "stopped";
    },
    async screenUrl(botId) {
      if (!computers.get(botId)?.worker) return null;
      return `ws://127.0.0.1:${screenServer().port}/${botId}`;
    },
  };

  return {
    provider,
    computers,
    destroyed,
    screenInput,
    stopAll: () => {
      for (const computer of computers.values()) computer.worker?.stop();
      screens?.stop(true);
    },
  };
}
