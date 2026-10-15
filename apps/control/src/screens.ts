import type { BotId, ScreenControl } from "@chiefbot/contracts";

// One end of a screen stream: a WebSocket on control.
type End = { send(data: string | Buffer): unknown; close(): void };

// Who drives each bot's screen, and the screen streams control pipes. For each
// viewer, control asks the bot's worker to dial back and joins the two sockets,
// so the screen never listens beyond the computer's loopback. Who drives is kept
// in memory: a control restart hands every screen back to the agent.
export function screenTunnel({ onStreamEnd }: { onStreamEnd: (botId: BotId) => void }) {
  const control = new Map<BotId, ScreenControl>();
  // One viewer watching one bot's screen. Viewer frames sent before the worker
  // joins wait in `queued`.
  const streams = new Map<string, { botId: BotId; viewer: End; screen: End | null; queued: Array<string | Buffer> }>();

  return {
    controlOf: (botId: BotId): ScreenControl => control.get(botId) ?? "agent",
    // Take-over ("human") and hand-back ("agent").
    setControl: (botId: BotId, value: ScreenControl) => void control.set(botId, value),
    forget: (botId: BotId) => void control.delete(botId),
    // Whether someone is watching the bot's screen.
    watched: (botId: BotId) => [...streams.values()].some((stream) => stream.botId === botId),

    // A viewer is waiting on `streamId`; the bot's worker should now dial in.
    openViewer(botId: BotId, streamId: string, viewer: End) {
      streams.set(streamId, { botId, viewer, screen: null, queued: [] });
    },
    // Only a stream control opened for this bot, and only once.
    joinable(botId: BotId, streamId: string) {
      const stream = streams.get(streamId);
      return stream !== undefined && stream.botId === botId && stream.screen === null;
    },
    // The worker's end joined: queued viewer frames go out first. False when the stream is gone.
    joinScreen(streamId: string, screen: End) {
      const stream = streams.get(streamId);
      if (!stream) return false;
      stream.screen = screen;
      for (const frame of stream.queued.splice(0)) screen.send(frame);
      return true;
    },
    // Passes bytes from one end to the other.
    relay(streamId: string, from: "viewer" | "screen", data: string | Buffer) {
      const stream = streams.get(streamId);
      if (!stream) return;
      if (from === "screen") stream.viewer.send(data);
      else if (stream.screen) stream.screen.send(data);
      else stream.queued.push(data);
    },
    // Closes both ends of a stream.
    end(streamId: string) {
      const stream = streams.get(streamId);
      if (!stream) return;
      streams.delete(streamId);
      onStreamEnd(stream.botId);
      stream.viewer.close();
      stream.screen?.close();
    },
  };
}
