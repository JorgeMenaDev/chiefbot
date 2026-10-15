import { ControlToWorker, type BotId } from "@chiefbot/contracts";

export type WorkerOptions = {
  // Control's base URL as seen from the computer, e.g. http://host.docker.internal:7410.
  controlUrl: string;
  // The bot this computer belongs to, from CHIEFBOT_BOT_ID.
  botId: string;
  // The bot's credential from CHIEFBOT_BOT_TOKEN.
  botToken: string;
  // Wait between reconnects after the connection drops.
  retryMs?: number;
  onBound?: (botId: BotId) => void;
};

// Dials out to control's /worker/:botId WebSocket with the bot's credential and keeps
// the connection up: control restarts and network drops end in a reconnect.
export function startWorker({ controlUrl, botId, botToken, retryMs = 2000, onBound }: WorkerOptions) {
  const url = `${controlUrl.replace(/^http/, "ws")}/worker/${botId}`;
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;

  function connect() {
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${botToken}` } });
    socket.onmessage = (event) => {
      const message = ControlToWorker.parse(JSON.parse(String(event.data)));
      if (message.type === "bound") onBound?.(message.botId);
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}
