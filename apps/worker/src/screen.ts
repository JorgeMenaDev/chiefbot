import type { Socket } from "bun";

// Where the computer's VNC server listens: x11vnc on loopback (infra/computer/start.sh).
export type ScreenAddress = { hostname: string; port: number };

// Joins one viewer to the screen: dials control's stream WebSocket and the VNC
// server, and pipes bytes both ways. Nothing in the computer listens beyond
// loopback; the worker dials out, as it does for /worker. Bytes that arrive
// before the other side is open wait in a queue. Either side closing closes both.
// Returns a function that closes the stream; onClosed runs once either way.
export function openScreenStream(streamUrl: string, botToken: string, screen: ScreenAddress, onClosed: () => void) {
  const stream = new WebSocket(streamUrl, { headers: { authorization: `Bearer ${botToken}` } });
  stream.binaryType = "arraybuffer";
  const toControl: Uint8Array[] = [];
  const toScreen: Uint8Array[] = [];
  let vnc: Socket | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    stream.close();
    vnc?.end();
    onClosed();
  };

  stream.onopen = () => {
    for (const chunk of toControl.splice(0)) stream.send(chunk);
  };
  stream.onmessage = (event) => {
    const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new TextEncoder().encode(String(event.data));
    if (vnc) vnc.write(bytes);
    else toScreen.push(bytes);
  };
  stream.onclose = close;

  Bun.connect({
    ...screen,
    socket: {
      open(socket) {
        vnc = socket;
        if (closed) return void socket.end();
        for (const chunk of toScreen.splice(0)) socket.write(chunk);
      },
      data(_socket, data) {
        // Copied: Bun may reuse the buffer after this callback.
        const chunk = new Uint8Array(data);
        if (stream.readyState === WebSocket.OPEN) stream.send(chunk);
        else toControl.push(chunk);
      },
      close,
    },
  }).catch(close);

  return close;
}
