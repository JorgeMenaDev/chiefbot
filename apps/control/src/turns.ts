import {
  ACCESS_MODES,
  AUTO_MODEL,
  DEFAULT_ACCESS,
  type AttachmentUpload,
  type BotId,
  type ChatEvent,
  type AgentConnection,
  type ControlToWorker,
  type TurnId,
  type TurnRefusal,
  type UserId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import { currentEffort } from "./models.ts";
import type { openStore } from "./store.ts";

// Why a turn in another mode than Auto is refused on a worker without ACCESS_MODES.
export const computerOutdated =
  "This bot's computer is out of date, so it can only run in Auto. Update its computer (docs/deploy.md) or switch the bot to Auto.";

// Chat turns between the bots' chats and their workers. Starts a turn (a user's
// message or a routine's prompt) on the bot's worker, publishes every stored
// chat event to the bot's chat topic, tells a waiting routine when its turn
// ends, and settles each worker hello: answers the worker missed are resent, the
// turns it lost are ended, and only then may a routine send it a turn.
export function chatTurns({
  store,
  connectionsFor,
  publish,
  workerOf,
  humanHasScreen,
  stopping,
  onEvent,
}: {
  store: ReturnType<typeof openStore>;
  // The bot owner's connections that are on, for a turn (connections/connections.ts).
  connectionsFor: (userId: UserId) => Promise<AgentConnection[]>;
  // Publishes to a WebSocket topic.
  publish: (topic: string, message: string) => void;
  // The bot's connected worker, if any.
  workerOf: (botId: BotId) => { send(message: string): unknown } | undefined;
  humanHasScreen: (botId: BotId) => boolean;
  // Whether control is stopping the bot's computer: a turn sent now would die with it.
  stopping: (botId: BotId) => boolean;
  // A chat event was stored for the bot.
  onEvent: (botId: BotId, event: ChatEvent) => void;
}) {
  // Bots whose connected worker has said hello, so it may be sent a turn. Who
  // waits for that, and who waits for a turn to end (with its error, if any).
  const greeted = new Set<BotId>();
  // What each greeted worker said it can do (contracts TurnHello).
  const capabilities = new Map<BotId, string[]>();
  const onlineWaiters = new Map<BotId, Set<() => void>>();
  const turnWatchers = new Map<TurnId, { error: string | null; done: (error: string | null) => void }>();

  const chatTopic = (botId: BotId) => `chat:${botId}`;

  // Every stored chat event passes here.
  const publishChat = (botId: BotId, event: ChatEvent | null) => {
    if (!event) return;
    onEvent(botId, event);
    publish(chatTopic(botId), JSON.stringify(event satisfies ChatEvent));
    const watcher = turnWatchers.get(event.turnId);
    if (watcher && event.event.type === "error") watcher.error = event.event.message;
    if (watcher && event.event.type === "done") {
      turnWatchers.delete(event.turnId);
      watcher.done(watcher.error);
    }
  };

  // Starts a chat turn with `text` and the files sent with it on the bot's worker,
  // on the bot's model, effort (null once the model no longer supports it) and
  // access mode as they are now. A mode other than Auto needs a worker that runs
  // it. The turn is recorded at once; it goes to the worker with the owner's
  // connections once they are read.
  // A worker that reconnects meanwhile has ended the turn as lost, so it goes
  // only to the connection it was started on, and a turn that ended meanwhile
  // (Stop) does not go at all. Unreadable connections leave the turn without them.
  const sendTurn = (userId: UserId, botId: BotId, text: string, uploads: AttachmentUpload[] = []): { turnId: TurnId } | { error: TurnRefusal } => {
    const worker = workerOf(botId);
    if (!worker) return { error: "bot_offline" };
    if (stopping(botId)) return { error: "bot_stopping" };
    if (store.unfinishedTurns(botId).length > 0) return { error: "turn_running" };
    // The agent waits while the human drives the screen. A turn already running
    // pauses at its next tool call (the worker holds it until hand-back).
    if (humanHasScreen(botId)) return { error: "human_has_screen" };
    const bot = store.botFor(userId, botId);
    const model = bot?.model ?? AUTO_MODEL;
    const effort = currentEffort(store.modelReport(userId), model, bot?.effort ?? null);
    const access = bot?.access ?? DEFAULT_ACCESS;
    if (access !== "auto" && !capabilities.get(botId)?.includes(ACCESS_MODES)) return { error: "computer_outdated" };
    const started = store.startTurn(botId, text, uploads);
    const attachments = started.event.attachments ?? [];
    const turnKey = store.turnKeys.issue({ agent: "bot", botId, userId, turnId: started.turnId });
    publishChat(botId, started);
    void connectionsFor(userId)
      .catch(() => [])
      .then((connections) => {
        if (workerOf(botId) !== worker || !store.unfinishedTurns(botId).includes(started.turnId)) return;
        worker.send(
          JSON.stringify({
            type: "run-turn",
            turnId: started.turnId,
            turnKey,
            text,
            model,
            effort,
            access,
            connections,
            attachments,
          } satisfies ControlToWorker),
        );
      });
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
    workerChanged: (botId: BotId) => {
      greeted.delete(botId);
      capabilities.delete(botId);
    },

    // A message from the worker of `userId`'s bot. `reply` answers on its connection.
    fromWorker(userId: UserId, botId: BotId, message: Exclude<WorkerToControl, { type: "models" | "connection-calls" }>, reply: (message: ControlToWorker) => void) {
      if (message.type === "turn-event") {
        return publishChat(botId, store.appendTurnEvent(botId, message.turnId, message.index, message.event));
      }
      // Answers the worker may have missed while it was away, and a new key for
      // its turn if control restarted since it started.
      const turnId = message.activeTurnId;
      if (turnId && store.unfinishedTurns(botId).includes(turnId)) {
        for (const answer of store.answeredApprovals(botId, turnId)) reply({ type: "approval-answer", ...answer });
        if (store.turnKeys.missing(turnId)) reply({ type: "turn-key", turnId, turnKey: store.turnKeys.issue({ agent: "bot", botId, userId, turnId }) });
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
      capabilities.set(botId, message.capabilities);
      for (const wake of onlineWaiters.get(botId) ?? []) wake();
      onlineWaiters.delete(botId);
    },
  };
}
