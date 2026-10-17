import {
  AUTO_MODEL,
  type BotId,
  type ChatEvent,
  type ControlToWorker,
  type TurnId,
  type TurnRefusal,
  type UserId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import type { openStore } from "./store.ts";

// Chat turns between the bots' chats and their workers. Starts a turn (a user's
// message or a routine's prompt) on the bot's worker, publishes every stored
// chat event to the bot's chat topic, tells a waiting routine when its turn
// ends, and settles each worker hello: answers the worker missed are resent, the
// turns it lost are ended, and only then may a routine send it a turn.
export function chatTurns({
  store,
  publish,
  workerOf,
  humanHasScreen,
  stopping,
  onActivity,
}: {
  store: ReturnType<typeof openStore>;
  // Publishes to a WebSocket topic.
  publish: (topic: string, message: string) => void;
  // The bot's connected worker, if any.
  workerOf: (botId: BotId) => { send(message: string): unknown } | undefined;
  humanHasScreen: (botId: BotId) => boolean;
  // Whether control is stopping the bot's computer: a turn sent now would die with it.
  stopping: (botId: BotId) => boolean;
  // A chat event was stored for the bot.
  onActivity: (botId: BotId) => void;
}) {
  // Bots whose connected worker has said hello, so it may be sent a turn. Who
  // waits for that, and who waits for a turn to end (with its error, if any).
  const greeted = new Set<BotId>();
  const onlineWaiters = new Map<BotId, Set<() => void>>();
  const turnWatchers = new Map<TurnId, { error: string | null; done: (error: string | null) => void }>();

  const chatTopic = (botId: BotId) => `chat:${botId}`;

  // Every stored chat event passes here.
  const publishChat = (botId: BotId, event: ChatEvent | null) => {
    if (!event) return;
    onActivity(botId);
    publish(chatTopic(botId), JSON.stringify(event satisfies ChatEvent));
    const watcher = turnWatchers.get(event.turnId);
    if (watcher && event.event.type === "error") watcher.error = event.event.message;
    if (watcher && event.event.type === "done") {
      turnWatchers.delete(event.turnId);
      watcher.done(watcher.error);
    }
  };

  // Starts a chat turn with `text` on the bot's worker.
  const sendTurn = (userId: UserId, botId: BotId, text: string): { turnId: TurnId } | { error: TurnRefusal } => {
    const worker = workerOf(botId);
    if (!worker) return { error: "bot_offline" };
    if (stopping(botId)) return { error: "bot_stopping" };
    if (store.unfinishedTurns(botId).length > 0) return { error: "turn_running" };
    // The agent waits while the human drives the screen. A turn already running
    // pauses at its next tool call (the worker holds it until hand-back).
    if (humanHasScreen(botId)) return { error: "human_has_screen" };
    const model = store.botFor(userId, botId)?.model ?? AUTO_MODEL;
    const started = store.startTurn(botId, text);
    publishChat(botId, started);
    worker.send(JSON.stringify({ type: "run-turn", turnId: started.turnId, text, model } satisfies ControlToWorker));
    return { turnId: started.turnId };
  };

  return {
    chatTopic,
    publishChat,
    sendTurn,

    // sendTurn for a routine: `done` resolves when the turn ends, with its error message if it failed.
    runTurn(userId: UserId, botId: BotId, text: string) {
      const sent = sendTurn(userId, botId, text);
      if ("error" in sent) return sent;
      const done = new Promise<string | null>((resolve) => turnWatchers.set(sent.turnId, { error: null, done: resolve }));
      return { turnId: sent.turnId, done };
    },

    // Resolves once the bot's worker has said hello.
    online: (botId: BotId) =>
      greeted.has(botId)
        ? Promise.resolve()
        : new Promise<void>((resolve) => onlineWaiters.set(botId, (onlineWaiters.get(botId) ?? new Set()).add(resolve))),

    // The bot's worker connected or went away: it must say hello before its next turn.
    workerChanged: (botId: BotId) => void greeted.delete(botId),

    // A message from the bot's worker. `reply` answers on its connection.
    fromWorker(botId: BotId, message: Exclude<WorkerToControl, { type: "models" }>, reply: (message: ControlToWorker) => void) {
      if (message.type === "turn-event") {
        return publishChat(botId, store.appendTurnEvent(botId, message.turnId, message.index, message.event));
      }
      // Answers the worker may have missed while it was away.
      if (message.activeTurnId) {
        for (const answer of store.answeredApprovals(botId, message.activeTurnId)) reply({ type: "approval-answer", ...answer });
      }
      // The worker lost every unfinished turn but the one it says it is still running.
      for (const turnId of store.unfinishedTurns(botId)) {
        if (turnId === message.activeTurnId) continue;
        for (const event of store.abandonTurn(botId, turnId, "The bot restarted before it finished this message.")) {
          publishChat(botId, event);
        }
      }
      // Only now may a routine send its turn: a turn sent before the hello
      // would be ended as lost by it.
      greeted.add(botId);
      for (const wake of onlineWaiters.get(botId) ?? []) wake();
      onlineWaiters.delete(botId);
    },
  };
}
