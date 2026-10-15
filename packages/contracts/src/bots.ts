import { z } from "zod";
import { TurnEvent } from "./chat.ts";
import { BotId, TurnId } from "./ids.ts";

// The credential a bot's worker presents to control. Control makes one per bot,
// hands it to the computer at start and keeps only its hash. It is not a GitHub token.
export const BotToken = z.string().min(1).brand<"BotToken">();
export type BotToken = z.infer<typeof BotToken>;

// starting: the computer should run but its worker is not connected yet.
// online:   the worker is connected to control.
// stopped:  the computer is stopped; its disk is kept.
export const BotStatus = z.enum(["starting", "online", "stopped"]);
export type BotStatus = z.infer<typeof BotStatus>;

// Who drives the bot's screen. agent: the bot; a viewer only watches.
// human: the user took over (mouse and keyboard); the agent waits until
// hand-back, so control refuses new chat turns.
export const ScreenControl = z.enum(["agent", "human"]);
export type ScreenControl = z.infer<typeof ScreenControl>;

export const Bot = z.object({ id: BotId, name: z.string(), status: BotStatus, screenControl: ScreenControl });
export type Bot = z.infer<typeof Bot>;

// Body of POST /bots.
export const CreateBotRequest = z.object({ name: z.string().trim().min(1).max(60) });
export type CreateBotRequest = z.infer<typeof CreateBotRequest>;

// Control → desktop on the /events WebSocket. Sent on connect and on every change.
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bots"), bots: z.array(Bot) }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

// Control → worker on the /worker WebSocket.
//   bound           names the one bot this connection belongs to; sent right after control accepts the credential
//   run-turn        run one turn on the bot's Copilot session; control sends one at a time
//   screen-control  who drives the screen; sent after bound and on every take-over and hand-back
//   screen-open     a viewer is waiting: dial /worker/:botId/screen/:streamId and pipe the screen's VNC bytes through it
export const ControlToWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bound"), botId: BotId }),
  z.object({ type: z.literal("run-turn"), turnId: TurnId, text: z.string() }),
  z.object({ type: z.literal("screen-control"), control: ScreenControl }),
  z.object({ type: z.literal("screen-open"), streamId: z.string().min(1) }),
]);
export type ControlToWorker = z.infer<typeof ControlToWorker>;

// Worker → control on the /worker WebSocket.
//   turn-event  event number `index` (0, 1, 2…) of a turn
//   hello       the turn the worker is still running, if any. Sent on every
//               (re)connect, after the worker has resent every event of its
//               latest turn. Control stores each index once, so resends are
//               harmless, then ends every other unfinished turn: the worker lost it.
export const WorkerToControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn-event"), turnId: TurnId, index: z.number().int().min(0), event: TurnEvent }),
  z.object({ type: z.literal("hello"), activeTurnId: TurnId.nullable() }),
]);
export type WorkerToControl = z.infer<typeof WorkerToControl>;
