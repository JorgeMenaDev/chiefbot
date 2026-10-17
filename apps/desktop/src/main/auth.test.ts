import { afterEach, expect, test } from "bun:test";
import type { AuthState } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { createAuth, type SessionStore } from "./auth.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup() {
  const github = startFakeGitHub({ pollErrors: ["authorization_pending"] });
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: fakeComputers().provider });
  stops.push(github.stop, control.stop);
  let saved: string | null = null;
  const store: SessionStore = {
    load: () => saved,
    save: (token) => void (saved = token),
    clear: () => void (saved = null),
  };
  const launch = () => {
    const states: AuthState[] = [];
    const auth = createAuth({
      controlUrl: control.url,
      deviceFlow: { githubUrl: github.url, clientId: "test-client", sleep: async () => {} },
      store,
      onChange: (state) => states.push(state),
    });
    return { auth, states };
  };
  return { control, store, launch };
}

test("sign-in shows the code, then the login and Copilot plan; sign-out clears them", async () => {
  const { control, store, launch } = setup();
  const { auth, states } = launch();

  await auth.signIn();
  const session = store.load();
  await auth.signOut();

  expect(states).toEqual([
    { status: "waiting-for-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
    {
      status: "signed-in",
      user: {
        id: expect.any(String),
        login: "octo-user",
        copilotPlan: { plan: "individual", sku: "free_limited_copilot" },
        needsGitHubSignIn: false,
      },
    },
    { status: "signed-out" },
  ]);
  expect(store.load()).toBeNull();
  const me = await fetch(`${control.url}/me`, { headers: { authorization: `Bearer ${session}` } });
  expect(me.status).toBe(401);
});

test("the next launch restores the signed-in user from the saved session", async () => {
  const { launch } = setup();
  await launch().auth.signIn();

  const { auth } = launch();
  await auth.restore();

  expect(auth.state()).toMatchObject({ status: "signed-in", user: { login: "octo-user" } });
});

test("disconnecting GitHub keeps the session and asks for sign-in; signing in again restores GitHub", async () => {
  const { launch } = setup();
  const { auth, states } = launch();
  await auth.signIn();

  await auth.disconnectGitHub();
  const disconnected = auth.state();
  await auth.signIn();

  expect(disconnected).toMatchObject({ status: "signed-in", user: { needsGitHubSignIn: true } });
  expect(states.at(-1)).toMatchObject({ status: "signed-in", user: { needsGitHubSignIn: false } });
});
