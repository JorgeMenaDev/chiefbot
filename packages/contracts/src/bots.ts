import { z } from "zod";
import { BotId } from "./ids.ts";

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
// human: the user took over; agent input to the screen must wait until hand-back.
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

// Control → worker on the /worker WebSocket. `bound` names the one bot this
// connection belongs to; control sends it right after it accepts the credential.
// `screen-control` follows it, and comes again on every take-over and hand-back.
export const ControlToWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bound"), botId: BotId }),
  z.object({ type: z.literal("screen-control"), control: ScreenControl }),
]);
export type ControlToWorker = z.infer<typeof ControlToWorker>;
