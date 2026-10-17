import type { TCPSocketListener } from "bun";
import { startWorker } from "@chiefbot/worker";
import { startCoordinator } from "@chiefbot/worker/coordinator";
import type { Clock } from "@chiefbot/worker/clock";
import { fakeCopilot, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
import type { ComputerId, ComputerProvider, ComputerSpec } from "./computer.ts";

// An in-memory ComputerProvider for tests. A running computer is the real worker
// (a bot's or a task worker's; or, on a project's computer, the real coordinator), started in this process
// with the env control handed over, so tests see the whole loop (create → worker
// dials control → bot online) without Docker. Every worker and coordinator runs
// turns on the same fake Copilot. Its screen is a fake VNC
// server on TCP: it greets like one and records what it receives. With
// gitSocket, the workers serve git's credential helper there (one bot at a
// time: they share the path). Workers renew organizations' tokens on `clock`.
export function fakeComputers({ copilot = fakeCopilot(), gitSocket, clock }: { copilot?: FakeCopilot; gitSocket?: string; clock?: Clock } = {}) {
  type FakeComputer = {
    spec: ComputerSpec;
    worker: ReturnType<typeof startWorker> | null;
    // A project's computer runs its coordinator instead.
    coordinator: ReturnType<typeof startCoordinator> | null;
    screen: TCPSocketListener | null;
  };
  const computers = new Map<ComputerId, FakeComputer>();
  // Every destroy call, so tests can check whether data was kept.
  const destroyed: Array<{ id: ComputerId; deleteData: boolean }> = [];
  // What each bot's screen received from viewers, decoded as text.
  const screenInput = new Map<ComputerId, string[]>();

  // Stands in for x11vnc inside the computer.
  const fakeScreen = (id: ComputerId) =>
    Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => void socket.write("RFB 003.008\n"),
        data(_socket, data) {
          screenInput.set(id, [...(screenInput.get(id) ?? []), new TextDecoder().decode(data)]);
        },
      },
    });

  // Stops a computer's worker or coordinator, and its screen.
  const halt = (computer: FakeComputer) => {
    computer.worker?.stop();
    computer.coordinator?.stop();
    computer.screen?.stop(true);
    computer.worker = null;
    computer.coordinator = null;
    computer.screen = null;
  };

  const get = (id: ComputerId) => {
    const computer = computers.get(id);
    if (!computer) throw new Error(`no computer for ${id}`);
    return computer;
  };

  const provider: ComputerProvider = {
    async create(spec) {
      computers.set(spec.id, { spec, worker: null, coordinator: null, screen: null });
    },
    async start(id) {
      const computer = get(id);
      if (computer.worker || computer.coordinator) return;
      const env = computer.spec.env;
      if (!env.CHIEFBOT_CONTROL_URL) throw new Error("worker env missing");
      // A project's computer runs its coordinator.
      if (env.CHIEFBOT_PROJECT_ID && env.CHIEFBOT_PROJECT_TOKEN) {
        computer.coordinator = startCoordinator({
          controlUrl: env.CHIEFBOT_CONTROL_URL,
          projectId: env.CHIEFBOT_PROJECT_ID,
          projectToken: env.CHIEFBOT_PROJECT_TOKEN,
          copilot: copilot.copilot,
          retryMs: 20,
        });
        return;
      }
      const { CHIEFBOT_CONTROL_URL, CHIEFBOT_BOT_ID, CHIEFBOT_BOT_TOKEN, CHIEFBOT_TASK_WORKER_ID, CHIEFBOT_TASK_WORKER_TOKEN } = env;
      const agent =
        CHIEFBOT_TASK_WORKER_ID && CHIEFBOT_TASK_WORKER_TOKEN
          ? { route: "task-worker" as const, id: CHIEFBOT_TASK_WORKER_ID, token: CHIEFBOT_TASK_WORKER_TOKEN }
          : CHIEFBOT_BOT_ID && CHIEFBOT_BOT_TOKEN
            ? { id: CHIEFBOT_BOT_ID, token: CHIEFBOT_BOT_TOKEN }
            : null;
      if (!agent) throw new Error("worker env missing");
      computer.screen = fakeScreen(computer.spec.id);
      computer.worker = startWorker({
        controlUrl: CHIEFBOT_CONTROL_URL,
        ...agent,
        copilot: copilot.copilot,
        screen: { hostname: "127.0.0.1", port: computer.screen.port },
        ...(gitSocket === undefined ? {} : { gitSocket }),
        ...(clock === undefined ? {} : { clock }),
        retryMs: 20,
      });
    },
    async stop(id) {
      halt(get(id));
    },
    async destroy(id, { deleteData }) {
      const computer = computers.get(id);
      if (computer) halt(computer);
      computers.delete(id);
      destroyed.push({ id, deleteData });
    },
    async status(id) {
      const computer = computers.get(id);
      if (!computer) return "absent";
      return computer.worker || computer.coordinator ? "running" : "stopped";
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
