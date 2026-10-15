import { app, BrowserWindow, ipcMain, shell } from "electron";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuth, type SessionStore } from "./auth.ts";

// Env:
//   CHIEFBOT_CONTROL_URL      default http://127.0.0.1:7410
//   CHIEFBOT_GITHUB_URL       default https://github.com
//   CHIEFBOT_GITHUB_CLIENT_ID default Chartpilot's public OAuth App (device flow, no secret)
const controlUrl = process.env.CHIEFBOT_CONTROL_URL ?? "http://127.0.0.1:7410";
const githubUrl = process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com";
const clientId = process.env.CHIEFBOT_GITHUB_CLIENT_ID ?? "Ov23liONZsgOtJmCUaGB";

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

const auth = createAuth({
  controlUrl,
  deviceFlow: { githubUrl, clientId },
  store: fileSessionStore(join(app.getPath("userData"), "session")),
  onChange: (state) => window?.webContents.send("auth:state", state),
});

ipcMain.handle("auth:get", () => auth.state());
ipcMain.handle("auth:sign-in", () => auth.signIn());
ipcMain.handle("auth:sign-out", () => auth.signOut());

app.whenReady().then(async () => {
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
