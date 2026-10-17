import { afterEach, expect, test } from "bun:test";
import { SignInResponse, type Bot, type User } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot } from "@chiefbot/worker/fake-copilot";
import { createBots } from "./bots.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

test("the bot list follows control live: a new bot goes starting → online, and delete removes it", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());

  const seen: Bot[][] = [];
  let changed = () => {};
  const bots = createBots({
    controlUrl: control.url,
    session: () => sessionToken,
    onChange: (list) => {
      seen.push(list);
      changed();
    },
  });
  stops.push(bots.disconnect);
  const until = (matches: (list: Bot[]) => boolean) =>
    new Promise<void>((resolve) => {
      changed = () => matches(bots.list()) && resolve();
      changed();
    });

  bots.connect();
  await until(() => seen.length > 0);
  const bot = await bots.create("Ada");
  await until((list) => list[0]?.status === "online");
  await bots.remove(bot.id, { deleteData: true });
  await until((list) => list.length === 0);

  expect(seen.map((list) => list.map(({ name, status }) => `${name}:${status}`))).toEqual(
    expect.arrayContaining([[], ["Ada:online"]]),
  );
  expect(computers.destroyed).toEqual([{ botId: bot.id, deleteData: true }]);
});

test("take over and hand back show in the live list", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  let changed = () => {};
  const bots = createBots({ controlUrl: control.url, session: () => sessionToken, onChange: () => changed() });
  stops.push(bots.disconnect);
  const until = (matches: (list: Bot[]) => boolean) =>
    new Promise<void>((resolve) => {
      changed = () => matches(bots.list()) && resolve();
      changed();
    });
  bots.connect();
  const bot = await bots.create("Ada");

  await bots.takeOver(bot.id);
  await until((list) => list[0]?.screenControl === "human");
  await bots.handBack(bot.id);
  await until((list) => list[0]?.screenControl === "agent");
});

test("create fails with control's reason when control refuses it", async () => {
  const github = startFakeGitHub();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", computers: fakeComputers().provider });
  stops.push(github.stop, control.stop);
  const bots = createBots({ controlUrl: control.url, session: () => "not-a-session", onChange: () => {} });

  await expect(bots.create("Ada")).rejects.toThrow("unauthorized");
});

test("a lost GitHub sign-in reaches the desktop live", async () => {
  const github = startFakeGitHub();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", computers: fakeComputers().provider });
  stops.push(github.stop, control.stop);
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ ...github.issueTokens(), accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  let userChanged = (_user: User) => {};
  let connected = () => {};
  const bots = createBots({
    controlUrl: control.url,
    session: () => sessionToken,
    onChange: () => connected(),
    onUser: (user) => userChanged(user),
  });
  stops.push(bots.disconnect);
  await new Promise<void>((resolve) => {
    connected = resolve;
    bots.connect();
  });

  const changed = new Promise<User>((resolve) => (userChanged = resolve));
  await fetch(`${control.url}/me/github`, { method: "DELETE", headers: { authorization: `Bearer ${sessionToken}` } });

  expect(await changed).toMatchObject({ login: "octo-user", needsGitHubSignIn: true });
});

test("the model picker reads the plan's models from control, and a refused pick fails with control's reason", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers({ copilot: fakeCopilot({ models: { list: [], modelPriceCategories: [{ id: "gpt-6-luna" }] } }) });
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      accessToken,
      accessTokenExpiresAt: Date.now() + 8 * 3600_000,
      refreshToken,
      refreshTokenExpiresAt: Date.now() + 180 * 86400_000,
    }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const bots = createBots({ controlUrl: control.url, session: () => sessionToken, onChange: () => {} });
  const bot = await bots.create("Ada");

  // The worker reports the plan's models just after it connects.
  let models = await bots.models();
  for (let tries = 0; tries < 50 && models.length < 2; tries++) {
    await Bun.sleep(10);
    models = await bots.models();
  }

  expect(models.map(({ id, lockedReason }) => [id, lockedReason])).toEqual([
    ["auto", null],
    ["gpt-6-luna", "Needs a paid Copilot plan"],
  ]);
  await expect(bots.setModel(bot.id, "gpt-6-luna")).rejects.toThrow("model_unavailable");
  expect((await bots.setModel(bot.id, "auto")).model).toBe("auto");
});
