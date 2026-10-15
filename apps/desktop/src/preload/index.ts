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
    onChange: (listener: (state: unknown) => void) => subscribe("auth:state", listener),
  },
  bots: {
    get: (): Promise<unknown> => ipcRenderer.invoke("bots:get"),
    create: (name: string): Promise<unknown> => ipcRenderer.invoke("bots:create", name),
    start: (id: string): Promise<void> => ipcRenderer.invoke("bots:start", id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke("bots:stop", id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("bots:delete", id),
    onChange: (listener: (bots: unknown) => void) => subscribe("bots:state", listener),
  },
  chat: {
    open: (botId: string): Promise<unknown> => ipcRenderer.invoke("chat:open", botId),
    send: (botId: string, text: string): Promise<unknown> => ipcRenderer.invoke("chat:send", botId, text),
    onChange: (listener: (view: unknown) => void) => subscribe("chat:state", listener),
  },
};

export type ChiefbotApi = typeof api;

contextBridge.exposeInMainWorld("chiefbot", api);
