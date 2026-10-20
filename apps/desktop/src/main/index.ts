/// <reference types="electron-vite/node" />
import {
  AnswerApprovalRequest,
  ApprovalId,
  AttachmentId,
  BotId,
  ConnectionName,
  ConnectRequest,
  ConnectorApprovalRequest,
  ConnectorInput,
  ConnectorName,
  ConnectorTokenRequest,
  CreateBotRequest,
  CreateProjectRequest,
  CreateWorkspaceRequest,
  EnvironmentInput,
  HandoffId,
  InviteId,
  InviteRequest,
  ProjectId,
  ReplyToHandoffRequest,
  RoutineId,
  RoutineInput,
  SendBotMessageRequest,
  SendMessageRequest,
  ServiceId,
  ServiceInput,
  SetCopilotModeRequest,
  SetBotAccessRequest,
  SetBotModelRequest,
  SubscriptionId,
  SubscriptionInput,
  TaskWorkerId,
  Theme,
  UserId,
  WorkspaceId,
} from "@chiefbot/contracts";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from "electron";
import { configuredSignIn, setupNeeded } from "@chiefbot/setup";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAuth, type SessionStore } from "./auth.ts";
import { createBots } from "./bots.ts";
import { createChats } from "./chat.ts";
import { createConnections } from "./connections.ts";
import { createConnectors } from "./connectors.ts";
import { createProjects } from "./projects.ts";
import { createRoutines } from "./routines.ts";
import { createWorkspaces } from "./workspaces.ts";
// The app icon (docs/brand). `?asset` makes electron-vite copy it next to the build and import its path.
import icon from "../../../../docs/brand/icon-512.png?asset";

// Env:
//   CHIEFBOT_CONTROL_URL      default http://127.0.0.1:7410
//   CHIEFBOT_GITHUB_URL       default https://github.com
//   CHIEFBOT_GITHUB_CLIENT_ID default: the sign-in app `bun run setup` recorded (~/.chiefbot/config.json)
//   CHIEFBOT_HOME             default ~/.chiefbot
const controlUrl = process.env.CHIEFBOT_CONTROL_URL ?? "http://127.0.0.1:7410";
const githubUrl = process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com";
const signIn = configuredSignIn(process.env, homedir());
if (signIn === null) {
  console.error(setupNeeded);
  dialog.showErrorBox("Chiefbot is not set up", setupNeeded);
  process.exit(1);
}

// The control session token, kept in the app's user-data folder.
function fileSessionStore(path: string): SessionStore {
  return {
    load: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    save: (token) => writeFileSync(path, token, { mode: 0o600 }),
    clear: () => rmSync(path, { force: true }),
  };
}

let window: BrowserWindow | null = null;
const sessionStore = fileSessionStore(join(app.getPath("userData"), "session"));

const bots = createBots({
  controlUrl,
  session: sessionStore.load,
  onChange: (list) => window?.webContents.send("bots:state", list),
  onUser: (user) => auth.userChanged(user),
  onTasks: (projectId, tasks) => window?.webContents.send("projects:tasks", { projectId, tasks }),
  onWorkers: (projectId, workers) => window?.webContents.send("projects:workers", { projectId, workers }),
});

const chats = createChats({
  controlUrl,
  session: sessionStore.load,
  onChange: (view) => window?.webContents.send("chat:state", view),
});

const routines = createRoutines({ controlUrl, session: sessionStore.load });

const workspaces = createWorkspaces({ controlUrl, session: sessionStore.load });

const connectors = createConnectors({ controlUrl, session: sessionStore.load });

const connections = createConnections({ controlUrl, session: sessionStore.load });

const projects = createProjects({
  controlUrl,
  session: sessionStore.load,
  onChat: (view) => window?.webContents.send("projects:chat", view),
});

const auth = createAuth({
  controlUrl,
  deviceFlow: { githubUrl, ...signIn },
  store: sessionStore,
  onChange: (state) => {
    window?.webContents.send("auth:state", state);
    if (state.status === "signed-in") bots.connect();
    else {
      bots.disconnect();
      chats.disconnect();
      projects.disconnect();
    }
  },
});

// The Theme setting (renderer lib/theme.ts), as T3 Code's desktop sets it: the native
// theme drives scrollbars, menus, dialogs and the OS media query; the window's
// background follows, so a resize never shows the other theme's colour.
ipcMain.handle("theme:set", (_event, theme: unknown) => {
  nativeTheme.themeSource = Theme.parse(theme);
});
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#fcfcfc");
nativeTheme.on("updated", () => window?.setBackgroundColor(windowBackground()));

ipcMain.handle("auth:get", () => auth.state());
ipcMain.handle("auth:sign-in", () => auth.signIn());
ipcMain.handle("auth:sign-out", () => auth.signOut());
ipcMain.handle("auth:disconnect-github", () => auth.disconnectGitHub());

// Renderer arguments are untrusted, so each is parsed before it reaches control.
ipcMain.handle("bots:get", () => bots.list());
ipcMain.handle("bots:create", (_event, request: unknown) => bots.create(CreateBotRequest.parse(request)));
ipcMain.handle("bots:start", (_event, id: unknown) => bots.start(BotId.parse(id)));
ipcMain.handle("bots:stop", (_event, id: unknown) => bots.stop(BotId.parse(id)));
ipcMain.handle("bots:models", () => bots.models());
ipcMain.handle("bots:set-model", (_event, id: unknown, request: unknown) => bots.setModel(BotId.parse(id), SetBotModelRequest.parse(request)));
ipcMain.handle("bots:set-access", (_event, id: unknown, access: unknown) =>
  bots.setAccess(BotId.parse(id), SetBotAccessRequest.parse({ access }).access),
);
ipcMain.handle("bots:take-over", (_event, id: unknown) => bots.takeOver(BotId.parse(id)));
ipcMain.handle("bots:hand-back", (_event, id: unknown) => bots.handBack(BotId.parse(id)));
// noVNC in the renderer opens this WebSocket; main signs it below.
const controlSockets = controlUrl.replace(/^http/, "ws");
ipcMain.handle("bots:screen-url", (_event, id: unknown) => `${controlSockets}/bots/${BotId.parse(id)}/screen`);
// Opening a chat answers with what main has so far; the rest follows on chat:state.
ipcMain.handle("chat:open", (_event, id: unknown) => {
  const botId = BotId.parse(id);
  chats.open(botId);
  return chats.view(botId);
});
ipcMain.handle("chat:send", (_event, id: unknown, text: unknown, attachments: unknown) => {
  const request = SendBotMessageRequest.parse({ text, attachments });
  return chats.send(BotId.parse(id), request.text, request.attachments);
});
ipcMain.handle("chat:attachment", (_event, id: unknown, attachmentId: unknown) => chats.attachment(BotId.parse(id), AttachmentId.parse(attachmentId)));
ipcMain.handle("chat:answer", (_event, id: unknown, approvalId: unknown, approved: unknown) =>
  chats.answer(BotId.parse(id), ApprovalId.parse(approvalId), AnswerApprovalRequest.parse({ approved }).approved),
);
ipcMain.handle("chat:reply-to-handoff", (_event, id: unknown, handoffId: unknown, reply: unknown) =>
  chats.replyToHandoff(BotId.parse(id), HandoffId.parse(handoffId), ReplyToHandoffRequest.parse(reply)),
);
ipcMain.handle("routines:list", (_event, botId: unknown) => routines.list(BotId.parse(botId)));
ipcMain.handle("routines:create", (_event, botId: unknown, input: unknown) =>
  routines.create(BotId.parse(botId), RoutineInput.parse(input)),
);
ipcMain.handle("routines:update", (_event, botId: unknown, routineId: unknown, input: unknown) =>
  routines.update(BotId.parse(botId), RoutineId.parse(routineId), RoutineInput.parse(input)),
);
ipcMain.handle("routines:delete", (_event, botId: unknown, routineId: unknown) =>
  routines.remove(BotId.parse(botId), RoutineId.parse(routineId)),
);
ipcMain.handle("workspaces:list", () => workspaces.list());
ipcMain.handle("workspaces:create", (_event, name: unknown) => workspaces.create(CreateWorkspaceRequest.parse({ name }).name));
ipcMain.handle("workspaces:detail", (_event, id: unknown) => workspaces.detail(WorkspaceId.parse(id)));
ipcMain.handle("workspaces:invite", (_event, id: unknown, login: unknown) =>
  workspaces.invite(WorkspaceId.parse(id), InviteRequest.parse({ login }).login),
);
ipcMain.handle("workspaces:revoke-invite", (_event, id: unknown, inviteId: unknown) =>
  workspaces.revokeInvite(WorkspaceId.parse(id), InviteId.parse(inviteId)),
);
ipcMain.handle("workspaces:remove-member", (_event, id: unknown, userId: unknown) =>
  workspaces.removeMember(WorkspaceId.parse(id), UserId.parse(userId)),
);
ipcMain.handle("workspaces:set-copilot-mode", (_event, id: unknown, mode: unknown) =>
  workspaces.setCopilotMode(WorkspaceId.parse(id), SetCopilotModeRequest.parse({ mode }).mode),
);
ipcMain.handle("workspaces:invites", () => workspaces.invites());
ipcMain.handle("workspaces:accept", (_event, inviteId: unknown) => workspaces.accept(InviteId.parse(inviteId)));
ipcMain.handle("projects:list", (_event, workspaceId: unknown) => projects.list(WorkspaceId.parse(workspaceId)));
ipcMain.handle("projects:create", (_event, workspaceId: unknown, repo: unknown) =>
  projects.create(WorkspaceId.parse(workspaceId), CreateProjectRequest.parse({ repo }).repo),
);
ipcMain.handle("projects:tasks", (_event, id: unknown) => projects.tasks(ProjectId.parse(id)));
ipcMain.handle("projects:workers", (_event, id: unknown) => projects.workers(ProjectId.parse(id)));
ipcMain.handle("projects:answer-chat", (_event, id: unknown, approvalId: unknown, approved: unknown) =>
  projects.answerChat(ProjectId.parse(id), ApprovalId.parse(approvalId), AnswerApprovalRequest.parse({ approved }).approved),
);
ipcMain.handle("projects:answer", (_event, id: unknown, workerId: unknown, approvalId: unknown, approved: unknown) =>
  projects.answer(ProjectId.parse(id), TaskWorkerId.parse(workerId), ApprovalId.parse(approvalId), AnswerApprovalRequest.parse({ approved }).approved),
);
// Asks first. Resolves true once the project is deleted.
ipcMain.handle("projects:delete", async (_event, id: unknown, name: unknown) => {
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    message: `Delete the project ${String(name)}?`,
    detail: "Its coordinator's and workers' computers, task ledger, chats and shared context are deleted. The repo is not touched.",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;
  await projects.remove(ProjectId.parse(id));
  return true;
});
// Opening a project's chat answers with what main has so far; the rest follows on projects:chat.
ipcMain.handle("projects:open-chat", (_event, id: unknown) => {
  const projectId = ProjectId.parse(id);
  projects.openChat(projectId);
  return projects.chatView(projectId);
});
ipcMain.handle("projects:send", (_event, id: unknown, text: unknown) =>
  projects.send(ProjectId.parse(id), SendMessageRequest.parse({ text }).text),
);
ipcMain.handle("projects:subscriptions", (_event, id: unknown) => projects.subscriptions(ProjectId.parse(id)));
ipcMain.handle("projects:subscribe", (_event, id: unknown, input: unknown) =>
  projects.subscribe(ProjectId.parse(id), SubscriptionInput.parse(input)),
);
ipcMain.handle("projects:unsubscribe", (_event, id: unknown, subscriptionId: unknown) =>
  projects.unsubscribe(ProjectId.parse(id), SubscriptionId.parse(subscriptionId)),
);
ipcMain.handle("connections:list", () => connections.list());
ipcMain.handle("connections:connect", (_event, name: unknown, fields: unknown) =>
  connections.connect(ConnectionName.parse(name), ConnectRequest.parse({ fields }).fields),
);
ipcMain.handle("connections:disconnect", (_event, name: unknown) => connections.disconnect(ConnectionName.parse(name)));
ipcMain.handle("connections:calls", (_event, botId: unknown) => connections.calls(BotId.parse(botId)));
ipcMain.handle("health:get", () => connections.health());
ipcMain.handle("health:refresh", () => connections.refreshHealth());
ipcMain.handle("health:check-services", () => connections.checkServices());
ipcMain.handle("health:check-service", (_event, id: unknown) => connections.checkService(ServiceId.parse(id)));
ipcMain.handle("health:add-service", (_event, input: unknown) => connections.addService(ServiceInput.parse(input)));
ipcMain.handle("health:update-service", (_event, id: unknown, input: unknown) => connections.updateService(ServiceId.parse(id), ServiceInput.parse(input)));
ipcMain.handle("health:test-environment", (_event, input: unknown) => connections.testEnvironment(EnvironmentInput.parse(input)));
// Asks first: its environments' secrets and checks go too. Resolves true once removed.
ipcMain.handle("health:remove-service", async (_event, id: unknown, name: unknown) => {
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    message: `Remove the service ${String(name)}?`,
    detail: "Its environments, their saved secrets and their checks are deleted. The service itself is not touched.",
    buttons: ["Remove", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;
  await connections.removeService(ServiceId.parse(id));
  return true;
});
ipcMain.handle("connectors:list", (_event, workspaceId: unknown) => connectors.list(WorkspaceId.parse(workspaceId)));
ipcMain.handle("connectors:define", (_event, workspaceId: unknown, input: unknown) =>
  connectors.define(WorkspaceId.parse(workspaceId), ConnectorInput.parse(input)),
);
ipcMain.handle("connectors:set-writes", (_event, workspaceId: unknown, name: unknown, allowed: unknown) =>
  connectors.setWritesWithoutApproval(
    WorkspaceId.parse(workspaceId),
    ConnectorName.parse(name),
    ConnectorApprovalRequest.parse({ writesWithoutApproval: allowed }).writesWithoutApproval,
  ),
);
ipcMain.handle("connectors:set-secret", (_event, workspaceId: unknown, name: unknown, token: unknown) =>
  connectors.setSecret(WorkspaceId.parse(workspaceId), ConnectorName.parse(name), ConnectorTokenRequest.parse({ token }).token),
);
ipcMain.handle("connectors:set-token", (_event, workspaceId: unknown, name: unknown, token: unknown) =>
  connectors.setToken(WorkspaceId.parse(workspaceId), ConnectorName.parse(name), ConnectorTokenRequest.parse({ token }).token),
);
// An OAuth sign-in opens in the default browser; control finishes it on its callback.
ipcMain.handle("connectors:connect", async (_event, workspaceId: unknown, name: unknown) => {
  const start = await connectors.connect(WorkspaceId.parse(workspaceId), ConnectorName.parse(name));
  if (start.kind === "oauth") await shell.openExternal(start.authorizeUrl);
  return start;
});
ipcMain.handle("connectors:checklist", (_event, workspaceId: unknown) => connectors.checklist(WorkspaceId.parse(workspaceId)));
ipcMain.handle("connectors:calls", (_event, projectId: unknown) => connectors.calls(ProjectId.parse(projectId)));
// Asks first: every member's connection to it goes too. Resolves true once deleted.
ipcMain.handle("connectors:delete", async (_event, workspaceId: unknown, name: unknown) => {
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    message: `Delete the connector ${ConnectorName.parse(name)}?`,
    detail: "Its workspace secret and every member's connection to it are deleted. Projects that declare it lose it.",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;
  await connectors.remove(WorkspaceId.parse(workspaceId), ConnectorName.parse(name));
  return true;
});
// Asks first. The bot's files (its volume) are kept unless the box is ticked.
ipcMain.handle("bots:delete", async (_event, id: unknown) => {
  const bot = bots.list().find((candidate) => candidate.id === BotId.parse(id));
  if (!bot || !window) return;
  const { response, checkboxChecked } = await dialog.showMessageBox(window, {
    type: "warning",
    message: `Delete ${bot.name}?`,
    detail: "Its computer is removed.",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: "Also delete its files (home and workspace)",
    checkboxChecked: false,
  });
  if (response === 0) await bots.remove(bot.id, { deleteData: checkboxChecked });
});

app.whenReady().then(async () => {
  // Adds the control session to the screen WebSocket's handshake, so the
  // renderer never holds it. Control checks that the session owns the bot.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${controlSockets}/bots/*/screen`] },
    ({ requestHeaders }, callback) => {
      const token = sessionStore.load();
      callback({ requestHeaders: token ? { ...requestHeaders, Authorization: `Bearer ${token}` } : requestHeaders });
    },
  );
  // Unpackaged, macOS shows Electron's icon in the Dock; this shows ours.
  app.dock?.setIcon(icon);
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Chiefbot",
    icon, // the window and taskbar icon on Windows and Linux
    // T3 Code's chrome on macOS: no title bar, the window buttons inset in the sidebar's top bar,
    // centred in its 52px height (buttons are 12px) beside the sidebar toggle.
    ...(process.platform === "darwin" ? ({ titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 20 } } as const) : {}),
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs") },
    // Shown once the page has painted in the saved theme, so it never flashes the other one.
    show: false,
    backgroundColor: windowBackground(),
  });
  window.once("ready-to-show", () => window?.show());
  // Links (the GitHub device page) open in the default browser, never in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  await auth.restore();
});

app.on("window-all-closed", () => app.quit());
