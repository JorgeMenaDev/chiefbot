import { contextBridge, ipcRenderer } from "electron";

// The renderer's only door to Electron main. It validates what comes back with
// the AuthState schema, so values here stay `unknown`.
const api = {
  auth: {
    get: (): Promise<unknown> => ipcRenderer.invoke("auth:get"),
    signIn: (): Promise<void> => ipcRenderer.invoke("auth:sign-in"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:sign-out"),
    onChange: (listener: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on("auth:state", handler);
      return () => void ipcRenderer.off("auth:state", handler);
    },
  },
};

export type ChiefbotApi = typeof api;

contextBridge.exposeInMainWorld("chiefbot", api);
