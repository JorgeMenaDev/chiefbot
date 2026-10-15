import { SignInResponse, User, type AuthState, type SessionToken } from "@chiefbot/contracts";
import { runDeviceFlow, type DeviceFlowOptions } from "./deviceFlow.ts";

// Where the desktop keeps its control session between launches.
export type SessionStore = {
  load(): string | null;
  save(token: SessionToken): void;
  clear(): void;
};

export type AuthOptions = {
  controlUrl: string;
  deviceFlow: Omit<DeviceFlowOptions, "onCode">;
  store: SessionStore;
  onChange: (state: AuthState) => void;
};

// The desktop's sign-in state, owned by Electron main. GitHub tokens pass through
// once on their way to control; the desktop keeps only control's session token.
export function createAuth({ controlUrl, deviceFlow, store, onChange }: AuthOptions) {
  let state: AuthState = { status: "signed-out" };
  const set = (next: AuthState) => {
    state = next;
    onChange(next);
  };

  return {
    state: () => state,

    // On launch: show the saved session's user, or stay signed out if control no longer knows it.
    async restore() {
      const token = store.load();
      if (!token) return;
      const res = await fetch(`${controlUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) return store.clear();
      if (!res.ok) return set({ status: "error", message: `Control answered ${res.status}` });
      set({ status: "signed-in", user: User.parse(await res.json()) });
    },

    async signIn() {
      try {
        const tokens = await runDeviceFlow({
          ...deviceFlow,
          onCode: (code) => set({ status: "waiting-for-code", ...code }),
        });
        const res = await fetch(`${controlUrl}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(tokens),
        });
        if (!res.ok) throw new Error(`Control refused the sign-in (${res.status})`);
        const { sessionToken, user } = SignInResponse.parse(await res.json());
        store.save(sessionToken);
        set({ status: "signed-in", user });
      } catch (error) {
        set({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },

    // The user as control now sees them; ignored unless signed in.
    userChanged(user: User) {
      if (state.status === "signed-in") set({ status: "signed-in", user });
    },

    // Makes control forget the user's GitHub sign-in, so their bots stop getting
    // tokens. The session stays, and the window asks to sign in again.
    async disconnectGitHub() {
      const headers = { authorization: `Bearer ${store.load() ?? ""}` };
      const res = await fetch(`${controlUrl}/me/github`, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`Control refused (${res.status})`);
      const me = await fetch(`${controlUrl}/me`, { headers });
      if (me.ok) set({ status: "signed-in", user: User.parse(await me.json()) });
    },

    async signOut() {
      const token = store.load();
      store.clear();
      set({ status: "signed-out" });
      // Signed out locally even if control is unreachable; its session row then lingers.
      if (token) {
        await fetch(`${controlUrl}/sessions/current`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    },
  };
}
