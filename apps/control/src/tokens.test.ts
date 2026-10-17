import { afterEach, expect, test } from "bun:test";
import { BrokeredGitHubToken, BrokerRefusal, User, type BotId } from "@chiefbot/contracts";
import { cleanUp, hour, startTestControl } from "./testControl.ts";

afterEach(cleanUp);

// Control with a fake GitHub, signed in with a token pair whose access token has
// `accessTokenLeftMs` to live, and helpers to act as the user and as a bot's worker.
async function setup(lifetimes: { accessTokenLeftMs?: number; refreshTokenLeftMs?: number } = {}) {
  const control = await startTestControl(lifetimes);
  const { url, botToken, user } = control;
  const createBot = async (name: string) => (await user.createBot(name)).id;
  // What the bot's worker gets from the broker, as its worker would ask.
  const tokenFor = (botId: BotId) => fetch(`${url}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${botToken(botId)}` } });
  // Sends one message to a bot once it is online, and resolves with the turn's error, if any, once it is done.
  const runTurn = async (botId: BotId) => {
    await user.watchBots().until((bots) => bots.some((bot) => bot.id === botId && bot.status === "online"));
    const chat = user.watchChat(botId);
    await user.send(botId, "hello");
    const events = await chat.until((events) => events.some(({ event }) => event.type === "done"));
    return events.flatMap(({ event }) => (event.type === "error" ? [event.message] : []));
  };
  return { ...control, ...user, createBot, tokenFor, runTurn };
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
  const { github, url, api, createBot, tokenFor } = await setup();
  const ada = await createBot("Ada");

  expect((await api("DELETE", "/me/github")).status).toBe(204);
  const whileDisconnected = await tokenFor(ada);
  const fresh = github.issueTokens();
  await fetch(`${url}/sessions`, {
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
