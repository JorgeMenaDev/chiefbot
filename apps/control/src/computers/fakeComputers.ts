import type { BotId } from "@chiefbot/contracts";
import { startWorker } from "@chiefbot/worker";
import { fakeCopilot, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
import type { ComputerProvider, ComputerSpec } from "./computer.ts";

// An in-memory ComputerProvider for tests. A running computer is the real worker,
// started in this process with the env control handed over, so tests see the
// whole loop (create → worker dials control → bot online) without Docker.
// Every worker runs turns on the same fake Copilot.
export function fakeComputers({ copilot = fakeCopilot() }: { copilot?: FakeCopilot } = {}) {
  type FakeComputer = { spec: ComputerSpec; worker: ReturnType<typeof startWorker> | null };
  const computers = new Map<BotId, FakeComputer>();
  // Every destroy call, so tests can check whether data was kept.
  const destroyed: Array<{ botId: BotId; deleteData: boolean }> = [];

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
      const { CHIEFBOT_CONTROL_URL, CHIEFBOT_BOT_ID, CHIEFBOT_BOT_TOKEN } = computer.spec.env;
      if (!CHIEFBOT_CONTROL_URL || !CHIEFBOT_BOT_ID || !CHIEFBOT_BOT_TOKEN) throw new Error("worker env missing");
      computer.worker ??= startWorker({
        controlUrl: CHIEFBOT_CONTROL_URL,
        botId: CHIEFBOT_BOT_ID,
        botToken: CHIEFBOT_BOT_TOKEN,
        copilot: copilot.copilot,
        retryMs: 20,
      });
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
  };

  return {
    provider,
    copilot,
    computers,
    destroyed,
    stopAll: () => {
      for (const computer of computers.values()) computer.worker?.stop();
    },
  };
}
