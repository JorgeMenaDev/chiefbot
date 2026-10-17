import { Bot, ClientEvent, ModelOption, type BotId, type ProjectId, type Task, type User } from "@chiefbot/contracts";
import { z } from "zod";
import { controlCaller } from "./controlApi.ts";

export type BotsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
  onChange: (bots: Bot[]) => void;
  // The signed-in user changed on control, e.g. their GitHub sign-in was lost.
  onUser?: (user: User) => void;
  // A project of one of the user's workspaces has a new task ledger.
  onTasks?: (projectId: ProjectId, tasks: Task[]) => void;
  // Wait between reconnects after the events socket drops.
  retryMs?: number;
};

// The signed-in user's bots, owned by Electron main. A WebSocket to control's
// /events keeps the list live (and passes on project ledgers); actions are
// plain HTTP calls to control.
export function createBots({ controlUrl, session, onChange, onUser, onTasks, retryMs = 2000 }: BotsOptions) {
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
    socket.onmessage = (event) => {
      const message = ClientEvent.parse(JSON.parse(String(event.data)));
      if (message.type === "bots") set(message.bots);
      else if (message.type === "user") onUser?.(message.user);
      else onTasks?.(message.projectId, message.tasks);
    };
    socket.onclose = () => {
      if (connected) retry = setTimeout(open, retryMs);
    };
  }

  const call = controlCaller({ controlUrl, session });

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
    // The human drives the bot's screen until handBack; the agent's input waits meanwhile.
    takeOver: async (botId: BotId) => void (await call("POST", `/bots/${botId}/take-over`)),
    handBack: async (botId: BotId) => void (await call("POST", `/bots/${botId}/hand-back`)),

    // The model picker's rows for the user's Copilot plan.
    models: async () => z.array(ModelOption).parse(await (await call("GET", "/models")).json()),
    // The bot's next turn runs on `model`.
    setModel: async (botId: BotId, model: string) =>
      Bot.parse(await (await call("PUT", `/bots/${botId}/model`, { model })).json()),
  };
}
