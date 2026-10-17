import type { BotId } from "@chiefbot/contracts";
import type { TCPSocketListener } from "bun";
import { startWorker } from "@chiefbot/worker";
import { fakeCopilot, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
import type { ComputerProvider, ComputerSpec } from "./computer.ts";

// An in-memory ComputerProvider for tests. A running computer is the real worker,
// started in this process with the env control handed over, so tests see the
// whole loop (create → worker dials control → bot online) without Docker.
// Every worker runs turns on the same fake Copilot. Its screen is a fake VNC
// server on TCP: it greets like one and records what it receives. With
// gitSocket, the workers serve git's credential helper there (one bot at a
// time: they share the path).
export function fakeComputers({ copilot = fakeCopilot(), gitSocket }: { copilot?: FakeCopilot; gitSocket?: string } = {}) {
  type FakeComputer = {
    spec: ComputerSpec;
    worker: ReturnType<typeof startWorker> | null;
    screen: TCPSocketListener | null;
  };
  const computers = new Map<BotId, FakeComputer>();
  // Every destroy call, so tests can check whether data was kept.
  const destroyed: Array<{ botId: BotId; deleteData: boolean }> = [];
  // What each bot's screen received from viewers, decoded as text.
  const screenInput = new Map<BotId, string[]>();

  // Stands in for x11vnc inside the computer.
  const fakeScreen = (botId: BotId) =>
    Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => void socket.write("RFB 003.008\n"),
        data(_socket, data) {
          screenInput.set(botId, [...(screenInput.get(botId) ?? []), new TextDecoder().decode(data)]);
        },
      },
    });

  // Stops a computer's worker and its screen.
  const halt = (computer: FakeComputer) => {
    computer.worker?.stop();
    computer.screen?.stop(true);
    computer.worker = null;
    computer.screen = null;
  };

  const get = (botId: BotId) => {
    const computer = computers.get(botId);
    if (!computer) throw new Error(`no computer for ${botId}`);
    return computer;
  };

  const provider: ComputerProvider = {
    async create(spec) {
      computers.set(spec.botId, { spec, worker: null, screen: null });
    },
    async start(botId) {
      const computer = get(botId);
      const { CHIEFBOT_CONTROL_URL, CHIEFBOT_BOT_ID, CHIEFBOT_BOT_TOKEN } = computer.spec.env;
      if (!CHIEFBOT_CONTROL_URL || !CHIEFBOT_BOT_ID || !CHIEFBOT_BOT_TOKEN) throw new Error("worker env missing");
      if (computer.worker) return;
      computer.screen = fakeScreen(computer.spec.botId);
      computer.worker = startWorker({
        controlUrl: CHIEFBOT_CONTROL_URL,
        botId: CHIEFBOT_BOT_ID,
        botToken: CHIEFBOT_BOT_TOKEN,
        copilot: copilot.copilot,
        screen: { hostname: "127.0.0.1", port: computer.screen.port },
        ...(gitSocket === undefined ? {} : { gitSocket }),
        retryMs: 20,
      });
    },
    async stop(botId) {
      halt(get(botId));
    },
    async destroy(botId, { deleteData }) {
      const computer = computers.get(botId);
      if (computer) halt(computer);
      computers.delete(botId);
      destroyed.push({ botId, deleteData });
    },
    async status(botId) {
      const computer = computers.get(botId);
      if (!computer) return "absent";
      return computer.worker ? "running" : "stopped";
    },
  };

  return {
    provider,
    copilot,
    computers,
    destroyed,
    screenInput,
    stopAll: () => {
      for (const computer of computers.values()) halt(computer);
    },
  };
}
