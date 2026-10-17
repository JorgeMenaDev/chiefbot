import {
  Project,
  SendMessageResponse,
  Subscription,
  Task,
  type ProjectChatView,
  type ProjectId,
  type SubscriptionId,
  type SubscriptionInput,
  type WorkspaceId,
} from "@chiefbot/contracts";
import { foldChat, followChat } from "./chat.ts";
import { controlCaller } from "./controlApi.ts";

export type ProjectsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
  // The user's chat with a project's coordinator changed.
  onChat: (view: ProjectChatView) => void;
  // Wait between reconnects after a chat socket drops.
  retryMs?: number;
};

// The projects of the user's workspaces, owned by Electron main: plain HTTP
// calls to control, plus the user's own chat with each opened project's
// coordinator. Task ledger changes arrive on /events (bots.ts, onTasks).
export function createProjects({ controlUrl, session, onChat, retryMs = 2000 }: ProjectsOptions) {
  const call = controlCaller({ controlUrl, session });
  const chats = new Map<ProjectId, { view: ProjectChatView; close: () => void }>();
  const emptyView = (projectId: ProjectId): ProjectChatView => ({ projectId, items: [], working: null });

  return {
    list: async (workspaceId: WorkspaceId) => Project.array().parse(await (await call("GET", `/workspaces/${workspaceId}/projects`)).json()),
    // Throws with control's reason, e.g. what is wrong with the repo's chiefbot.project.yaml.
    create: async (workspaceId: WorkspaceId, repo: string) =>
      Project.parse(await (await call("POST", `/workspaces/${workspaceId}/projects`, { repo })).json()),
    // The workspace owner only. Its computer, ledger, chats and context go too.
    remove: async (projectId: ProjectId) => {
      await call("DELETE", `/projects/${projectId}`);
      chats.get(projectId)?.close();
      chats.delete(projectId);
    },
    tasks: async (projectId: ProjectId) => Task.array().parse(await (await call("GET", `/projects/${projectId}/tasks`)).json()),

    // What the project listens to. Adding throws with control's reason (a connector
    // the project does not declare, a schedule it cannot run).
    subscriptions: async (projectId: ProjectId) =>
      Subscription.array().parse(await (await call("GET", `/projects/${projectId}/subscriptions`)).json()),
    subscribe: async (projectId: ProjectId, input: SubscriptionInput) =>
      Subscription.parse(await (await call("POST", `/projects/${projectId}/subscriptions`, input)).json()),
    unsubscribe: async (projectId: ProjectId, subscriptionId: SubscriptionId) =>
      void (await call("DELETE", `/projects/${projectId}/subscriptions/${subscriptionId}`)),

    // Starts following the user's chat with the coordinator. Repeat calls are harmless.
    openChat(projectId: ProjectId) {
      if (chats.has(projectId)) return;
      const chat = { view: emptyView(projectId), close: () => {} };
      chats.set(projectId, chat);
      chat.close = followChat({
        controlUrl,
        session,
        retryMs,
        path: (after) => `/projects/${projectId}/chat?after=${after}`,
        onEvent: (event) => {
          chat.view = foldChat(chat.view, event);
          onChat(chat.view);
        },
      }).close;
    },

    chatView: (projectId: ProjectId) => chats.get(projectId)?.view ?? emptyView(projectId),

    // Queues the message for the coordinator; throws while the user's last one is unanswered.
    send: async (projectId: ProjectId, text: string) =>
      SendMessageResponse.parse(await (await call("POST", `/projects/${projectId}/messages`, { text })).json()).turnId,

    // Call on sign-out.
    disconnect() {
      const open = [...chats.values()];
      chats.clear();
      for (const chat of open) chat.close();
    },
  };
}
