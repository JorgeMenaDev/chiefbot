import type { BotId, RoutineRun, TurnId, TurnRefusal, UserId } from "@chiefbot/contracts";
import type { Clock } from "./clock.ts";
import type { openStore } from "./store.ts";

// How often the scheduler looks for due routines.
export const POLL_MS = 1000;
// A started computer's worker must connect within this. A GCE VM boots in about a minute.
export const WORKER_TIMEOUT_MS = 5 * 60_000;
// A routine's turn must finish within this.
export const TURN_TIMEOUT_MS = 30 * 60_000;

// What the scheduler needs from the rest of control.
export type RoutineHost = {
  // Starts or stops the bot's computer and records that state as the one control wants.
  setRunning(userId: UserId, botId: BotId, running: boolean): Promise<void>;
  // Resolves once the bot's worker is connected.
  online(botId: BotId): Promise<void>;
  // Sends text as a chat turn, the way a user's message goes. `done` resolves
  // when the turn ends, with its error message if it failed.
  runTurn(userId: UserId, botId: BotId, text: string): { turnId: TurnId; done: Promise<string | null> } | { error: TurnRefusal };
};

// How a run ends when control refuses its turn. No retry: the next due time runs as usual.
const refused: Record<TurnRefusal, { status: Exclude<RoutineRun["status"], "running">; error: string }> = {
  bot_offline: { status: "failed", error: "The bot went offline." },
  turn_running: { status: "skipped", error: "The bot was busy with another message." },
  human_has_screen: { status: "skipped", error: "Someone had taken over the bot's screen." },
};

// Runs each routine at its due times, so bots work while the desktop is closed.
// A run starts the bot's computer if it is stopped, waits for its worker, sends
// the prompt as a chat turn (its result lands in the bot's chat history) and
// stops the computer again if the run started it. Runs of one bot go one at a
// time. A run that times out while its turn waits on an approval keeps the
// computer running until that turn ends. Runs that a previous control left unfinished are marked failed, and
// their computers stopped again if they started them; they are not run again.
export function startScheduler({
  store,
  clock,
  host,
}: {
  store: ReturnType<typeof openStore>;
  clock: Clock;
  host: RoutineHost;
}) {
  type Run = ReturnType<typeof store.claimDueRuns>[number];
  let stopped = false;
  let cancelTick = () => {};
  const queues = new Map<BotId, Promise<void>>();

  // Jobs never reject, so one failure does not block the bot's later runs.
  const enqueue = (botId: BotId, job: () => Promise<void>) => {
    queues.set(botId, (queues.get(botId) ?? Promise.resolve()).then(job));
  };

  const within = <T>(promise: Promise<T>, ms: number, message: string) =>
    new Promise<T>((resolve, reject) => {
      const cancel = clock.setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error) => {
          cancel();
          reject(error);
        },
      );
    });

  const stopComputer = (userId: UserId, botId: BotId) =>
    host.setRunning(userId, botId, false).catch((error) => console.error(`could not stop ${botId} after a routine`, error));

  async function execute(run: Run) {
    let startedComputer = false;
    // The run's turn: resolves when it ends, even after the run timed out.
    let turnDone: Promise<unknown> | null = null;
    try {
      const running = store.botRunning(run.botId);
      if (running === null) return;
      if (!running) {
        store.markRunStartedComputer(run);
        startedComputer = true;
        await host.setRunning(run.userId, run.botId, true);
      }
      await within(host.online(run.botId), WORKER_TIMEOUT_MS, "The bot's computer did not come online in time.");
      const turn = host.runTurn(run.userId, run.botId, run.prompt);
      if ("error" in turn) {
        const { status, error } = refused[turn.error];
        return store.finishRun(run, status, error);
      }
      store.setRunTurn(run, turn.turnId);
      turnDone = turn.done;
      const error = await within(turn.done, TURN_TIMEOUT_MS, "The bot did not finish in time.");
      store.finishRun(run, error === null ? "succeeded" : "failed", error);
    } catch (error) {
      // After stop() the store is closed; the next control finishes the run.
      if (!stopped) store.finishRun(run, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      // A turn waiting on the user's approval keeps its computer, so the approval
      // stays answerable after the run timed out. The computer stops once that turn ends.
      if (startedComputer && !stopped) {
        if (!store.waitingOnApproval(run.botId)) await stopComputer(run.userId, run.botId);
        else void turnDone?.then(() => (stopped ? undefined : stopComputer(run.userId, run.botId)));
      }
    }
  }

  function tick() {
    if (stopped) return;
    try {
      for (const run of store.claimDueRuns(clock.now())) enqueue(run.botId, () => execute(run));
    } catch (error) {
      console.error("routine scheduler tick failed", error);
    }
    cancelTick = clock.setTimeout(tick, POLL_MS);
  }

  for (const run of store.unfinishedRuns()) {
    store.finishRun(run, "failed", "Control restarted before this run finished.");
    if (run.startedComputer) enqueue(run.botId, () => stopComputer(run.userId, run.botId));
  }
  tick();

  return {
    stop() {
      stopped = true;
      cancelTick();
    },
  };
}
