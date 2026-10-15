import {
  AnswerApprovalRequest,
  ApprovalId,
  BotId,
  CreateBotRequest,
  defaultGitHubClientId,
  SendMessageRequest,
  SetBotModelRequest,
} from "@chiefbot/contracts";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuth, type SessionStore } from "./auth.ts";
import { createBots } from "./bots.ts";
import { createChats } from "./chat.ts";

// Env:
//   CHIEFBOT_CONTROL_URL      default http://127.0.0.1:7410
//   CHIEFBOT_GITHUB_URL       default https://github.com
//   CHIEFBOT_GITHUB_CLIENT_ID default Chartpilot's public OAuth App (device flow, no secret)
const controlUrl = process.env.CHIEFBOT_CONTROL_URL ?? "http://127.0.0.1:7410";
const githubUrl = process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com";
const clientId = process.env.CHIEFBOT_GITHUB_CLIENT_ID ?? defaultGitHubClientId;

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
});

const chats = createChats({
  controlUrl,
  session: sessionStore.load,
  onChange: (view) => window?.webContents.send("chat:state", view),
});

const auth = createAuth({
  controlUrl,
  deviceFlow: { githubUrl, clientId },
  store: sessionStore,
  onChange: (state) => {
    window?.webContents.send("auth:state", state);
    if (state.status === "signed-in") bots.connect();
    else {
      bots.disconnect();
      chats.disconnect();
    }
  },
});

ipcMain.handle("auth:get", () => auth.state());
ipcMain.handle("auth:sign-in", () => auth.signIn());
ipcMain.handle("auth:sign-out", () => auth.signOut());
ipcMain.handle("auth:disconnect-github", () => auth.disconnectGitHub());

// Renderer arguments are untrusted, so each is parsed before it reaches control.
ipcMain.handle("bots:get", () => bots.list());
ipcMain.handle("bots:create", (_event, name: unknown) => bots.create(CreateBotRequest.parse({ name }).name));
ipcMain.handle("bots:start", (_event, id: unknown) => bots.start(BotId.parse(id)));
ipcMain.handle("bots:stop", (_event, id: unknown) => bots.stop(BotId.parse(id)));
ipcMain.handle("bots:models", () => bots.models());
ipcMain.handle("bots:set-model", (_event, id: unknown, model: unknown) =>
  bots.setModel(BotId.parse(id), SetBotModelRequest.parse({ model }).model),
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
ipcMain.handle("chat:send", (_event, id: unknown, text: unknown) =>
  chats.send(BotId.parse(id), SendMessageRequest.parse({ text }).text),
);
ipcMain.handle("chat:answer", (_event, id: unknown, approvalId: unknown, approved: unknown) =>
  chats.answer(BotId.parse(id), ApprovalId.parse(approvalId), AnswerApprovalRequest.parse({ approved }).approved),
);
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
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Chiefbot",
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs") },
  });
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
