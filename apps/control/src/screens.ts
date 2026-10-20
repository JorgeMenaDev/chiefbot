import type { ScreenControl } from "@chiefbot/contracts";

// One end of a screen stream: a WebSocket on control.
type End = { send(data: string | Buffer): unknown; close(): void };

// Who drives each computer's screen (a bot's, or an engineer's: `Id`), and the
// screen streams control pipes. For each viewer, control asks the computer's
// worker to dial back and joins the two sockets, so the screen never listens
// beyond the computer's loopback. Who drives is kept in memory: a control
// restart hands every screen back to the agent.
export function screenTunnel<Id extends string>({ onStreamEnd }: { onStreamEnd: (id: Id) => void }) {
  const control = new Map<Id, ScreenControl>();
  // One viewer watching one computer's screen. Viewer frames sent before the
  // worker joins wait in `queued`.
  const streams = new Map<string, { id: Id; viewer: End; screen: End | null; queued: Array<string | Buffer> }>();

  return {
    controlOf: (id: Id): ScreenControl => control.get(id) ?? "agent",
    // Take-over ("human") and hand-back ("agent").
    setControl: (id: Id, value: ScreenControl) => void control.set(id, value),
    forget: (id: Id) => void control.delete(id),
    // Whether someone is watching the computer's screen.
    watched: (id: Id) => [...streams.values()].some((stream) => stream.id === id),

    // A viewer is waiting on `streamId`; the computer's worker should now dial in.
    openViewer(id: Id, streamId: string, viewer: End) {
      streams.set(streamId, { id, viewer, screen: null, queued: [] });
    },
    // Only a stream control opened for this computer, and only once.
    joinable(id: Id, streamId: string) {
      const stream = streams.get(streamId);
      return stream !== undefined && stream.id === id && stream.screen === null;
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
      onStreamEnd(stream.id);
      stream.viewer.close();
      stream.screen?.close();
    },
  };
}
