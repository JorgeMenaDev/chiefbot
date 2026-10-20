import type { BotAvatar, ConnectorInput, RoutineInput, SubscriptionInput, Theme } from "@chiefbot/contracts";
import { contextBridge, ipcRenderer } from "electron";

// Subscribes to one main → renderer channel; returns the unsubscribe.
function subscribe(channel: string, listener: (value: unknown) => void) {
  const handler = (_event: unknown, value: unknown) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.off(channel, handler);
}

// The renderer's only door to Electron main. It validates what comes back with
// the contracts schemas, so values here stay `unknown`.
const api = {
  auth: {
    get: (): Promise<unknown> => ipcRenderer.invoke("auth:get"),
    signIn: (): Promise<void> => ipcRenderer.invoke("auth:sign-in"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:sign-out"),
    disconnectGitHub: (): Promise<void> => ipcRenderer.invoke("auth:disconnect-github"),
    onChange: (listener: (state: unknown) => void) => subscribe("auth:state", listener),
  },
  bots: {
    get: (): Promise<unknown> => ipcRenderer.invoke("bots:get"),
    create: (request: { name: string; avatar: BotAvatar }): Promise<unknown> => ipcRenderer.invoke("bots:create", request),
    start: (id: string): Promise<void> => ipcRenderer.invoke("bots:start", id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke("bots:stop", id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("bots:delete", id),
    models: (): Promise<unknown> => ipcRenderer.invoke("bots:models"),
    setModel: (id: string, model: string): Promise<unknown> => ipcRenderer.invoke("bots:set-model", id, model),
    takeOver: (id: string): Promise<void> => ipcRenderer.invoke("bots:take-over", id),
    handBack: (id: string): Promise<void> => ipcRenderer.invoke("bots:hand-back", id),
    // The bot's screen WebSocket on control, for noVNC. Main adds the session to it.
    screenUrl: (id: string): Promise<string> => ipcRenderer.invoke("bots:screen-url", id),
    onChange: (listener: (bots: unknown) => void) => subscribe("bots:state", listener),
  },
  chat: {
    open: (botId: string): Promise<unknown> => ipcRenderer.invoke("chat:open", botId),
    send: (botId: string, text: string): Promise<unknown> => ipcRenderer.invoke("chat:send", botId, text),
    answer: (botId: string, approvalId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke("chat:answer", botId, approvalId, approved),
    onChange: (listener: (view: unknown) => void) => subscribe("chat:state", listener),
  },
  routines: {
    list: (botId: string): Promise<unknown> => ipcRenderer.invoke("routines:list", botId),
    create: (botId: string, input: RoutineInput): Promise<unknown> => ipcRenderer.invoke("routines:create", botId, input),
    update: (botId: string, routineId: string, input: RoutineInput): Promise<unknown> =>
      ipcRenderer.invoke("routines:update", botId, routineId, input),
    remove: (botId: string, routineId: string): Promise<void> => ipcRenderer.invoke("routines:delete", botId, routineId),
  },
  workspaces: {
    list: (): Promise<unknown> => ipcRenderer.invoke("workspaces:list"),
    create: (name: string): Promise<unknown> => ipcRenderer.invoke("workspaces:create", name),
    detail: (id: string): Promise<unknown> => ipcRenderer.invoke("workspaces:detail", id),
    invite: (id: string, login: string): Promise<unknown> => ipcRenderer.invoke("workspaces:invite", id, login),
    revokeInvite: (id: string, inviteId: string): Promise<void> => ipcRenderer.invoke("workspaces:revoke-invite", id, inviteId),
    // The owner removes a member; with the user's own id, they leave.
    removeMember: (id: string, userId: string): Promise<void> => ipcRenderer.invoke("workspaces:remove-member", id, userId),
    // The owner only: "personal" or "org" (who pays for the projects' agents).
    setCopilotMode: (id: string, mode: string): Promise<unknown> => ipcRenderer.invoke("workspaces:set-copilot-mode", id, mode),
    invites: (): Promise<unknown> => ipcRenderer.invoke("workspaces:invites"),
    accept: (inviteId: string): Promise<unknown> => ipcRenderer.invoke("workspaces:accept", inviteId),
  },
  projects: {
    list: (workspaceId: string): Promise<unknown> => ipcRenderer.invoke("projects:list", workspaceId),
    create: (workspaceId: string, repo: string): Promise<unknown> => ipcRenderer.invoke("projects:create", workspaceId, repo),
    tasks: (id: string): Promise<unknown> => ipcRenderer.invoke("projects:tasks", id),
    // Asks first; resolves true once deleted.
    remove: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke("projects:delete", id, name),
    // The user's own chat with the project's coordinator.
    openChat: (id: string): Promise<unknown> => ipcRenderer.invoke("projects:open-chat", id),
    send: (id: string, text: string): Promise<unknown> => ipcRenderer.invoke("projects:send", id, text),
    onChat: (listener: (view: unknown) => void) => subscribe("projects:chat", listener),
    // What the project listens to: CI runs, issue queries and schedules.
    subscriptions: (id: string): Promise<unknown> => ipcRenderer.invoke("projects:subscriptions", id),
    subscribe: (id: string, input: SubscriptionInput): Promise<unknown> => ipcRenderer.invoke("projects:subscribe", id, input),
    unsubscribe: (id: string, subscriptionId: string): Promise<void> => ipcRenderer.invoke("projects:unsubscribe", id, subscriptionId),
    // { projectId, tasks } whenever a project's task ledger changes.
    onTasks: (listener: (ledger: unknown) => void) => subscribe("projects:tasks", listener),
    workers: (id: string): Promise<unknown> => ipcRenderer.invoke("projects:workers", id),
    // Answers what control asked in the user's running turn with the coordinator.
    answerChat: (id: string, approvalId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke("projects:answer-chat", id, approvalId, approved),
    // Answers a pending push or pull request of a worker the user asked for.
    answer: (id: string, workerId: string, approvalId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke("projects:answer", id, workerId, approvalId, approved),
    // { projectId, workers } whenever one of a project's workers changes.
    onWorkers: (listener: (workers: unknown) => void) => subscribe("projects:workers", listener),
  },
  // The Theme setting: main sets Electron's native theme to match.
  theme: {
    set: (theme: Theme): Promise<void> => ipcRenderer.invoke("theme:set", theme),
  },
  // The user's own connections (Connect apps) and a bot's calls with them.
  connections: {
    list: (): Promise<unknown> => ipcRenderer.invoke("connections:list"),
    // Saves every field, secret ones included, which turns it on.
    connect: (name: string, fields: Record<string, string>): Promise<unknown> => ipcRenderer.invoke("connections:connect", name, fields),
    disconnect: (name: string): Promise<void> => ipcRenderer.invoke("connections:disconnect", name),
    calls: (botId: string): Promise<unknown> => ipcRenderer.invoke("connections:calls", botId),
  },
  connectors: {
    list: (workspaceId: string): Promise<unknown> => ipcRenderer.invoke("connectors:list", workspaceId),
    define: (workspaceId: string, input: ConnectorInput): Promise<unknown> => ipcRenderer.invoke("connectors:define", workspaceId, input),
    // Asks first; resolves true once deleted.
    remove: (workspaceId: string, name: string): Promise<boolean> => ipcRenderer.invoke("connectors:delete", workspaceId, name),
    // The owner only: let the connector's tools that may write run without asking, or not.
    setWritesWithoutApproval: (workspaceId: string, name: string, allowed: boolean): Promise<unknown> =>
      ipcRenderer.invoke("connectors:set-writes", workspaceId, name, allowed),
    setSecret: (workspaceId: string, name: string, token: string): Promise<void> =>
      ipcRenderer.invoke("connectors:set-secret", workspaceId, name, token),
    setToken: (workspaceId: string, name: string, token: string): Promise<void> =>
      ipcRenderer.invoke("connectors:set-token", workspaceId, name, token),
    // Opens the OAuth sign-in in the browser when there is one; resolves with the ConnectStart.
    connect: (workspaceId: string, name: string): Promise<unknown> => ipcRenderer.invoke("connectors:connect", workspaceId, name),
    checklist: (workspaceId: string): Promise<unknown> => ipcRenderer.invoke("connectors:checklist", workspaceId),
    // A project's connector call log.
    calls: (projectId: string): Promise<unknown> => ipcRenderer.invoke("connectors:calls", projectId),
  },
};

export type ChiefbotApi = typeof api;

contextBridge.exposeInMainWorld("chiefbot", api);
