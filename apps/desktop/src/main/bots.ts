import {
  Bot,
  ClientEvent,
  ModelOption,
  type AccessMode,
  type BotId,
  type CreateBotRequest,
  type ProjectId,
  type ProjectStates,
  type SetBotModelRequest,
  type Task,
  type TaskWorker,
  type User,
} from "@chiefbot/contracts";
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
  // A project of one of the user's workspaces has a worker that changed.
  onWorkers?: (projectId: ProjectId, workers: TaskWorker[]) => void;
  // The user's projects' states changed (their dots in the Projects tab): every one, as main now has them.
  onProjectStates?: (states: ProjectStates) => void;
  // Wait between reconnects after the events socket drops.
  retryMs?: number;
};

// The signed-in user's bots, owned by Electron main. A WebSocket to control's
// /events keeps the list live (and passes on project ledgers, workers and states); actions are
// plain HTTP calls to control.
export function createBots({ controlUrl, session, onChange, onUser, onTasks, onWorkers, onProjectStates, retryMs = 2000 }: BotsOptions) {
  let bots: Bot[] = [];
  // Each project's latest state, kept for a window that opens after control sent
  // it. Control's snapshot replaces it whole (on every connect, and once a
  // project goes), so a deleted project's dot cannot linger.
  let projectStates: ProjectStates = {};
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
      else if (message.type === "tasks") onTasks?.(message.projectId, message.tasks);
      else if (message.type === "workers") onWorkers?.(message.projectId, message.workers);
      else {
        projectStates = message.type === "project-states" ? message.states : { ...projectStates, [message.projectId]: message.state };
        onProjectStates?.(projectStates);
      }
    };
    socket.onclose = () => {
      if (connected) retry = setTimeout(open, retryMs);
    };
  }

  const call = controlCaller({ controlUrl, session });

  return {
    list: () => bots,
    projectStates: () => projectStates,

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
      projectStates = {};
      set([]);
    },

    create: async (request: CreateBotRequest) => Bot.parse(await (await call("POST", "/bots", request)).json()),
    start: async (botId: BotId) => void (await call("POST", `/bots/${botId}/start`)),
    stop: async (botId: BotId) => void (await call("POST", `/bots/${botId}/stop`)),
    remove: async (botId: BotId, { deleteData }: { deleteData: boolean }) =>
      void (await call("DELETE", `/bots/${botId}${deleteData ? "?deleteData=true" : ""}`)),
    // The human drives the bot's screen until handBack; the agent's input waits meanwhile.
    takeOver: async (botId: BotId) => void (await call("POST", `/bots/${botId}/take-over`)),
    handBack: async (botId: BotId) => void (await call("POST", `/bots/${botId}/hand-back`)),

    // The model picker's rows for the user's Copilot plan.
    models: async () => z.array(ModelOption).parse(await (await call("GET", "/models")).json()),
    // The bot's next turn runs on the request's model and effort.
    setModel: async (botId: BotId, request: SetBotModelRequest) =>
      Bot.parse(await (await call("PUT", `/bots/${botId}/model`, request)).json()),
    // The bot's next turn asks as `access` says.
    setAccess: async (botId: BotId, access: AccessMode) =>
      Bot.parse(await (await call("PUT", `/bots/${botId}/access`, { access })).json()),
  };
}
