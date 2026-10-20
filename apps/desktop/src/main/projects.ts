import {
  ContextFile,
  ContextFileText,
  Project,
  ProjectSecret,
  SendMessageResponse,
  Subscription,
  Task,
  TaskWorker,
  type ApprovalId,
  type ProjectChatView,
  type ProjectId,
  type SetBotModelRequest,
  type SubscriptionId,
  type SubscriptionInput,
  type TaskWorkerId,
  type WorkerChatView,
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
  // The transcript of the worker main follows changed.
  onWorkerChat?: (view: WorkerChatView) => void;
  // Wait between reconnects after a chat socket drops.
  retryMs?: number;
};

// The projects of the user's workspaces, owned by Electron main: plain HTTP
// calls to control, plus the user's own chat with each opened project's
// coordinator, and the transcript of the one worker the user watches. Task
// ledger and worker changes arrive on /events (bots.ts, onTasks and onWorkers).
export function createProjects({ controlUrl, session, onChat, onWorkerChat, retryMs = 2000 }: ProjectsOptions) {
  const call = controlCaller({ controlUrl, session });
  const chats = new Map<ProjectId, { view: ProjectChatView; close: () => void }>();
  let watched: { view: WorkerChatView; close: () => void } | null = null;
  const emptyView = (projectId: ProjectId): ProjectChatView => ({ projectId, items: [], working: null });

  return {
    list: async (workspaceId: WorkspaceId) => Project.array().parse(await (await call("GET", `/workspaces/${workspaceId}/projects`)).json()),
    // Throws with control's reason, e.g. the user's GitHub account cannot see the repo.
    create: async (workspaceId: WorkspaceId, repo: string) =>
      Project.parse(await (await call("POST", `/workspaces/${workspaceId}/projects`, { repo })).json()),
    // Saves the project's settings (YAML, the project file's keys) and resolves
    // with the project and its new config; throws with what is wrong in them.
    saveSettings: async (projectId: ProjectId, text: string) =>
      Project.parse(await (await call("PUT", `/projects/${projectId}/settings`, { text })).json()),
    // The coordinator's next turn runs on the request's model and effort; throws
    // when the user's plan does not offer them.
    setModel: async (projectId: ProjectId, request: SetBotModelRequest) =>
      Project.parse(await (await call("PUT", `/projects/${projectId}/model`, request)).json()),
    // The project's secrets, which control never sends the value of.
    secrets: async (projectId: ProjectId) => ProjectSecret.array().parse(await (await call("GET", `/projects/${projectId}/secrets`)).json()),
    setSecret: async (projectId: ProjectId, name: string, value: string) =>
      void (await call("PUT", `/projects/${projectId}/secrets/${encodeURIComponent(name)}`, { value })),
    clearSecret: async (projectId: ProjectId, name: string) => void (await call("DELETE", `/projects/${projectId}/secrets/${encodeURIComponent(name)}`)),
    // The workspace owner only. Its computer, ledger, chats and context go too.
    remove: async (projectId: ProjectId) => {
      await call("DELETE", `/projects/${projectId}`);
      chats.get(projectId)?.close();
      chats.delete(projectId);
    },
    tasks: async (projectId: ProjectId) => Task.array().parse(await (await call("GET", `/projects/${projectId}/tasks`)).json()),
    workers: async (projectId: ProjectId) => TaskWorker.array().parse(await (await call("GET", `/projects/${projectId}/workers`)).json()),
    // Approves or declines what control asked in the user's running turn with the
    // coordinator (a connector call). The card updates when the answer comes back on the chat socket.
    async answerChat(projectId: ProjectId, approvalId: ApprovalId, approved: boolean) {
      await call("POST", `/projects/${projectId}/approvals/${approvalId}`, { approved });
    },
    // The shared context's files, and one file's Markdown.
    context: async (projectId: ProjectId) => ContextFile.array().parse(await (await call("GET", `/projects/${projectId}/context`)).json()),
    contextFile: async (projectId: ProjectId, path: string) =>
      ContextFileText.parse(await (await call("GET", `/projects/${projectId}/context/file?path=${encodeURIComponent(path)}`)).json()),
    // The user drives a worker's screen from their open view of it until handBack; its tool calls
    // wait meanwhile. Any member may, one at a time.
    takeOver: async (projectId: ProjectId, workerId: TaskWorkerId) =>
      TaskWorker.parse(await (await call("POST", `/projects/${projectId}/workers/${workerId}/take-over`)).json()),
    handBack: async (projectId: ProjectId, workerId: TaskWorkerId) =>
      TaskWorker.parse(await (await call("POST", `/projects/${projectId}/workers/${workerId}/hand-back`)).json()),
    // Approves or declines a push or pull request of a worker the user asked for.
    // The card goes when control's next `workers` event comes.
    async answer(projectId: ProjectId, workerId: TaskWorkerId, approvalId: ApprovalId, approved: boolean) {
      await call("POST", `/projects/${projectId}/workers/${workerId}/approvals/${approvalId}`, { approved });
    },

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

    // Follows the worker's transcript, and stops following the one followed before:
    // the window shows one at a time. Repeat calls are harmless.
    openWorkerChat(projectId: ProjectId, workerId: TaskWorkerId) {
      if (watched?.view.workerId === workerId) return;
      watched?.close();
      const worker = { view: { workerId, items: [], working: null } satisfies WorkerChatView, close: () => {} };
      watched = worker;
      worker.close = followChat({
        controlUrl,
        session,
        retryMs,
        path: (after) => `/projects/${projectId}/workers/${workerId}/transcript?after=${after}`,
        onEvent: (event) => {
          worker.view = foldChat(worker.view, event);
          onWorkerChat?.(worker.view);
        },
      }).close;
    },

    // Stops following the worker's transcript: the window left it.
    closeWorkerChat(workerId: TaskWorkerId) {
      if (watched?.view.workerId !== workerId) return;
      watched.close();
      watched = null;
    },

    workerChatView: (workerId: TaskWorkerId): WorkerChatView =>
      watched?.view.workerId === workerId ? watched.view : { workerId, items: [], working: null },

    // Queues the message for the coordinator; throws while the user's last one is unanswered.
    send: async (projectId: ProjectId, text: string) =>
      SendMessageResponse.parse(await (await call("POST", `/projects/${projectId}/messages`, { text })).json()).turnId,

    // Call on sign-out.
    disconnect() {
      const open = [...chats.values()];
      chats.clear();
      for (const chat of open) chat.close();
      watched?.close();
      watched = null;
    },
  };
}
