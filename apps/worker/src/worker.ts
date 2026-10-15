import { ControlToWorker, type BotId, type ScreenControl } from "@chiefbot/contracts";
import { openScreenStream, type ScreenAddress } from "./screen.ts";

export type WorkerOptions = {
  // Control's base URL as seen from the computer, e.g. http://host.docker.internal:7410.
  controlUrl: string;
  // The bot this computer belongs to, from CHIEFBOT_BOT_ID.
  botId: string;
  // The bot's credential from CHIEFBOT_BOT_TOKEN.
  botToken: string;
  // The computer's VNC server. Default: x11vnc on 127.0.0.1:5900.
  screen?: ScreenAddress;
  // Wait between reconnects after the connection drops.
  retryMs?: number;
  onBound?: (botId: BotId) => void;
};

// Dials out to control's /worker/:botId WebSocket with the bot's credential and keeps
// the connection up: control restarts and network drops end in a reconnect.
// On `screen-open` it pipes the screen to a viewer through control (screen.ts).
export function startWorker({
  controlUrl,
  botId,
  botToken,
  screen = { hostname: "127.0.0.1", port: 5900 },
  retryMs = 2000,
  onBound,
}: WorkerOptions) {
  const url = `${controlUrl.replace(/^http/, "ws")}/worker/${botId}`;
  // Each open screen stream's close function.
  const streams = new Set<() => void>();
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  // Who drives the screen, as control last said. Agent input to the screen waits while it is "human".
  let screenControl: ScreenControl = "agent";

  function connect() {
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${botToken}` } });
    socket.onmessage = (event) => {
      const message = ControlToWorker.parse(JSON.parse(String(event.data)));
      switch (message.type) {
        case "bound":
          onBound?.(message.botId);
          break;
        case "screen-control":
          screenControl = message.control;
          break;
        case "screen-open": {
          const close = openScreenStream(`${url}/screen/${message.streamId}`, botToken, screen, () =>
            streams.delete(close),
          );
          streams.add(close);
          break;
        }
      }
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  return {
    screenControl: () => screenControl,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      for (const close of streams) close();
    },
  };
}
