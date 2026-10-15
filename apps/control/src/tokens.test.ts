import { afterEach, expect, test } from "bun:test";
import { Bot, BrokeredGitHubToken, BrokerRefusal, ChatEvent, ClientEvent, SignInResponse, User, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { startControl } from "./control.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

const hour = 3600_000;

// Control with a fake GitHub, signed in with a token pair whose access token has
// `accessTokenLeftMs` to live, and helpers to act as the user and as a bot's worker.
async function setup({ accessTokenLeftMs = 8 * hour, refreshTokenLeftMs = 180 * 24 * hour } = {}) {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const tokens = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      ...tokens,
      accessTokenExpiresAt: Date.now() + accessTokenLeftMs,
      refreshTokenExpiresAt: Date.now() + refreshTokenLeftMs,
    }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const createBot = async (name: string) => Bot.parse(await (await api("POST", "/bots", { name })).json()).id;
  // What the bot's worker gets from the broker, as its worker would ask.
  const tokenFor = (botId: BotId) =>
    fetch(`${control.url}/worker/${botId}/github-token`, {
      headers: { authorization: `Bearer ${computers.computers.get(botId)?.spec.env.CHIEFBOT_BOT_TOKEN}` },
    });
  // Resolves with the first message on a control WebSocket that `matches` accepts.
  const firstOn = <T>(path: string, matches: (message: unknown) => T | undefined) =>
    new Promise<T>((resolve) => {
      const socket = new WebSocket(`${control.url.replace("http", "ws")}${path}`, { headers: auth });
      stops.push(() => socket.close());
      socket.onmessage = (event) => {
        const found = matches(JSON.parse(String(event.data)));
        if (found !== undefined) resolve(found);
      };
    });
  // Sends one message to a bot once it is online, and resolves with the turn's error, if any, once it is done.
  const runTurn = async (botId: BotId) => {
    await firstOn("/events", (message) => {
      const event = ClientEvent.parse(message);
      return event.type === "bots" && event.bots.some((bot) => bot.id === botId && bot.status === "online") ? true : undefined;
    });
    const errors: string[] = [];
    const done = firstOn(`/bots/${botId}/chat`, (message) => {
      const { event } = ChatEvent.parse(message);
      if (event.type === "error") errors.push(event.message);
      return event.type === "done" ? errors : undefined;
    });
    await api("POST", `/bots/${botId}/messages`, { text: "hello" });
    return done;
  };
  return { github, computers, control, tokens, api, createBot, tokenFor, runTurn };
}

test("concurrent token requests for one user trigger exactly one refresh, then the new token is served", async () => {
  const { github, createBot, tokenFor, tokens } = await setup({ accessTokenLeftMs: 30 * 60_000 });
  const ada = await createBot("Ada");
  const grace = await createBot("Grace");

  const responses = await Promise.all([ada, grace].flatMap((botId) => Array.from({ length: 5 }, () => tokenFor(botId))));
  const served = await Promise.all(responses.map(async (res) => BrokeredGitHubToken.parse(await res.json())));
  const again = BrokeredGitHubToken.parse(await (await tokenFor(ada)).json());

  expect(github.refreshRequests()).toEqual([
    { client_id: expect.any(String), grant_type: "refresh_token", refresh_token: tokens.refreshToken },
  ]);
  expect(new Set(served.map(({ accessToken }) => accessToken))).toEqual(new Set([again.accessToken]));
  expect(again.accessToken).not.toBe(tokens.accessToken);
  expect(again.expiresAt).toBeGreaterThan(Date.now() + 7 * hour);
});

test("when GitHub refuses the refresh token, every bot of the user gets reauth_needed and /me asks for sign-in", async () => {
  const { github, api, createBot, tokenFor, tokens } = await setup({ accessTokenLeftMs: 30 * 60_000 });
  const ada = await createBot("Ada");
  const grace = await createBot("Grace");
  github.revoke(tokens.refreshToken);

  const first = await tokenFor(ada);
  const second = await tokenFor(grace);
  const me = User.parse(await (await api("GET", "/me")).json());

  expect(first.status).toBe(403);
  expect(BrokerRefusal.parse(await first.json())).toEqual({ error: "reauth_needed" });
  expect(second.status).toBe(403);
  expect(github.refreshRequests()).toHaveLength(1);
  expect(me.needsGitHubSignIn).toBe(true);
});

test("an expired refresh token needs sign-in without asking GitHub", async () => {
  const { github, createBot, tokenFor } = await setup({ accessTokenLeftMs: 30 * 60_000, refreshTokenLeftMs: -1000 });

  const res = await tokenFor(await createBot("Ada"));

  expect(res.status).toBe(403);
  expect(github.refreshRequests()).toEqual([]);
});

test("disconnecting GitHub stops the user's bots getting tokens until they sign in again", async () => {
  const { github, control, api, createBot, tokenFor } = await setup();
  const ada = await createBot("Ada");

  expect((await api("DELETE", "/me/github")).status).toBe(204);
  const whileDisconnected = await tokenFor(ada);
  const fresh = github.issueTokens();
  await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ ...fresh, accessTokenExpiresAt: Date.now() + 8 * hour, refreshTokenExpiresAt: Date.now() + 180 * 24 * hour }),
  });
  const afterSignIn = await tokenFor(ada);

  expect(whileDisconnected.status).toBe(403);
  expect(BrokeredGitHubToken.parse(await afterSignIn.json()).accessToken).toBe(fresh.accessToken);
});

test("a bot whose owner must sign in again answers its turn with an error saying so", async () => {
  const { api, createBot, runTurn } = await setup();
  const ada = await createBot("Ada");
  await api("DELETE", "/me/github");

  const errors = await runTurn(ada);

  expect(errors).toEqual([expect.stringMatching(/sign in again/i)]);
});

test("a bot's computer and its Copilot session get the access token, never the refresh token", async () => {
  const { computers, createBot, tokenFor, runTurn, tokens } = await setup();
  const ada = await createBot("Ada");

  const errors = await runTurn(ada);
  const brokered = await (await tokenFor(ada)).text();

  expect(errors).toEqual([]);
  expect(computers.copilot.tokens).toEqual([tokens.accessToken]);
  expect(brokered).not.toContain(tokens.refreshToken);
  expect(JSON.stringify(computers.computers.get(ada)?.spec)).not.toContain(tokens.refreshToken);
});
