import { Bot, ClientEvent, ModelOption, type BotId } from "@chiefbot/contracts";
import { z } from "zod";

export type BotsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
  onChange: (bots: Bot[]) => void;
  // Wait between reconnects after the events socket drops.
  retryMs?: number;
};

// The signed-in user's bots, owned by Electron main. A WebSocket to control's
// /events keeps the list live; actions are plain HTTP calls to control.
export function createBots({ controlUrl, session, onChange, retryMs = 2000 }: BotsOptions) {
  let bots: Bot[] = [];
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let connected = false;

  const set = (next: Bot[]) => {
    bots = next;
    onChange(next);
  };

  function open() {
    const token = session();
    if (!token) return;
    socket = new WebSocket(`${controlUrl.replace(/^http/, "ws")}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.onmessage = (event) => set(ClientEvent.parse(JSON.parse(String(event.data))).bots);
    socket.onclose = () => {
      if (connected) retry = setTimeout(open, retryMs);
    };
  }

  // One control call; throws with control's error code when it refuses.
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${controlUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${session() ?? ""}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`Control refused (${res.status}): ${await res.text()}`);
    return res;
  }

  return {
    list: () => bots,

    // Call after sign-in. Stays connected (reconnecting) until disconnect().
    connect() {
      if (connected) return;
      connected = true;
      open();
    },

    // Call on sign-out.
    disconnect() {
      connected = false;
      if (retry) clearTimeout(retry);
      socket?.close();
      socket = null;
      set([]);
    },

    create: async (name: string) => Bot.parse(await (await call("POST", "/bots", { name })).json()),
    start: async (botId: BotId) => void (await call("POST", `/bots/${botId}/start`)),
    stop: async (botId: BotId) => void (await call("POST", `/bots/${botId}/stop`)),
    remove: async (botId: BotId, { deleteData }: { deleteData: boolean }) =>
      void (await call("DELETE", `/bots/${botId}${deleteData ? "?deleteData=true" : ""}`)),

    // The model picker's rows for the user's Copilot plan.
    models: async () => z.array(ModelOption).parse(await (await call("GET", "/models")).json()),
    // The bot's next turn runs on `model`.
    setModel: async (botId: BotId, model: string) =>
      Bot.parse(await (await call("PUT", `/bots/${botId}/model`, { model })).json()),
  };
}
